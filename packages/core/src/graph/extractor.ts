/**
 * Entity and relationship extraction.
 *
 * The default extractor is rule-based: deterministic, instant, free, and
 * offline. It recognises the entity classes that actually recur in agent
 * memory — people, organizations, projects, files, technologies, locations,
 * events, and concepts — using orthographic cues, gazetteers, and a set of
 * surface patterns for relations.
 *
 * This will not match a fine-tuned NER model on open-domain prose, and it does
 * not pretend to. It is tuned for precision over recall: a graph with fewer,
 * correct nodes is far more useful than one polluted with noise. When higher
 * recall matters, implement `EntityExtractor` over an LLM and pass it in — the
 * rest of the graph pipeline is unchanged.
 */
import type { EntityType, RelationType } from '../types.js';

export interface ExtractedEntity {
  name: string;
  type: EntityType;
  /** 0..1 — how sure the extractor is about this mention and its type. */
  confidence: number;
  /** Character offsets of every mention in the source text. */
  mentions: Array<{ start: number; end: number }>;
}

export interface ExtractedRelation {
  source: string;
  target: string;
  type: RelationType;
  confidence: number;
  /** The text span that evidenced the relation, for auditing. */
  evidence: string;
}

export interface ExtractionResult {
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
}

export interface EntityExtractor {
  readonly name: string;
  extract(text: string, hints?: ExtractionHints): Promise<ExtractionResult>;
}

export interface ExtractionHints {
  /** Tags on the memory; treated as high-confidence concept entities. */
  tags?: string[];
  /** Bias extraction toward a type, e.g. `code` memories favour technologies. */
  kind?: string;
}

/* -------------------------------------------------------------------------- */
/*                                 Gazetteers                                  */
/* -------------------------------------------------------------------------- */

const ORG_SUFFIXES = /\b(inc|llc|ltd|corp|corporation|gmbh|company|co|foundation|university|institute|labs?|group|holdings|plc|ag|sa|bv|pty)\b\.?$/i;

/**
 * Technology names that are also ordinary English words. Matching these
 * case-insensitively produces constant false positives — "Releases **go** out on
 * Thursday" is not a mention of the Go language — so they are only accepted when
 * capitalised in the source text.
 */
const AMBIGUOUS_TECHNOLOGIES = new Set([
  'go', 'rust', 'swift', 'dart', 'ruby', 'c', 'r', 'julia', 'processing',
  'spring', 'flask', 'solid', 'astro', 'remix', 'next', 'node', 'express',
]);

/** Curated technology gazetteer. Lowercase keys; matched on token boundaries. */
const TECHNOLOGIES = new Set([
  'typescript','javascript','python','rust','go','golang','java','kotlin','swift','ruby','php','scala',
  'elixir','haskell','clojure','c++','c#','sql','graphql','html','css','bash','zsh',
  'react','nextjs','next.js','vue','svelte','angular','solid','remix','astro','nuxt',
  'node','nodejs','node.js','deno','bun','express','fastify','nestjs','django','flask','fastapi','rails',
  'spring','laravel','phoenix',
  'postgres','postgresql','mysql','sqlite','mongodb','redis','cassandra','dynamodb','clickhouse',
  'elasticsearch','opensearch','pgvector','pinecone','weaviate','qdrant','milvus','chroma','faiss',
  'docker','kubernetes','k8s','terraform','ansible','helm','nginx','envoy','istio',
  'aws','gcp','azure','vercel','netlify','cloudflare','supabase','firebase','heroku','railway','fly.io',
  'kafka','rabbitmq','nats','temporal','airflow','dbt','spark','flink',
  'openai','anthropic','claude','gpt','gemini','llama','mistral','ollama','huggingface','langchain',
  'llamaindex','openrouter','pytorch','tensorflow','jax','numpy','pandas','scikit-learn',
  'git','github','gitlab','jira','linear','notion','figma','slack','stripe','clerk','auth0',
  'vitest','jest','playwright','cypress','pytest','eslint','prettier','webpack','vite','esbuild','turbopack',
  'tailwind','tailwindcss','shadcn','radix','framer-motion','prisma','drizzle','trpc','zod',
]);

