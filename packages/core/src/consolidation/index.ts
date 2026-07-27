/**
 * Memory consolidation.
 *
 * Left alone, an agent's memory store degrades in a predictable way: the same
 * fact gets written a dozen times in slightly different words, stale working
 * memory piles up, and retrieval quality falls because the top-k fills with
 * near-duplicates. Consolidation is the background process that fights this,
 * loosely modelled on the role sleep plays in human memory.
 *
 * Five passes, each independently toggleable:
 *
 *  1. **Deduplicate** — exact (content hash) and near-duplicate (cosine)
 *     matches are merged; survivors inherit the union of tags and the maximum
 *     importance, and losers are marked `superseded` rather than deleted so the
 *     history stays auditable.
 *  2. **Summarize** — groups of related old memories collapse into one summary
 *     memory that supersedes them.
 *  3. **Archive** — stale memories move out of the active set without loss.
 *  4. **Expire** — memories past their TTL are purged per their retention policy.
 *  5. **Cluster** — related memories are grouped and labelled, which powers the
 *     dashboard's topic view and feeds future summarisation.
 */
import type { Memory, MemoryType } from '../types.js';
import type { StorageAdapter } from '../storage/types.js';
import type { Summarizer } from './summarizer.js';
import { ExtractiveSummarizer } from './summarizer.js';
import type { RetentionPolicy } from '../retention.js';
import { isStale } from '../retention.js';
import { cosineSimilarity, centroid } from '../util/vector.js';
import { analyze, estimateTokens } from '../util/text.js';
import { contentHash } from '../util/hash.js';
import { generateId } from '../util/id.js';
import type { Logger } from '../logger.js';
import { noopLogger } from '../logger.js';

export * from './summarizer.js';

export interface ConsolidationOptions {
  /** Cosine similarity at or above which two memories are treated as duplicates. */
  duplicateThreshold?: number;
  /** Memories older than this are summarisation candidates. */
  summarizeOlderThanDays?: number;
  /** Minimum group size before summarisation is worth doing. */
  minGroupSize?: number;
  /** Token ceiling for a generated summary. */
  summaryMaxTokens?: number;
  /** Cap on memories examined in one run, bounding runtime. */
  maxMemories?: number;
  /**
   * Cosine similarity above which two memories join the same topic cluster.
   * Defaults to a fraction of the embedding provider's calibrated
   * full-confidence similarity, since that scale differs by an order of
   * magnitude between neural and feature-hashing embedders.
   */
  clusterThreshold?: number;
  /** Only consolidate these types. Defaults to every type whose policy allows it. */
  types?: MemoryType[];
  /** Report what would change without writing anything. */
  dryRun?: boolean;

  deduplicate?: boolean;
  summarize?: boolean;
  archive?: boolean;
  expire?: boolean;
  cluster?: boolean;
}

export interface MemoryCluster {
  id: string;
  label: string;
  memoryIds: string[];
  centroid: number[] | null;
  /** Mean pairwise similarity to the centroid — a cluster tightness measure. */
  coherence: number;
  keywords: string[];
}

export interface ConsolidationReport {
  scanned: number;
  duplicatesMerged: number;
  memoriesSummarized: number;
  summariesCreated: number;
  archived: number;
  expired: number;
  clusters: MemoryCluster[];
  tokensReclaimed: number;
  tookMs: number;
  dryRun: boolean;
  /** Non-fatal problems; a failing pass never aborts the whole run. */
  warnings: string[];
}

export class Consolidator {
  private readonly summarizer: Summarizer;
  private readonly logger: Logger;

  /** Cosine scale of the embedder in use; drives the default cluster threshold. */
  private readonly fullConfidenceSimilarity: number;

  constructor(
    private readonly storage: StorageAdapter,
    private readonly policies: Record<MemoryType, RetentionPolicy>,
    options: { summarizer?: Summarizer; logger?: Logger; fullConfidenceSimilarity?: number } = {},
  ) {
    this.summarizer = options.summarizer ?? new ExtractiveSummarizer();
    this.logger = options.logger ?? noopLogger;
    this.fullConfidenceSimilarity = options.fullConfidenceSimilarity ?? 0.35;
  }

