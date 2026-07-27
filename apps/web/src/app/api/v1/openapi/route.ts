/**
 * `/api/v1/openapi` — machine-readable API description.
 *
 * Served as OpenAPI 3.1 so the API can be consumed by Swagger UI, Postman,
 * `openapi-generator`, and LLM tool-calling adapters without a separate spec
 * file drifting out of sync with the routes.
 *
 * Unauthenticated: the schema is public documentation, not sensitive data.
 */
import { NextResponse } from 'next/server';
import { MEMORY_KINDS, MEMORY_TYPES, ENTITY_TYPES, RELATION_TYPES } from '@memorydb/core';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';

const memorySchema = {
  type: 'object',
  required: ['id', 'namespace', 'type', 'kind', 'status', 'content', 'createdAt'],
  properties: {
    id: { type: 'string', example: 'mem_01JAV7X4K2Q8ZB3N5Y6R7T8W9V' },
    namespace: { type: 'string' },
    userId: { type: 'string', nullable: true },
    agentId: { type: 'string', nullable: true },
    sessionId: { type: 'string', nullable: true },
    type: { type: 'string', enum: MEMORY_TYPES },
    kind: { type: 'string', enum: MEMORY_KINDS },
    status: { type: 'string', enum: ['active', 'archived', 'superseded', 'deleted'] },
    content: { type: 'string' },
    summary: { type: 'string', nullable: true },
    title: { type: 'string', nullable: true },
    metadata: { type: 'object', additionalProperties: true },
    tags: { type: 'array', items: { type: 'string' } },
    importance: { type: 'number', minimum: 0, maximum: 1 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    embedding: { type: 'array', items: { type: 'number' }, nullable: true },
    embeddingModel: { type: 'string', nullable: true },
    tokens: { type: 'integer' },
    accessCount: { type: 'integer' },
    lastAccessedAt: { type: 'string', format: 'date-time', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    expiresAt: { type: 'string', format: 'date-time', nullable: true },
    sourceId: { type: 'string', nullable: true },
    contentHash: { type: 'string' },
    version: { type: 'integer' },
  },
} as const;

const memoryFilterSchema = {
  type: 'object',
  description: 'Filter predicates applied before ranking. All conditions are ANDed.',
  properties: {
    type: { oneOf: [{ type: 'string', enum: MEMORY_TYPES }, { type: 'array', items: { type: 'string', enum: MEMORY_TYPES } }] },
    kind: { oneOf: [{ type: 'string', enum: MEMORY_KINDS }, { type: 'array', items: { type: 'string', enum: MEMORY_KINDS } }] },
    userId: { type: 'string' },
    agentId: { type: 'string' },
    sessionId: { type: 'string' },
    sourceId: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' }, description: 'Every tag must be present.' },
    anyTags: { type: 'array', items: { type: 'string' }, description: 'At least one tag must be present.' },
    metadata: {
      type: 'object',
      description:
        'Metadata predicates. A bare value means equality; objects support eq, ne, gt, gte, lt, lte, in, nin, contains, exists. Dotted keys address nested paths.',
      additionalProperties: true,
      example: { 'source.channel': 'email', score: { gte: 5 } },
    },
    createdAfter: { type: 'string', format: 'date-time' },
    createdBefore: { type: 'string', format: 'date-time' },
    minImportance: { type: 'number', minimum: 0, maximum: 1 },
    minConfidence: { type: 'number', minimum: 0, maximum: 1 },
    includeArchived: { type: 'boolean' },
    includeExpired: { type: 'boolean' },
  },
} as const;

const errorSchema = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          enum: [
            'validation_error', 'not_found', 'conflict', 'unauthorized', 'forbidden',
            'rate_limited', 'payload_too_large', 'storage_error', 'embedding_error',
            'provider_error', 'not_supported', 'timeout', 'internal_error',
          ],
        },
        message: { type: 'string' },
        details: { type: 'object', additionalProperties: true },
        retryable: { type: 'boolean' },
      },
    },
    requestId: { type: 'string' },
  },
} as const;

