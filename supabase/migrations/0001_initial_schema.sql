-- ============================================================================
-- MemoryDB AI — initial schema
--
-- Targets PostgreSQL 14+ with the pgvector extension (Supabase ships it).
-- Designed for multi-tenant workloads: every table is partitioned logically by
-- `namespace`, every index leads with `namespace`, and row-level security
-- enforces the boundary even if application code gets it wrong.
-- ============================================================================

create extension if not exists "vector";
create extension if not exists "pg_trgm";      -- trigram index for fuzzy entity lookup
create extension if not exists "pgcrypto";     -- gen_random_uuid, digest

-- ----------------------------------------------------------------------------
-- Enums
--
-- Enums over check constraints: they cost 4 bytes instead of a text value, and
-- adding a variant later is a non-blocking `alter type ... add value`.
-- ----------------------------------------------------------------------------

do $$ begin
  create type memory_type as enum (
    'short_term', 'long_term', 'working', 'semantic', 'episodic', 'procedural', 'graph'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type memory_kind as enum (
    'conversation', 'document', 'note', 'preference', 'profile',
    'task', 'event', 'knowledge', 'code', 'other'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type memory_status as enum ('active', 'archived', 'superseded', 'deleted');
exception when duplicate_object then null; end $$;

do $$ begin
  create type entity_type as enum (
    'person', 'project', 'concept', 'file', 'organization',
    'event', 'location', 'product', 'technology', 'other'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type relation_type as enum (
    'mentions', 'related_to', 'works_on', 'works_at', 'part_of', 'located_in',
    'created_by', 'depends_on', 'occurred_at', 'knows', 'derived_from'
  );
exception when duplicate_object then null; end $$;

-- ----------------------------------------------------------------------------
-- Namespaces — the tenant boundary
-- ----------------------------------------------------------------------------

create table if not exists namespaces (
  id            text primary key,
  name          text not null,
  owner_id      text,
  description   text,
  settings      jsonb not null default '{}'::jsonb,
  -- Vector width is fixed per namespace: mixing dimensions in one index is
  -- impossible, so a model change requires an explicit reindex.
  embedding_dimensions integer not null default 384,
  embedding_model text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists namespaces_owner_idx on namespaces (owner_id);

-- ----------------------------------------------------------------------------
-- Helper: immutable array-to-text
--
-- A generated column may only call IMMUTABLE functions, and the built-in
-- `array_to_string` is merely STABLE — Postgres cannot prove immutability for
-- arbitrary element types whose output function may depend on settings.
-- For `text[]` with a constant separator the result genuinely is deterministic,
-- so this narrow wrapper can be declared IMMUTABLE safely.
-- ----------------------------------------------------------------------------

create or replace function memorydb_tags_to_text(tags text[])
returns text
language sql
immutable
strict
parallel safe
as $$ select array_to_string(tags, ' ') $$;

-- ----------------------------------------------------------------------------
-- Memories
-- ----------------------------------------------------------------------------

create table if not exists memories (
  id             text primary key,
  namespace      text not null references namespaces (id) on delete cascade,

  user_id        text,
  agent_id       text,
  session_id     text,

  type           memory_type   not null default 'long_term',
  kind           memory_kind   not null default 'note',
  status         memory_status not null default 'active',

  content        text not null,
  summary        text,
  title          text,

  metadata       jsonb not null default '{}'::jsonb,
  tags           text[] not null default '{}',

  importance     real not null default 0.5 check (importance >= 0 and importance <= 1),
  confidence     real not null default 1.0 check (confidence >= 0 and confidence <= 1),

  -- 384 matches the default local provider. Change via migration + reindex when
  -- switching to a model with a different width.
  embedding      vector(384),
  embedding_model text,

  tokens         integer not null default 0,
  access_count   integer not null default 0,
  last_accessed_at timestamptz,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  expires_at     timestamptz,
  archived_at    timestamptz,

  superseded_by  text,
  source_id      text,
  content_hash   text not null,
  version        integer not null default 1,

  -- Generated tsvector keeps full-text search in sync without trigger code.
  -- Weights mirror the BM25 field boosts in the engine: title > summary > body.
  search_vector  tsvector generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(summary, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(memorydb_tags_to_text(tags), '')), 'B') ||
    setweight(to_tsvector('english', coalesce(content, '')), 'C')
  ) stored
);

-- Exact-duplicate detection. Partial: a soft-deleted twin must not block a
-- fresh write of the same content.
create unique index if not exists memories_namespace_hash_uniq
  on memories (namespace, content_hash)
  where status <> 'deleted';

-- Primary listing path: namespace scan ordered by recency.
create index if not exists memories_namespace_created_idx
  on memories (namespace, created_at desc)
  where status = 'active';

create index if not exists memories_namespace_type_idx  on memories (namespace, type)  where status = 'active';
create index if not exists memories_namespace_kind_idx  on memories (namespace, kind)  where status = 'active';
create index if not exists memories_namespace_user_idx  on memories (namespace, user_id) where user_id is not null;
create index if not exists memories_namespace_agent_idx on memories (namespace, agent_id) where agent_id is not null;
create index if not exists memories_session_idx         on memories (namespace, session_id) where session_id is not null;
create index if not exists memories_source_idx          on memories (namespace, source_id) where source_id is not null;
create index if not exists memories_importance_idx      on memories (namespace, importance desc) where status = 'active';

-- GIN for containment queries: tags @> ARRAY[...] and metadata @> '{...}'.
create index if not exists memories_tags_idx     on memories using gin (tags);
create index if not exists memories_metadata_idx on memories using gin (metadata jsonb_path_ops);
create index if not exists memories_search_idx   on memories using gin (search_vector);

-- Lets the TTL sweeper find due rows without scanning the table.
create index if not exists memories_expires_idx on memories (expires_at)
  where expires_at is not null and status <> 'deleted';

-- ----------------------------------------------------------------------------
-- Vector index
--
-- HNSW over cosine distance. Chosen over IVFFlat because it needs no training
-- step, handles incremental inserts without periodic reclustering, and gives
-- markedly better recall at the same latency — which matters here since
-- memories arrive continuously rather than in one bulk load.
--
-- m=16 / ef_construction=64 are the pgvector defaults and a sound balance of
-- build time, index size, and recall. Raise ef_search at query time to trade
-- latency for recall without rebuilding.
-- ----------------------------------------------------------------------------

create index if not exists memories_embedding_hnsw_idx
  on memories using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- ----------------------------------------------------------------------------
-- Knowledge graph
-- ----------------------------------------------------------------------------

create table if not exists entities (
  id              text primary key,
  namespace       text not null references namespaces (id) on delete cascade,
  type            entity_type not null default 'other',
  name            text not null,
  normalized_name text not null,
  aliases         text[] not null default '{}',
  description     text,
  metadata        jsonb not null default '{}'::jsonb,
  mention_count   integer not null default 0,
  salience        real not null default 0 check (salience >= 0 and salience <= 1),
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now()
);

-- Entity resolution key: one node per normalised name per namespace.
create unique index if not exists entities_namespace_normalized_uniq
  on entities (namespace, normalized_name);

create index if not exists entities_namespace_type_idx     on entities (namespace, type);
create index if not exists entities_namespace_mentions_idx on entities (namespace, mention_count desc);
-- Trigram index powers fuzzy "did you mean" entity search.
create index if not exists entities_name_trgm_idx on entities using gin (name gin_trgm_ops);

create table if not exists relations (
  id          text primary key,
  namespace   text not null references namespaces (id) on delete cascade,
  source_id   text not null references entities (id) on delete cascade,
  target_id   text not null references entities (id) on delete cascade,
  type        relation_type not null default 'related_to',
  weight      real not null default 0.5 check (weight >= 0 and weight <= 1),
  confidence  real not null default 0.5 check (confidence >= 0 and confidence <= 1),
  memory_ids  text[] not null default '{}',
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- An edge is identified by its endpoints and type, so repeated observations
  -- reinforce one row instead of creating parallel edges.
  constraint relations_unique_edge unique (namespace, source_id, target_id, type),
  constraint relations_no_self_loop check (source_id <> target_id)
);

create index if not exists relations_source_idx    on relations (namespace, source_id);
create index if not exists relations_target_idx    on relations (namespace, target_id);
create index if not exists relations_weight_idx    on relations (namespace, weight desc);
create index if not exists relations_memory_ids_idx on relations using gin (memory_ids);

-- ----------------------------------------------------------------------------
-- API keys
--
-- Only the SHA-256 digest is stored; the plaintext key is shown once at
-- creation and is unrecoverable thereafter.
-- ----------------------------------------------------------------------------

create table if not exists api_keys (
  id           text primary key,
  namespace    text not null references namespaces (id) on delete cascade,
  name         text not null,
  key_hash     text not null unique,
  -- First characters of the key, for identification in the UI. Never enough to
  -- reconstruct the secret.
  key_prefix   text not null,
  scopes       text[] not null default '{read,write}',
  owner_id     text,
  last_used_at timestamptz,
  expires_at   timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists api_keys_namespace_idx on api_keys (namespace);
create index if not exists api_keys_hash_idx      on api_keys (key_hash) where revoked_at is null;

-- ----------------------------------------------------------------------------
-- Retrieval analytics
--
-- Feeds the dashboard's search-history and latency panels. Deliberately append
-- only, with no FK to memories so purging a memory never blocks logging.
-- ----------------------------------------------------------------------------

create table if not exists retrieval_events (
  id            bigserial primary key,
  namespace     text not null,
  query         text not null,
  mode          text not null,
  result_count  integer not null default 0,
  top_score     real,
  took_ms       real not null default 0,
  token_budget  integer,
  tokens_used   integer,
  user_id       text,
  agent_id      text,
  created_at    timestamptz not null default now()
);

create index if not exists retrieval_events_namespace_time_idx
  on retrieval_events (namespace, created_at desc);

-- ----------------------------------------------------------------------------
-- Triggers
-- ----------------------------------------------------------------------------

create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists memories_touch_updated_at on memories;
create trigger memories_touch_updated_at
  before update on memories
  for each row execute function touch_updated_at();

drop trigger if exists namespaces_touch_updated_at on namespaces;
create trigger namespaces_touch_updated_at
  before update on namespaces
  for each row execute function touch_updated_at();

-- ----------------------------------------------------------------------------
-- Hybrid search
--
-- Runs both retrieval legs and fuses them with Reciprocal Rank Fusion inside
-- the database. Doing the fusion here rather than in the application avoids
-- shipping two full candidate sets over the wire, which dominates latency once
-- candidate pools get large.
-- ----------------------------------------------------------------------------

create or replace function hybrid_search(
  p_namespace     text,
  p_query         text,
  p_embedding     vector(384),
  p_limit         integer default 20,
  p_vector_weight real default 0.6,
  p_keyword_weight real default 0.4,
  p_rrf_k         integer default 60
)
returns table (id text, score real, vector_score real, keyword_score real)
language sql stable as $$
  with vector_hits as (
    select m.id,
           1 - (m.embedding <=> p_embedding) as similarity,
           row_number() over (order by m.embedding <=> p_embedding) as rank
    from memories m
    where m.namespace = p_namespace
      and m.status = 'active'
      and m.embedding is not null
      and (m.expires_at is null or m.expires_at > now())
    order by m.embedding <=> p_embedding
    limit p_limit * 4
  ),
  keyword_hits as (
    select m.id,
           ts_rank_cd(m.search_vector, websearch_to_tsquery('english', p_query)) as rank_score,
           row_number() over (
             order by ts_rank_cd(m.search_vector, websearch_to_tsquery('english', p_query)) desc
           ) as rank
    from memories m
    where m.namespace = p_namespace
      and m.status = 'active'
      and (m.expires_at is null or m.expires_at > now())
      and m.search_vector @@ websearch_to_tsquery('english', p_query)
    limit p_limit * 4
  )
  select
    coalesce(v.id, k.id) as id,
    (
      coalesce(p_vector_weight / (p_rrf_k + v.rank), 0) +
      coalesce(p_keyword_weight / (p_rrf_k + k.rank), 0)
    )::real as score,
    coalesce(v.similarity, 0)::real as vector_score,
    coalesce(k.rank_score, 0)::real as keyword_score
  from vector_hits v
  full outer join keyword_hits k on v.id = k.id
  order by score desc
  limit p_limit;
$$;

-- ----------------------------------------------------------------------------
-- Row-level security
--
-- Defence in depth: even a compromised or buggy service path cannot read across
-- namespaces, because the policy is enforced by the database. The service role
-- bypasses RLS by design and is the identity the server-side adapter uses.
-- ----------------------------------------------------------------------------

alter table namespaces        enable row level security;
alter table memories          enable row level security;
alter table entities          enable row level security;
alter table relations         enable row level security;
alter table api_keys          enable row level security;
alter table retrieval_events  enable row level security;

-- `current_setting('app.namespace', true)` is set per-connection by the adapter.
-- The `true` argument makes a missing setting return NULL rather than error.
do $$ begin
  create policy memories_namespace_isolation on memories
    for all
    using (namespace = current_setting('app.namespace', true))
    with check (namespace = current_setting('app.namespace', true));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy entities_namespace_isolation on entities
    for all
    using (namespace = current_setting('app.namespace', true))
    with check (namespace = current_setting('app.namespace', true));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy relations_namespace_isolation on relations
    for all
    using (namespace = current_setting('app.namespace', true))
    with check (namespace = current_setting('app.namespace', true));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy api_keys_namespace_isolation on api_keys
    for all
    using (namespace = current_setting('app.namespace', true))
    with check (namespace = current_setting('app.namespace', true));
exception when duplicate_object then null; end $$;

comment on table  memories               is 'Core memory store with hybrid vector + full-text retrieval.';
comment on column memories.search_vector is 'Generated tsvector; weights mirror the engine BM25 field boosts.';
comment on column memories.content_hash  is 'SHA-256 of normalised content; backs exact deduplication.';
comment on index  memories_embedding_hnsw_idx is 'HNSW cosine index; raise hnsw.ef_search for higher recall.';