  async run(namespace: string, options: ConsolidationOptions = {}): Promise<ConsolidationReport> {
    const startedAt = Date.now();
    const {
      duplicateThreshold = 0.94,
      summarizeOlderThanDays = 30,
      minGroupSize = 3,
      summaryMaxTokens = 256,
      maxMemories = 5000,
      dryRun = false,
      deduplicate = true,
      summarize = true,
      archive = true,
      expire = true,
      cluster = true,
    } = options;

    const report: ConsolidationReport = {
      scanned: 0,
      duplicatesMerged: 0,
      memoriesSummarized: 0,
      summariesCreated: 0,
      archived: 0,
      expired: 0,
      clusters: [],
      tokensReclaimed: 0,
      tookMs: 0,
      dryRun,
      warnings: [],
    };

    // Load the working set once; every pass operates on this snapshot.
    const memories: Memory[] = [];
    for await (const batch of this.storage.iterateMemories(namespace, { status: 'active' }, 500)) {
      memories.push(...batch);
      if (memories.length >= maxMemories) break;
    }
    report.scanned = memories.length;

    const allowedTypes = new Set<MemoryType>(
      options.types ??
        (Object.entries(this.policies)
          .filter(([, policy]) => policy.consolidate)
          .map(([type]) => type) as MemoryType[]),
    );

    const candidates = memories.filter((memory) => allowedTypes.has(memory.type));
    // Ids retired by an earlier pass must not be reprocessed by a later one.
    const retired = new Set<string>();

    if (expire) {
      try {
        if (dryRun) {
          const now = Date.now();
          report.expired = memories.filter(
            (memory) => memory.expiresAt && Date.parse(memory.expiresAt) <= now,
          ).length;
        } else {
          report.expired = await this.storage.purgeExpired(namespace);
        }
      } catch (err) {
        report.warnings.push(`expire pass failed: ${errorMessage(err)}`);
      }
    }

    if (deduplicate) {
      try {
        const merged = await this.deduplicate(namespace, candidates, duplicateThreshold, dryRun, retired);
        report.duplicatesMerged = merged.count;
        report.tokensReclaimed += merged.tokensReclaimed;
      } catch (err) {
        report.warnings.push(`deduplicate pass failed: ${errorMessage(err)}`);
      }
    }

    const live = candidates.filter((memory) => !retired.has(memory.id));

    if (summarize) {
      try {
        const result = await this.summarizeOld(
          namespace,
          live,
          { olderThanDays: summarizeOlderThanDays, minGroupSize, maxTokens: summaryMaxTokens },
          dryRun,
          retired,
        );
        report.memoriesSummarized = result.summarized;
        report.summariesCreated = result.created;
        report.tokensReclaimed += result.tokensReclaimed;
      } catch (err) {
        report.warnings.push(`summarize pass failed: ${errorMessage(err)}`);
      }
    }

    if (archive) {
      try {
        report.archived = await this.archiveStale(
          namespace,
          candidates.filter((memory) => !retired.has(memory.id)),
          dryRun,
        );
      } catch (err) {
        report.warnings.push(`archive pass failed: ${errorMessage(err)}`);
      }
    }

    if (cluster) {
      try {
        report.clusters = this.cluster(
          memories.filter((memory) => !retired.has(memory.id)),
          options.clusterThreshold,
        );
      } catch (err) {
        report.warnings.push(`cluster pass failed: ${errorMessage(err)}`);
      }
    }

    report.tookMs = Date.now() - startedAt;
    this.logger.info('consolidation complete', { namespace, ...summarizeReport(report) });
    return report;
  }