function envelope(dataSchema: unknown) {
  return {
    type: 'object',
    properties: { data: dataSchema, error: { type: 'null' } },
  };
}

const errorResponses = {
  400: { description: 'Validation failed', content: { 'application/json': { schema: errorSchema } } },
  401: { description: 'Authentication required or invalid', content: { 'application/json': { schema: errorSchema } } },
  403: { description: 'Insufficient scope', content: { 'application/json': { schema: errorSchema } } },
  404: { description: 'Not found', content: { 'application/json': { schema: errorSchema } } },
  429: { description: 'Rate limit exceeded', content: { 'application/json': { schema: errorSchema } } },
  500: { description: 'Internal error', content: { 'application/json': { schema: errorSchema } } },
} as const;

export async function GET(): Promise<NextResponse> {
  const spec = {
    openapi: '3.1.0',
    info: {
      title: 'MemoryDB AI',
      version: '0.1.0',
      description: [
        'Long-term memory infrastructure for AI agents.',
        '',
        'Store conversations, documents, notes, preferences, and knowledge, then retrieve',
        'them with hybrid semantic + keyword search, intelligent ranking, and citations.',
        '',
        '## Authentication',
        '',
        'Send an API key as `Authorization: Bearer <key>` or `X-API-Key: <key>`.',
        '',
        '## Namespaces',
        '',
        'Every request is scoped to one namespace — the hard tenant boundary. Select it',
        'with the `X-Namespace` header; otherwise the server default applies.',
        '',
        '## Rate limits',
        '',
        `Reads: ${env.RATE_LIMIT_MAX_REQUESTS}/${env.RATE_LIMIT_WINDOW_SECONDS}s · Writes: ${env.RATE_LIMIT_WRITE_MAX}/${env.RATE_LIMIT_WINDOW_SECONDS}s.`,
        'Responses carry `RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset`.',
      ].join('\n'),
      license: { name: 'MIT', url: 'https://opensource.org/licenses/MIT' },
      contact: { name: 'MemoryDB AI', url: 'https://github.com/itsshreyasbhardwaj-design/memorydb-ai' },
    },
    servers: [{ url: `${env.NEXT_PUBLIC_APP_URL}/api/v1`, description: 'This deployment' }],

    security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],

    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'API key as a bearer token.' },
        apiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      },
      parameters: {
        namespace: {
          name: 'X-Namespace',
          in: 'header',
          required: false,
          schema: { type: 'string', pattern: '^[a-zA-Z0-9_:.-]{1,128}$' },
          description: 'Tenant scope. Defaults to the server-configured namespace.',
        },
      },
      schemas: { Memory: memorySchema, MemoryFilter: memoryFilterSchema, Error: errorSchema },
    },

    paths: {
      '/memories': {
        post: {
          summary: 'Create one or many memories',
          description:
            'Send a single memory object, or `{ "memories": [...] }` for a batch. Identical content is de-duplicated by default and the existing memory is returned.',
          tags: ['Memories'],
          parameters: [{ $ref: '#/components/parameters/namespace' }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  oneOf: [
                    {
                      type: 'object',
                      required: ['content'],
                      properties: {
                        content: { type: 'string', minLength: 1 },
                        type: { type: 'string', enum: MEMORY_TYPES, default: 'long_term' },
                        kind: { type: 'string', enum: MEMORY_KINDS, default: 'note' },
                        title: { type: 'string', nullable: true },
                        tags: { type: 'array', items: { type: 'string' } },
                        metadata: { type: 'object', additionalProperties: true },
                        importance: { type: 'number', minimum: 0, maximum: 1 },
                        confidence: { type: 'number', minimum: 0, maximum: 1 },
                        userId: { type: 'string', nullable: true },
                        agentId: { type: 'string', nullable: true },
                        sessionId: { type: 'string', nullable: true },
                        sourceId: { type: 'string', nullable: true },
                        ttlSeconds: { type: 'integer', nullable: true },
                        deduplicate: { type: 'boolean', default: true },
                        chunk: { type: 'boolean', default: false, description: 'Split long content into overlapping chunks.' },
                      },
                    },
                    {
                      type: 'object',
                      required: ['memories'],
                      properties: { memories: { type: 'array', items: { type: 'object' }, maxItems: env.MAX_BATCH_SIZE } },
                    },
                  ],
                },
                examples: {
                  single: { summary: 'One memory', value: { content: 'Ada prefers async written updates.', type: 'semantic', tags: ['people'] } },
                  batch: { summary: 'A batch', value: { memories: [{ content: 'First fact' }, { content: 'Second fact' }] } },
                },
              },
            },
          },
          responses: {
            201: { description: 'Created', content: { 'application/json': { schema: envelope({ type: 'object' }) } } },
            ...errorResponses,
          },
        },
        get: {
          summary: 'List memories',
          tags: ['Memories'],
          parameters: [
            { $ref: '#/components/parameters/namespace' },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 500 } },
            { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
            { name: 'sortBy', in: 'query', schema: { type: 'string', enum: ['createdAt', 'updatedAt', 'importance', 'accessCount', 'lastAccessedAt'] } },
            { name: 'sortDir', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'], default: 'desc' } },
            { name: 'type', in: 'query', schema: { type: 'string' }, description: 'Comma-separated memory types.' },
            { name: 'tags', in: 'query', schema: { type: 'string' }, description: 'Comma-separated; all must match.' },
            { name: 'userId', in: 'query', schema: { type: 'string' } },
            { name: 'metadata', in: 'query', schema: { type: 'string' }, description: 'JSON-encoded metadata filter.' },
          ],
          responses: {
            200: {
              description: 'A page of memories',
              content: {
                'application/json': {
                  schema: envelope({
                    type: 'object',
                    properties: {
                      items: { type: 'array', items: { $ref: '#/components/schemas/Memory' } },
                      total: { type: 'integer' },
                      limit: { type: 'integer' },
                      offset: { type: 'integer' },
                      hasMore: { type: 'boolean' },
                    },
                  }),
                },
              },
            },
            ...errorResponses,
          },
        },
        delete: {
          summary: 'Bulk delete by filter',
          description: 'Requires the `admin` scope and at least one filter condition.',
          tags: ['Memories'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['filter'],
                  properties: { filter: { $ref: '#/components/schemas/MemoryFilter' }, hard: { type: 'boolean', default: false } },
                },
              },
            },
          },
          responses: { 200: { description: 'Deleted', content: { 'application/json': { schema: envelope({ type: 'object' }) } } }, ...errorResponses },
        },
      },

      '/memories/{id}': {
        get: {
          summary: 'Get a memory',
          tags: ['Memories'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { $ref: '#/components/parameters/namespace' }],
          responses: { 200: { description: 'The memory', content: { 'application/json': { schema: envelope({ type: 'object', properties: { memory: { $ref: '#/components/schemas/Memory' } } }) } } }, ...errorResponses },
        },
        patch: {
          summary: 'Update a memory',
          description: 'Changing `content` transparently recomputes the embedding and content hash.',
          tags: ['Memories'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    content: { type: 'string' },
                    title: { type: 'string', nullable: true },
                    tags: { type: 'array', items: { type: 'string' }, description: 'Replaces the whole tag set.' },
                    addTags: { type: 'array', items: { type: 'string' } },
                    removeTags: { type: 'array', items: { type: 'string' } },
                    metadata: { type: 'object', additionalProperties: true, description: 'Merged into existing metadata.' },
                    importance: { type: 'number', minimum: 0, maximum: 1 },
                    status: { type: 'string', enum: ['active', 'archived', 'superseded', 'deleted'] },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Updated', content: { 'application/json': { schema: envelope({ type: 'object' }) } } }, ...errorResponses },
        },
        delete: {
          summary: 'Delete a memory',
          description: 'Soft-deletes by default; `?hard=true` removes the row permanently.',
          tags: ['Memories'],
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'hard', in: 'query', schema: { type: 'boolean', default: false } },
          ],
          responses: { 200: { description: 'Deleted', content: { 'application/json': { schema: envelope({ type: 'object' }) } } }, ...errorResponses },
        },
      },

      '/search': {
        post: {
          summary: 'Hybrid search',
          description:
            'Runs a dense vector leg and a lexical BM25 leg, fuses them with Reciprocal Rank Fusion, then re-ranks by recency, importance, confidence, and usage.',
          tags: ['Retrieval'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['query'],
                  properties: {
                    query: { type: 'string', minLength: 1 },
                    mode: { type: 'string', enum: ['hybrid', 'semantic', 'keyword'], default: 'hybrid' },
                    limit: { type: 'integer', default: 10, maximum: 200 },
                    offset: { type: 'integer', default: 0 },
                    minScore: { type: 'number', default: 0, description: 'Calibrated relevance floor in 0..1.' },
                    vectorWeight: { type: 'number', default: 0.6 },
                    keywordWeight: { type: 'number', default: 0.4 },
                    recencyHalfLifeDays: { type: 'number', default: 30, description: '0 disables recency decay.' },
                    importanceWeight: { type: 'number', default: 0.15 },
                    trackAccess: { type: 'boolean', default: false },
                    explain: { type: 'boolean', default: false, description: 'Include the per-signal score breakdown.' },
                    filter: { $ref: '#/components/schemas/MemoryFilter' },
                  },
                },
                example: { query: 'What database do we use?', mode: 'hybrid', limit: 5, explain: true },
              },
            },
          },
          responses: {
            200: {
              description: 'Ranked results',
              content: {
                'application/json': {
                  schema: envelope({
                    type: 'object',
                    properties: {
                      hits: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            memory: { $ref: '#/components/schemas/Memory' },
                            score: { type: 'number' },
                            rank: { type: 'integer' },
                            citation: { type: 'object' },
                            scores: { type: 'object', description: 'Present when `explain` is true.' },
                          },
                        },
                      },
                      total: { type: 'integer' },
                      tookMs: { type: 'number' },
                    },
                  }),
                },
              },
            },
            ...errorResponses,
          },
        },
        get: {
          summary: 'Hybrid search (query string)',
          tags: ['Retrieval'],
          parameters: [
            { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'mode', in: 'query', schema: { type: 'string', enum: ['hybrid', 'semantic', 'keyword'] } },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 10 } },
            { name: 'tags', in: 'query', schema: { type: 'string' } },
            { name: 'explain', in: 'query', schema: { type: 'boolean' } },
          ],
          responses: { 200: { description: 'Ranked results', content: { 'application/json': { schema: envelope({ type: 'object' }) } } }, ...errorResponses },
        },
      },

      '/retrieve': {
        post: {
          summary: 'Intelligent retrieval for model context',
          description:
            'Search, then shape the result for direct use as LLM context: redundant hits removed, a token budget enforced, a formatted context block with `[n]` citation markers, and an aggregate confidence score.',
          tags: ['Retrieval'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['query'],
                  properties: {
                    query: { type: 'string' },
                    limit: { type: 'integer', default: 10 },
                    tokenBudget: { type: 'integer', default: 4000, description: 'Hard cap on tokens across returned memories.' },
                    diversify: { type: 'boolean', default: true },
                    diversityThreshold: { type: 'number', default: 0.92 },
                    formatContext: { type: 'boolean', default: true },
                    filter: { $ref: '#/components/schemas/MemoryFilter' },
                  },
                },
                example: { query: 'What are the deployment rules?', tokenBudget: 2000 },
              },
            },
          },
          responses: {
            200: {
              description: 'Context-ready result',
              content: {
                'application/json': {
                  schema: envelope({
                    type: 'object',
                    properties: {
                      hits: { type: 'array', items: { type: 'object' } },
                      context: { type: 'string', description: 'Model-ready block with inline citation markers.' },
                      citations: { type: 'array', items: { type: 'object' } },
                      tokensUsed: { type: 'integer' },
                      confidence: { type: 'number', description: 'Aggregate confidence in 0..1.' },
                      dropped: { type: 'integer' },
                    },
                  }),
                },
              },
            },
            ...errorResponses,
          },
        },
      },

      '/embeddings': {
        post: {
          summary: 'Generate embeddings',
          tags: ['Embeddings'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['input'],
                  properties: {
                    input: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, maxItems: 256 }] },
                    similarity: { type: 'boolean', default: false, description: 'Also return the pairwise cosine matrix.' },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Vectors', content: { 'application/json': { schema: envelope({ type: 'object' }) } } }, ...errorResponses },
        },
        get: { summary: 'Describe the configured embedding provider', tags: ['Embeddings'], responses: { 200: { description: 'Provider info', content: { 'application/json': { schema: envelope({ type: 'object' }) } } } } },
      },

      '/stats': {
        get: {
          summary: 'Namespace statistics',
          tags: ['Analytics'],
          parameters: [
            { name: 'growthDays', in: 'query', schema: { type: 'integer', default: 30, maximum: 365 } },
            { name: 'topTagsLimit', in: 'query', schema: { type: 'integer', default: 20 } },
          ],
          responses: { 200: { description: 'Statistics', content: { 'application/json': { schema: envelope({ type: 'object' }) } } }, ...errorResponses },
        },
      },

      '/graph': {
        get: {
          summary: 'Knowledge graph',
          description: 'Entities and relations extracted from stored memories, as renderable nodes and edges.',
          tags: ['Graph'],
          parameters: [
            { name: 'types', in: 'query', schema: { type: 'string' }, description: `Comma-separated: ${ENTITY_TYPES.join(', ')}` },
            { name: 'rootIds', in: 'query', schema: { type: 'string' }, description: 'Restrict to the subgraph reachable from these entities.' },
            { name: 'depth', in: 'query', schema: { type: 'integer', default: 2, maximum: 5 } },
            { name: 'maxNodes', in: 'query', schema: { type: 'integer', default: 150 } },
            { name: 'minWeight', in: 'query', schema: { type: 'number' } },
          ],
          responses: {
            200: {
              description: 'Graph',
              content: {
                'application/json': {
                  schema: envelope({
                    type: 'object',
                    properties: {
                      nodes: { type: 'array', items: { type: 'object' } },
                      edges: { type: 'array', items: { type: 'object', properties: { type: { type: 'string', enum: RELATION_TYPES } } } },
                      stats: { type: 'object' },
                    },
                  }),
                },
              },
            },
            ...errorResponses,
          },
        },
      },

      '/graph/entities': {
        get: {
          summary: 'List entities',
          tags: ['Graph'],
          parameters: [
            { name: 'type', in: 'query', schema: { type: 'string' } },
            { name: 'search', in: 'query', schema: { type: 'string' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
          ],
          responses: { 200: { description: 'Entities', content: { 'application/json': { schema: envelope({ type: 'object' }) } } }, ...errorResponses },
        },
      },

      '/batch/import': {
        post: {
          summary: 'Bulk import',
          description: 'Accepts JSON, JSONL, CSV, Markdown, plain text, or ZIP — as a raw body or `multipart/form-data`.',
          tags: ['Batch'],
          parameters: [
            { name: 'format', in: 'query', schema: { type: 'string', enum: ['json', 'jsonl', 'csv', 'markdown', 'txt', 'zip'] } },
            { name: 'deduplicate', in: 'query', schema: { type: 'boolean', default: true } },
            { name: 'dryRun', in: 'query', schema: { type: 'boolean', default: false } },
            { name: 'tags', in: 'query', schema: { type: 'string' }, description: 'Tags applied to every imported memory.' },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { type: 'array', items: { type: 'object' } } },
              'text/csv': { schema: { type: 'string' } },
              'text/markdown': { schema: { type: 'string' } },
              'application/zip': { schema: { type: 'string', format: 'binary' } },
              'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } },
            },
          },
          responses: { 200: { description: 'Import report', content: { 'application/json': { schema: envelope({ type: 'object' }) } } }, ...errorResponses },
        },
      },

      '/batch/export': {
        get: {
          summary: 'Bulk export',
          description: 'Downloads the namespace in the requested format. ZIP bundles JSON, CSV, Markdown, and optionally the graph.',
          tags: ['Batch'],
          parameters: [
            { name: 'format', in: 'query', schema: { type: 'string', enum: ['json', 'jsonl', 'csv', 'markdown', 'txt', 'zip'], default: 'json' } },
            { name: 'includeEmbeddings', in: 'query', schema: { type: 'boolean', default: false } },
            { name: 'includeGraph', in: 'query', schema: { type: 'boolean', default: false } },
            { name: 'tags', in: 'query', schema: { type: 'string' } },
          ],
          responses: {
            200: {
              description: 'The exported file',
              content: {
                'application/json': { schema: { type: 'object' } },
                'text/csv': { schema: { type: 'string' } },
                'application/zip': { schema: { type: 'string', format: 'binary' } },
              },
            },
            ...errorResponses,
          },
        },
      },

      '/consolidate': {
        post: {
          summary: 'Run consolidation',
          description:
            'Merges duplicates, summarises old memories, archives stale ones, purges expired ones, and rebuilds topic clusters. Requires the `admin` scope; `dryRun` reports without writing.',
          tags: ['Maintenance'],
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    dryRun: { type: 'boolean', default: false },
                    duplicateThreshold: { type: 'number', default: 0.94 },
                    summarizeOlderThanDays: { type: 'integer', default: 30 },
                    deduplicate: { type: 'boolean', default: true },
                    summarize: { type: 'boolean', default: true },
                    archive: { type: 'boolean', default: true },
                    expire: { type: 'boolean', default: true },
                    cluster: { type: 'boolean', default: true },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Consolidation report', content: { 'application/json': { schema: envelope({ type: 'object' }) } } }, ...errorResponses },
        },
      },

      '/health': {
        get: {
          summary: 'Health check',
          description: 'Unauthenticated liveness and readiness probe.',
          tags: ['System'],
          security: [],
          responses: {
            200: { description: 'Healthy', content: { 'application/json': { schema: { type: 'object' } } } },
            503: { description: 'Unhealthy or degraded', content: { 'application/json': { schema: { type: 'object' } } } },
          },
        },
      },

      '/metrics': {
        get: {
          summary: 'Metrics',
          description: 'JSON by default; pass `?format=prometheus` or `Accept: text/plain` for the Prometheus exposition format.',
          tags: ['System'],
          parameters: [{ name: 'format', in: 'query', schema: { type: 'string', enum: ['json', 'prometheus'] } }],
          responses: { 200: { description: 'Metrics', content: { 'application/json': { schema: { type: 'object' } }, 'text/plain': { schema: { type: 'string' } } } } },
        },
      },
    },

    tags: [
      { name: 'Memories', description: 'Create, read, update, and delete memories.' },
      { name: 'Retrieval', description: 'Search and context-ready retrieval.' },
      { name: 'Graph', description: 'Entities and relationships extracted from memories.' },
      { name: 'Embeddings', description: 'Vector generation with the configured provider.' },
      { name: 'Batch', description: 'Bulk import and export.' },
      { name: 'Analytics', description: 'Usage and growth statistics.' },
      { name: 'Maintenance', description: 'Consolidation and housekeeping.' },
      { name: 'System', description: 'Health and observability.' },
    ],
  };

  return NextResponse.json(spec, {
    headers: { 'cache-control': 'public, max-age=300' },
  });
}
