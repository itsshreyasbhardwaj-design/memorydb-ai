/**
 * Knowledge-graph service: turns extracted mentions into a persistent,
 * deduplicated entity/relation graph and answers graph queries over it.
 */
import type {
  Entity,
  EntityType,
  GraphEdge,
  GraphNode,
  KnowledgeGraph,
  Memory,
  Relation,
} from '../types.js';
import type { EntityListOptions, StorageAdapter } from '../storage/types.js';
import type { EntityExtractor, ExtractionResult } from './extractor.js';
import { generateId } from '../util/id.js';

/**
 * Normalise an entity surface form into its resolution key. Case, punctuation,
 * and legal suffixes are stripped so "Acme Corp.", "ACME Corp", and "Acme" all
 * collapse onto one node.
 */
export function normalizeEntityName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,;:!?'"()[\]{}]/g, '')
    .replace(/\b(inc|llc|ltd|corp|corporation|gmbh|co|plc)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface GraphIngestResult {
  entities: Entity[];
  relations: Relation[];
  entitiesCreated: number;
  relationsCreated: number;
}

export interface GraphQueryOptions {
  types?: EntityType[];
  /** Return only the subgraph reachable from these entity ids. */
  rootIds?: string[];
  /** Hops to traverse from the roots. Ignored without `rootIds`. */
  depth?: number;
  minWeight?: number;
  maxNodes?: number;
  maxEdges?: number;
  search?: string;
}

export class GraphService {
  constructor(
    private readonly storage: StorageAdapter,
    private readonly extractor: EntityExtractor,
  ) {}

  /**
   * Extract from a memory and merge the results into the namespace graph.
   *
   * Entities are resolved by normalised name, so repeated mentions across many
   * memories reinforce one node instead of creating duplicates.
   */
  async ingestMemory(memory: Memory): Promise<GraphIngestResult> {
    const extraction: ExtractionResult = await this.extractor.extract(memory.content, {
      tags: memory.tags,
      kind: memory.kind,
    });

    if (extraction.entities.length === 0) {
      return { entities: [], relations: [], entitiesCreated: 0, relationsCreated: 0 };
    }

    const now = new Date().toISOString();
    const maxMentions = Math.max(...extraction.entities.map((entity) => entity.mentions.length), 1);

    const candidates: Entity[] = extraction.entities.map((extracted) => ({
      id: generateId('ent'),
      namespace: memory.namespace,
      type: extracted.type,
      name: extracted.name,
      normalizedName: normalizeEntityName(extracted.name),
      aliases: [],
      description: null,
      metadata: { sourceMemoryId: memory.id },
      mentionCount: extracted.mentions.length,
      // Salience within this memory: mention share scaled by extraction confidence.
      salience: Math.min(1, (extracted.mentions.length / maxMentions) * extracted.confidence),
      firstSeenAt: now,
      lastSeenAt: now,
    }));

    // Collapse candidates that normalise to the same key before hitting storage.
    const byKey = new Map<string, Entity>();
    for (const candidate of candidates) {
      const existing = byKey.get(candidate.normalizedName);
      if (existing) {
        existing.mentionCount += candidate.mentionCount;
        existing.salience = Math.max(existing.salience, candidate.salience);
        if (!existing.aliases.includes(candidate.name) && existing.name !== candidate.name) {
          existing.aliases.push(candidate.name);
        }
      } else {
        byKey.set(candidate.normalizedName, candidate);
      }
    }

    const beforeCount = (await this.storage.listEntities(memory.namespace, { limit: 1 })).total;
    const entities = await this.storage.upsertEntities(Array.from(byKey.values()));
    const afterCount = (await this.storage.listEntities(memory.namespace, { limit: 1 })).total;

    // Map surface names (and their normalised forms) to persisted entity ids.
    const idByName = new Map<string, string>();
    for (const entity of entities) {
      idByName.set(entity.normalizedName, entity.id);
      idByName.set(entity.name.toLowerCase(), entity.id);
      for (const alias of entity.aliases) idByName.set(alias.toLowerCase(), entity.id);
    }

    const relations: Relation[] = [];
    const seen = new Set<string>();

    for (const extracted of extraction.relations) {
      const sourceId = idByName.get(normalizeEntityName(extracted.source)) ?? idByName.get(extracted.source.toLowerCase());
      const targetId = idByName.get(normalizeEntityName(extracted.target)) ?? idByName.get(extracted.target.toLowerCase());
      if (!sourceId || !targetId || sourceId === targetId) continue;

      const key = `${sourceId}|${targetId}|${extracted.type}`;
      if (seen.has(key)) continue;
      seen.add(key);

      relations.push({
        id: generateId('rel'),
        namespace: memory.namespace,
        sourceId,
        targetId,
        type: extracted.type,
        weight: extracted.confidence,
        confidence: extracted.confidence,
        memoryIds: [memory.id],
        metadata: { evidence: extracted.evidence },
        createdAt: now,
        updatedAt: now,
      });
    }

    const persistedRelations = relations.length > 0 ? await this.storage.upsertRelations(relations) : [];

    return {
      entities,
      relations: persistedRelations,
      entitiesCreated: Math.max(0, afterCount - beforeCount),
      relationsCreated: persistedRelations.length,
    };
  }

  /** Remove an entity and every edge touching it. */
  async deleteEntity(namespace: string, id: string): Promise<boolean> {
    return this.storage.deleteEntity(namespace, id);
  }

  async listEntities(namespace: string, options: EntityListOptions = {}) {
    return this.storage.listEntities(namespace, options);
  }

  /**
   * Build a renderable graph.
   *
   * With `rootIds` this performs a bounded breadth-first traversal, which keeps
   * the payload small enough to render even in a namespace with a huge graph.
   */
  async buildGraph(namespace: string, options: GraphQueryOptions = {}): Promise<KnowledgeGraph> {
    const maxNodes = options.maxNodes ?? 150;
    const maxEdges = options.maxEdges ?? 400;

    const entityPage = await this.storage.listEntities(namespace, {
      ...(options.types ? { type: options.types } : {}),
      ...(options.search ? { search: options.search } : {}),
      limit: Math.max(maxNodes * 4, 500),
      sortBy: 'mentionCount',
    });

    let entities = entityPage.items;
    const entityById = new Map(entities.map((entity) => [entity.id, entity]));

    let relations = await this.storage.listRelations(namespace, {
      ...(options.minWeight !== undefined ? { minWeight: options.minWeight } : {}),
      limit: maxEdges * 6,
    });

    if (options.rootIds?.length) {
      const reachable = this.traverse(options.rootIds, relations, options.depth ?? 2);
      entities = entities.filter((entity) => reachable.has(entity.id));
      relations = relations.filter((r) => reachable.has(r.sourceId) && reachable.has(r.targetId));
    }

    // Degree drives both node ranking and the rendered node size.
    const degree = new Map<string, number>();
    for (const relation of relations) {
      degree.set(relation.sourceId, (degree.get(relation.sourceId) ?? 0) + 1);
      degree.set(relation.targetId, (degree.get(relation.targetId) ?? 0) + 1);
    }

    const nodes: GraphNode[] = entities
      .map((entity) => ({ ...entity, degree: degree.get(entity.id) ?? 0 }))
      .sort((a, b) => b.degree - a.degree || b.mentionCount - a.mentionCount)
      .slice(0, maxNodes);

    const keptIds = new Set(nodes.map((node) => node.id));

    const edges: GraphEdge[] = relations
      .filter((relation) => keptIds.has(relation.sourceId) && keptIds.has(relation.targetId))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, maxEdges)
      .map((relation) => ({
        ...relation,
        sourceName: entityById.get(relation.sourceId)?.name ?? relation.sourceId,
        targetName: entityById.get(relation.targetId)?.name ?? relation.targetId,
      }));

    // Density of a directed simple graph: |E| / (|V| * (|V|-1)).
    const nodeCount = nodes.length;
    const possibleEdges = nodeCount * (nodeCount - 1);
    const density = possibleEdges === 0 ? 0 : edges.length / possibleEdges;

    return {
      nodes,
      edges,
      stats: {
        nodeCount,
        edgeCount: edges.length,
        density,
        topEntities: nodes.slice(0, 10).map((node) => ({
          id: node.id,
          name: node.name,
          type: node.type,
          degree: node.degree,
        })),
      },
    };
  }

  /** Breadth-first expansion from roots, treating edges as undirected. */
  private traverse(rootIds: string[], relations: Relation[], depth: number): Set<string> {
    const adjacency = new Map<string, string[]>();
    for (const relation of relations) {
      (adjacency.get(relation.sourceId) ?? adjacency.set(relation.sourceId, []).get(relation.sourceId)!).push(
        relation.targetId,
      );
      (adjacency.get(relation.targetId) ?? adjacency.set(relation.targetId, []).get(relation.targetId)!).push(
        relation.sourceId,
      );
    }

    const visited = new Set<string>(rootIds);
    let frontier = [...rootIds];

    for (let hop = 0; hop < depth; hop++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const neighbour of adjacency.get(id) ?? []) {
          if (!visited.has(neighbour)) {
            visited.add(neighbour);
            next.push(neighbour);
          }
        }
      }
      if (next.length === 0) break;
      frontier = next;
    }

    return visited;
  }

  /** Entities linked to a given one, ordered by edge strength. */
  async neighbours(
    namespace: string,
    entityId: string,
    limit = 20,
  ): Promise<Array<{ entity: Entity; relation: Relation }>> {
    const relations = await this.storage.listRelations(namespace, { entityIds: [entityId], limit: limit * 2 });
    const out: Array<{ entity: Entity; relation: Relation }> = [];

    for (const relation of relations) {
      const otherId = relation.sourceId === entityId ? relation.targetId : relation.sourceId;
      const entity = await this.storage.getEntity(namespace, otherId);
      if (entity) out.push({ entity, relation });
      if (out.length >= limit) break;
    }
    return out;
  }
}