  /**
   * Merge duplicates.
   *
   * Exact content-hash matches are handled first (cheap, certain), then a
   * similarity sweep over embeddings. Within each duplicate group the *best*
   * memory survives — highest importance, then most accessed, then newest —
   * and absorbs the tags, metadata, and access counts of the rest.
   */
  private async deduplicate(
    namespace: string,
    memories: Memory[],
    threshold: number,
    dryRun: boolean,
    retired: Set<string>,
  ): Promise<{ count: number; tokensReclaimed: number }> {
    const groups: Memory[][] = [];

    // Pass 1 — exact duplicates by content hash.
    const byHash = new Map<string, Memory[]>();
    for (const memory of memories) {
      const bucket = byHash.get(memory.contentHash);
      if (bucket) bucket.push(memory);
      else byHash.set(memory.contentHash, [memory]);
    }
    const exactlyGrouped = new Set<string>();
    for (const bucket of byHash.values()) {
      if (bucket.length > 1) {
        groups.push(bucket);
        for (const memory of bucket) exactlyGrouped.add(memory.id);
      }
    }

    // Pass 2 — near-duplicates by cosine similarity, single-link agglomeration.
    const embedded = memories.filter(
      (memory) => !exactlyGrouped.has(memory.id) && memory.embedding && memory.embedding.length > 0,
    );
    const assigned = new Set<string>();

    for (let i = 0; i < embedded.length; i++) {
      const seed = embedded[i];
      if (!seed || assigned.has(seed.id)) continue;
      const group = [seed];

      for (let j = i + 1; j < embedded.length; j++) {
        const candidate = embedded[j];
        if (!candidate || assigned.has(candidate.id)) continue;
        // Only merge within the same type: a procedural note and an episodic
        // record can describe the same event without being interchangeable.
        if (candidate.type !== seed.type) continue;
        if (!seed.embedding || !candidate.embedding) continue;
        if (seed.embedding.length !== candidate.embedding.length) continue;

        if (cosineSimilarity(seed.embedding, candidate.embedding) >= threshold) {
          group.push(candidate);
          assigned.add(candidate.id);
        }
      }

      if (group.length > 1) {
        assigned.add(seed.id);
        groups.push(group);
      }
    }

    let count = 0;
    let tokensReclaimed = 0;

    for (const group of groups) {
      const [survivor, ...losers] = group.slice().sort(compareForSurvival);
      if (!survivor || losers.length === 0) continue;

      const mergedTags = new Set(survivor.tags);
      let mergedMetadata = { ...survivor.metadata };
      let maxImportance = survivor.importance;
      let totalAccess = survivor.accessCount;

      for (const loser of losers) {
        for (const tag of loser.tags) mergedTags.add(tag);
        // Survivor's own metadata wins on key conflicts.
        mergedMetadata = { ...loser.metadata, ...mergedMetadata };
        maxImportance = Math.max(maxImportance, loser.importance);
        totalAccess += loser.accessCount;
        tokensReclaimed += loser.tokens;
      }

      if (!dryRun) {
        await this.storage.updateMemory(namespace, survivor.id, {
          tags: Array.from(mergedTags),
          metadata: {
            ...mergedMetadata,
            consolidatedFrom: losers.map((loser) => loser.id),
            consolidatedAt: new Date().toISOString(),
          },
          importance: maxImportance,
          accessCount: totalAccess,
          version: survivor.version + 1,
          updatedAt: new Date().toISOString(),
        });

        for (const loser of losers) {
          await this.storage.updateMemory(namespace, loser.id, {
            status: 'superseded',
            supersededBy: survivor.id,
            updatedAt: new Date().toISOString(),
          });
        }
      }

      for (const loser of losers) retired.add(loser.id);
      count += losers.length;
    }

    return { count, tokensReclaimed };
  }