/** Common first names and honorifics that strongly signal a person. */
const PERSON_CUES = /\b(mr|mrs|ms|dr|prof|professor|sir|madam)\b\.?\s/i;

const LOCATION_CUES = new Set([
  'street','avenue','road','boulevard','city','town','village','county','state','province','country',
  'district','region','park','airport','station','building','office','campus','headquarters','hq',
]);

/**
 * Words that are capitalised for reasons other than being a proper noun —
 * sentence starts, weekdays, months, and common discourse markers. Filtering
 * these is the single biggest precision win in a capitalisation-based extractor.
 */
const CAPITALIZED_STOPWORDS = new Set([
  'the','a','an','this','that','these','those','it','he','she','they','we','you','i','my','our','your',
  'and','but','or','so','if','when','while','after','before','then','than','because','however',
  'monday','tuesday','wednesday','thursday','friday','saturday','sunday',
  'january','february','march','april','may','june','july','august','september','october','november','december',
  'today','tomorrow','yesterday','now','later','here','there','what','who','why','how','where','which',
  'note','todo','fixme','warning','error','info','update','new','old','first','last','next','previous',
  'yes','no','ok','okay','also','just','only','still','even','not','all','some','any','each','every',
  'let','lets','make','made','use','used','using','need','needs','want','wants','should','would','could',
  'add','added','fix','fixed','remove','removed','set','get','run','ran',
]);

/** True for discourse words, weekdays, and months — including plural forms. */
function isCapitalizedStopword(word: string): boolean {
  const lower = word.toLowerCase();
  if (CAPITALIZED_STOPWORDS.has(lower)) return true;
  // "Thursdays", "Mondays", "Fridays" — the list holds only singulars.
  return lower.endsWith('s') && CAPITALIZED_STOPWORDS.has(lower.slice(0, -1));
}

/* -------------------------------------------------------------------------- */
/*                             Relation patterns                               */
/* -------------------------------------------------------------------------- */

interface RelationPattern {
  regex: RegExp;
  type: RelationType;
  confidence: number;
  /** Swap capture groups when the surface form reverses the logical direction. */
  reverse?: boolean;
}

// `([A-Z][\w.&'-]*(?:\s+[A-Z][\w.&'-]*){0,3})` matches a 1-4 word proper noun.
const NP = "([A-Z][\\w.&'-]*(?:\\s+[A-Z][\\w.&'-]*){0,3})";
/**
 * Optional determiner before an object noun phrase. Without this, a perfectly
 * ordinary sentence like "Checkout depends on *the* Billing Gateway" fails to
 * match, because the proper-noun pattern requires an initial capital.
 */
const DET = '(?:the|a|an|our|its|their)\\s+';