  /**
   * Collapse groups of old, related memories into a single summary memory.
   *
   * Grouping is by (type, session) so a summary never mixes unrelated threads,
   * and the produced memory supersedes its sources — the detail stays available
   * for audit but stops competing for retrieval slots.
   */
  private async summarizeOld(
    namespace: string,
    memories: Memory[],
    config: { olderThanDays: number; minGroupSize: number; maxTokens: number },
    dryRun: boolean,
    retired: Set<string>,
  ): Promise<{ summarized: number; created: number; tokensReclaimed: number }> {
    const cutoff = Date.now() - config.olderThanDays * 86_400_000;

    const eligible = memories.filter((memory) => {
      if (retired.has(memory.id)) return false;
      if (!this.policies[memory.type].summarizeBeforeArchive) return false;
      const created = Date.parse(memory.createdAt);
      return !Number.isNaN(created) && created < cutoff;
    });

    const groups = new Map<string, Memory[]>();
    for (const memory of eligible) {
      const key = `${memory.type}::${memory.sessionId ?? memory.userId ?? 'global'}`;
      const bucket = groups.get(key);
      if (bucket) bucket.push(memory);
      else groups.set(key, [memory]);
    }

    let summarized = 0;
    let created = 0;
    let tokensReclaimed = 0;

    for (const [key, group] of groups) {
      if (group.length < config.minGroupSize) continue;

      group.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const result = await this.summarizer.summarize({
        texts: group.map((memory) => memory.content),
        maxTokens: config.maxTokens,
      });
      if (!result.summary.trim()) continue;

      const first = group[0];
      const last = group[group.length - 1];
      if (!first || !last) continue;

      const now = new Date().toISOString();
      const parts = key.split('::');
      const groupType = (parts[0] ?? first.type) as MemoryType;

      if (!dryRun) {
        const summaryMemory: Memory = {
          id: generateId('mem'),
          namespace,
          userId: first.userId,
          agentId: first.agentId,
          sessionId: first.sessionId,
          type: groupType,
          kind: 'knowledge',
          status: 'active',
          content: result.summary,
          summary: null,
          title: `Consolidated summary of ${group.length} memories`,
          metadata: {
            consolidated: true,
            method: result.method,
            sourceCount: group.length,
            sourceIds: group.map((memory) => memory.id).slice(0, 200),
            periodStart: first.createdAt,
            periodEnd: last.createdAt,
          },
          tags: Array.from(new Set(group.flatMap((memory) => memory.tags))).slice(0, 32),
          // A summary of many memories is at least as important as its most
          // important source, and inherits the weakest source's confidence.
          importance: Math.min(1, Math.max(...group.map((memory) => memory.importance)) + 0.05),
          confidence: Math.min(...group.map((memory) => memory.confidence)),
          embedding: null,
          embeddingModel: null,
          tokens: result.tokens,
          accessCount: 0,
          lastAccessedAt: null,
          createdAt: now,
          updatedAt: now,
          expiresAt: null,
          archivedAt: null,
          supersededBy: null,
          sourceId: null,
          contentHash: await contentHash(result.summary),
          version: 1,
        };

        await this.storage.insertMemories([summaryMemory]);

        for (const memory of group) {
          await this.storage.updateMemory(namespace, memory.id, {
            status: 'superseded',
            supersededBy: summaryMemory.id,
            updatedAt: now,
          });
        }
      }

      for (const memory of group) {
        retired.add(memory.id);
        tokensReclaimed += memory.tokens;
      }
      tokensReclaimed -= result.tokens;
      summarized += group.length;
      created += 1;
    }

    return { summarized, created, tokensReclaimed: Math.max(0, tokensReclaimed) };
  }

  /** Move stale-but-valid memories to `archived` so they leave the active set. */
  private async archiveStale(namespace: string, memories: Memory[], dryRun: boolean): Promise<number> {
    const now = Date.now();
    let archived = 0;

    for (const memory of memories) {
      const touchedAt = memory.lastAccessedAt ?? memory.updatedAt;
      if (!isStale(touchedAt, memory.type, this.policies, now)) continue;
      // High-importance memories are exempt: staleness is a weak signal next to
      // an explicit statement that something matters.
      if (memory.importance >= 0.8) continue;

      if (!dryRun) {
        await this.storage.updateMemory(namespace, memory.id, {
          status: 'archived',
          archivedAt: new Date(now).toISOString(),
          updatedAt: new Date(now).toISOString(),
        });
      }
      archived++;
    }

    return archived;
  }

  /**
   * Group memories into topic clusters.
   *
   * Uses single-pass leader clustering: each memory joins the first centroid it
   * is close enough to, otherwise it seeds a new cluster. O(n·k) rather than the
   * O(n²) of full agglomeration, and it needs no pre-chosen k — which matters
   * because the number of topics in a memory store isn't known in advance.
   */
  private cluster(memories: Memory[], threshold?: number, maxClusters = 40): MemoryCluster[] {
    // Two memories on the same topic typically sit well below the "these are
    // the same text" level, so cluster at roughly half the full-confidence mark.
    const effectiveThreshold = threshold ?? this.fullConfidenceSimilarity * 0.5;
    const embedded = memories.filter((memory) => memory.embedding && memory.embedding.length > 0);
    if (embedded.length < 2) return [];

    const clusters: Array<{ centroid: number[]; members: Memory[] }> = [];

    for (const memory of embedded) {
      const embedding = memory.embedding;
      if (!embedding) continue;

      let bestIndex = -1;
      let bestSimilarity = effectiveThreshold;

      for (let i = 0; i < clusters.length; i++) {
        const cluster = clusters[i];
        if (!cluster || cluster.centroid.length !== embedding.length) continue;
        const similarity = cosineSimilarity(cluster.centroid, embedding);
        if (similarity > bestSimilarity) {
          bestSimilarity = similarity;
          bestIndex = i;
        }
      }

      if (bestIndex >= 0) {
        const cluster = clusters[bestIndex];
        if (cluster) {
          cluster.members.push(memory);
          // Recompute so the centroid tracks the cluster as it grows.
          cluster.centroid = centroid(
            cluster.members.map((member) => member.embedding).filter((v): v is number[] => Boolean(v)),
          );
        }
      } else if (clusters.length < maxClusters) {
        clusters.push({ centroid: embedding.slice(), members: [memory] });
      }
    }

    return clusters
      .filter((cluster) => cluster.members.length >= 2)
      .map((cluster) => {
        const keywords = topKeywords(cluster.members, 5);
        const coherence =
          cluster.members.reduce((sum, member) => {
            if (!member.embedding || member.embedding.length !== cluster.centroid.length) return sum;
            return sum + cosineSimilarity(cluster.centroid, member.embedding);
          }, 0) / cluster.members.length;

        return {
          id: generateId('cls'),
          label: keywords.slice(0, 3).join(', ') || 'untitled cluster',
          memoryIds: cluster.members.map((member) => member.id),
          centroid: cluster.centroid,
          coherence,
          keywords,
        };
      })
      .sort((a, b) => b.memoryIds.length - a.memoryIds.length);
  }
}

/** Best survivor first: importance, then usage, then recency. */
function compareForSurvival(a: Memory, b: Memory): number {
  if (a.importance !== b.importance) return b.importance - a.importance;
  if (a.accessCount !== b.accessCount) return b.accessCount - a.accessCount;
  return b.createdAt.localeCompare(a.createdAt);
}

/** Highest-frequency content terms across a group, used as a cluster label. */
function topKeywords(memories: Memory[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const memory of memories) {
    // Deduplicate per memory so one verbose document can't dominate the label.
    for (const term of new Set(analyze(memory.content))) {
      if (term.length < 3) continue;
      counts.set(term, (counts.get(term) ?? 0) + 1);
    }
    for (const tag of memory.tags) counts.set(tag, (counts.get(tag) ?? 0) + 2);
  }
  return Array.from(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([term]) => term);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function summarizeReport(report: ConsolidationReport): Record<string, unknown> {
  return {
    scanned: report.scanned,
    duplicatesMerged: report.duplicatesMerged,
    summariesCreated: report.summariesCreated,
    archived: report.archived,
    expired: report.expired,
    clusters: report.clusters.length,
    tookMs: report.tookMs,
  };
}

export { estimateTokens };