const RELATION_PATTERNS: RelationPattern[] = [
  { regex: new RegExp(`${NP}\\s+works?\\s+(?:at|for)\\s+(?:${DET})?${NP}`, 'g'), type: 'works_at', confidence: 0.85 },
  { regex: new RegExp(`${NP}\\s+works?\\s+on\\s+(?:${DET})?${NP}`, 'g'), type: 'works_on', confidence: 0.85 },
  { regex: new RegExp(`${NP}\\s+(?:is|was)\\s+(?:the\\s+)?(?:owner|lead|maintainer|author)\\s+of\\s+(?:${DET})?${NP}`, 'g'), type: 'works_on', confidence: 0.8 },
  { regex: new RegExp(`${NP}\\s+(?:is|are|was|were)\\s+part\\s+of\\s+(?:${DET})?${NP}`, 'g'), type: 'part_of', confidence: 0.85 },
  { regex: new RegExp(`${NP}\\s+belongs?\\s+to\\s+(?:${DET})?${NP}`, 'g'), type: 'part_of', confidence: 0.8 },
  { regex: new RegExp(`${NP}\\s+(?:is|are|was|were)\\s+(?:located|based)\\s+in\\s+(?:${DET})?${NP}`, 'g'), type: 'located_in', confidence: 0.85 },
  { regex: new RegExp(`${NP}\\s+(?:was|were)\\s+(?:created|written|built|authored|designed)\\s+by\\s+(?:${DET})?${NP}`, 'g'), type: 'created_by', confidence: 0.85 },
  { regex: new RegExp(`${NP}\\s+depends?\\s+on\\s+(?:${DET})?${NP}`, 'g'), type: 'depends_on', confidence: 0.85 },
  { regex: new RegExp(`${NP}\\s+(?:uses?|requires?)\\s+(?:${DET})?${NP}`, 'g'), type: 'depends_on', confidence: 0.7 },
  { regex: new RegExp(`${NP}\\s+knows?\\s+(?:${DET})?${NP}`, 'g'), type: 'knows', confidence: 0.75 },
  { regex: new RegExp(`${NP}\\s+(?:met|meets)\\s+(?:with\\s+)?(?:${DET})?${NP}`, 'g'), type: 'knows', confidence: 0.7 },
  { regex: new RegExp(`${NP}\\s+(?:is|are)\\s+(?:derived|extracted)\\s+from\\s+(?:${DET})?${NP}`, 'g'), type: 'derived_from', confidence: 0.8 },
];

/* -------------------------------------------------------------------------- */
/*                             Rule-based extractor                            */
/* -------------------------------------------------------------------------- */

export class RuleBasedExtractor implements EntityExtractor {
  readonly name = 'rule-based';

  private readonly minConfidence: number;
  private readonly maxEntities: number;

  constructor(options: { minConfidence?: number; maxEntities?: number } = {}) {
    this.minConfidence = options.minConfidence ?? 0.5;
    this.maxEntities = options.maxEntities ?? 64;
  }

  async extract(text: string, hints: ExtractionHints = {}): Promise<ExtractionResult> {
    const found = new Map<string, ExtractedEntity>();

    const record = (
      name: string,
      type: EntityType,
      confidence: number,
      start: number,
      end: number,
    ): void => {
      const trimmed = name.trim();
      if (!trimmed || trimmed.length < 2 || trimmed.length > 128) return;
      const key = `${trimmed.toLowerCase()}::${type}`;
      const existing = found.get(key);
      if (existing) {
        existing.mentions.push({ start, end });
        // Repeated mentions reinforce our belief in the entity.
        existing.confidence = Math.min(1, existing.confidence + 0.05);
      } else {
        found.set(key, { name: trimmed, type, confidence, mentions: [{ start, end }] });
      }
    };

    this.extractStructured(text, record);
    this.extractTechnologies(text, record);
    this.extractProperNouns(text, record);

    // Tags are author-supplied and therefore trusted.
    for (const tag of hints.tags ?? []) {
      record(tag, 'concept', 0.9, 0, 0);
    }

    const entities = Array.from(found.values())
      .filter((entity) => entity.confidence >= this.minConfidence)
      .sort((a, b) => b.mentions.length * b.confidence - a.mentions.length * a.confidence)
      .slice(0, this.maxEntities);

    return { entities, relations: this.extractRelations(text, entities) };
  }

  /** URLs, emails, file paths, and @handles — unambiguous, high confidence. */
  private extractStructured(
    text: string,
    record: (name: string, type: EntityType, confidence: number, start: number, end: number) => void,
  ): void {
    const patterns: Array<{ regex: RegExp; type: EntityType; confidence: number; transform?: (m: string) => string }> = [
      { regex: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, type: 'person', confidence: 0.9 },
      { regex: /\bhttps?:\/\/[^\s<>"')]+/g, type: 'other', confidence: 0.85 },
      // Paths and filenames with a recognisable code/document extension.
      {
        regex: /\b[\w./-]*[\w-]+\.(?:ts|tsx|js|jsx|py|rs|go|java|rb|php|c|cpp|h|css|scss|html|json|ya?ml|toml|md|sql|sh|txt|pdf|csv|xlsx?|docx?)\b/g,
        type: 'file',
        confidence: 0.85,
      },
      { regex: /(?<![\w/])@([a-zA-Z][\w-]{1,38})\b/g, type: 'person', confidence: 0.75, transform: (m) => m.slice(1) },
    ];

    for (const { regex, type, confidence, transform } of patterns) {
      let match: RegExpExecArray | null;
      regex.lastIndex = 0;
      while ((match = regex.exec(text)) !== null) {
        const raw = match[0];
        record(transform ? transform(raw) : raw, type, confidence, match.index, match.index + raw.length);
      }
    }
  }

  private extractTechnologies(
    text: string,
    record: (name: string, type: EntityType, confidence: number, start: number, end: number) => void,
  ): void {
    // Tokenise while preserving offsets so mentions stay citable. The token
    // pattern intentionally admits `.`, `#`, and `+` so that `next.js`, `c#`,
    // and `c++` survive — which means a trailing sentence period gets swallowed
    // too, and has to be trimmed before the gazetteer lookup.
    const regex = /[A-Za-z][\w.#+-]*/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const raw = match[0];
      const token = raw.replace(/[.\-+#]+$/, '');
      if (!token) continue;

      const lower = token.toLowerCase();
      if (!TECHNOLOGIES.has(lower)) continue;

      // Ambiguous names must be capitalised to count as a technology mention.
      if (AMBIGUOUS_TECHNOLOGIES.has(lower) && token[0] === lower[0]) continue;

      record(token, 'technology', 0.9, match.index, match.index + token.length);
    }
  }

  /**
   * Capitalised sequences are the workhorse signal for proper nouns in English.
   * Type is then narrowed by suffix, surrounding cue words, and gazetteers.
   */
  private extractProperNouns(
    text: string,
    record: (name: string, type: EntityType, confidence: number, start: number, end: number) => void,
  ): void {
    const regex = /\b[A-Z][\w'&-]*(?:\s+(?:of|the|and|de|van|von)\s+[A-Z][\w'&-]*|\s+[A-Z][\w'&-]*)*/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      const phrase = match[0].trim();
      const start = match.index;
      const words = phrase.split(/\s+/);

      // A single capitalised word that is a common word is almost certainly a
      // sentence start, not an entity.
      if (words.length === 1) {
        const only = words[0];
        if (!only) continue;
        const lower = only.toLowerCase();
        if (isCapitalizedStopword(only)) continue;
        if (TECHNOLOGIES.has(lower)) continue; // already captured with a better type
        if (only.length < 3) continue;
        // Require either internal caps (CamelCase) or a preceding non-sentence-start.
        const isSentenceStart = start === 0 || /[.!?]\s+$/.test(text.slice(Math.max(0, start - 3), start));
        const hasInternalCaps = /[a-z][A-Z]/.test(only);
        if (isSentenceStart && !hasInternalCaps) continue;
      }

      // Compare with the plural stripped: "Thursdays" and "Mondays" are calendar
      // words, not entities, but only their singular forms are in the list.
      if (words.every((word) => isCapitalizedStopword(word))) continue;

      const context = text.slice(Math.max(0, start - 40), Math.min(text.length, start + phrase.length + 40));
      const type = inferEntityType(phrase, context);
      const confidence = words.length > 1 ? 0.75 : 0.6;
      record(phrase, type, confidence, start, start + phrase.length);
    }
  }

  private extractRelations(text: string, entities: ExtractedEntity[]): ExtractedRelation[] {
    const relations: ExtractedRelation[] = [];
    const known = new Map(entities.map((entity) => [entity.name.toLowerCase(), entity.name]));

    // Resolve a matched phrase to an extracted entity, tolerating partial overlap
    // ("Acme" inside "Acme Corp") so patterns still bind to real nodes.
    const resolve = (phrase: string): string | null => {
      const cleaned = phrase.trim();
      const exact = known.get(cleaned.toLowerCase());
      if (exact) return exact;
      for (const [lower, name] of known) {
        if (lower.includes(cleaned.toLowerCase()) || cleaned.toLowerCase().includes(lower)) return name;
      }
      return null;
    };

    for (const pattern of RELATION_PATTERNS) {
      pattern.regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.regex.exec(text)) !== null) {
        const rawSource = match[1];
        const rawTarget = match[2];
        if (!rawSource || !rawTarget) continue;

        const source = resolve(rawSource);
        const target = resolve(rawTarget);
        if (!source || !target || source === target) continue;

        relations.push({
          source: pattern.reverse ? target : source,
          target: pattern.reverse ? source : target,
          type: pattern.type,
          confidence: pattern.confidence,
          evidence: match[0].slice(0, 200),
        });
      }
    }

    // Co-occurrence fallback: entities appearing in the same text are weakly
    // related. Capped so a dense memory can't emit a quadratic edge explosion.
    const topEntities = entities.slice(0, 8);
    const explicit = new Set(relations.map((r) => `${r.source}|${r.target}`));
    for (let i = 0; i < topEntities.length; i++) {
      for (let j = i + 1; j < topEntities.length; j++) {
        const a = topEntities[i];
        const b = topEntities[j];
        if (!a || !b) continue;
        if (explicit.has(`${a.name}|${b.name}`) || explicit.has(`${b.name}|${a.name}`)) continue;
        relations.push({
          source: a.name,
          target: b.name,
          type: 'related_to',
          confidence: 0.35,
          evidence: 'co-occurrence',
        });
      }
    }

    return relations;
  }
}

/** Narrow a proper noun to a concrete entity type using suffixes and context. */
export function inferEntityType(phrase: string, context: string): EntityType {
  const lower = phrase.toLowerCase();
  const lowerContext = context.toLowerCase();

  if (ORG_SUFFIXES.test(phrase)) return 'organization';
  if (PERSON_CUES.test(context) && /\b(mr|mrs|ms|dr|prof)\b\.?\s+$/i.test(context.slice(0, context.indexOf(phrase)))) {
    return 'person';
  }

  for (const cue of LOCATION_CUES) {
    if (lower.endsWith(` ${cue}`) || lowerContext.includes(`in ${lower}`)) return 'location';
  }

  if (/\b(project|initiative|milestone|epic|roadmap)\b/.test(lowerContext) && !ORG_SUFFIXES.test(phrase)) {
    return 'project';
  }
  if (/\b(meeting|call|conference|launch|release|standup|review|summit|deadline)\b/.test(lowerContext)) {
    return 'event';
  }
  if (/\b(team|company|org|organization|department|startup|vendor|client|customer)\b/.test(lowerContext)) {
    return 'organization';
  }
  if (/\b(said|asked|told|wrote|replied|emailed|reported|thinks|believes|prefers)\b/.test(lowerContext)) {
    return 'person';
  }
  if (TECHNOLOGIES.has(lower)) return 'technology';

  // Two-to-three capitalised words with no other signal read as a person name.
  const words = phrase.split(/\s+/);
  if (words.length === 2 || words.length === 3) {
    if (words.every((word) => /^[A-Z][a-z'-]+$/.test(word))) return 'person';
  }

  return 'concept';
}

export function createDefaultExtractor(options?: { minConfidence?: number; maxEntities?: number }): EntityExtractor {
  return new RuleBasedExtractor(options);
}
