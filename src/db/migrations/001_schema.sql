-- The whole schema. Postgres is the only state: the app servers keep nothing that
-- outlives a call, so any instance can serve any request.
--   people and memory   orgs, users, contacts, calls (+ call_contacts), notes, facts, tasks
--   what the agent brings  objectives, research_state, requests (Max's), outbound_calls
--   plumbing            jobs (the queue for all background work), voice_clips, tool_runs
-- Row level security is on with no policies: only the server's own login (it owns the
-- tables, so RLS doesn't apply to it) reads and writes; Supabase's public API sees nothing.
-- The tables go into the first schema on the search path (DB_SCHEMA, src/db/client.mjs).

-- The extensions, unless they're there already: on a shared Supabase project an admin
-- enables them once, and the app's own login can't create extensions.
do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'extensions') then create schema extensions; end if;
  if not exists (select 1 from pg_extension where extname = 'vector') then create extension vector with schema extensions; end if;
  if not exists (select 1 from pg_extension where extname = 'pg_trgm') then create extension pg_trgm with schema extensions; end if;
  if not exists (select 1 from pg_extension where extname = 'unaccent') then create extension unaccent with schema extensions; end if;
end $$;

-- Lowercase without accents, for name matching ("Müller" = "muller"). unaccent()
-- isn't immutable on its own, so indexes go through this wrapper.
create or replace function norm(t text) returns text language sql immutable parallel safe
  as $$ select lower(extensions.unaccent('extensions.unaccent'::regdictionary, coalesce(t, ''))) $$;

create table orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table users (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs (id) on delete cascade,
  name text not null,
  phone_e164 text unique,
  role text not null default 'owner' check (role in ('owner', 'staff', 'admin')),
  lang text not null default 'de',
  langs text[] not null default '{}',
  timezone text not null default 'Europe/Berlin',
  call_window jsonb not null default '{}',
  consent_outbound_at timestamptz,
  outbound_paused boolean not null default false,
  profile jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table contacts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs (id) on delete cascade,
  name text not null,
  aliases text[] not null default '{}',
  company text not null default '',
  email text not null default '',
  phone text not null default '',
  address text not null default '',
  place text not null default '',
  summary text not null default '',
  last_contact date,
  legacy_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, legacy_id)
);
create index contacts_name_trgm on contacts using gin (norm(name || ' ' || place) extensions.gin_trgm_ops);
create index contacts_recent on contacts (org_id, last_contact desc nulls last);

-- Every call with a known caller, from the first turn on. The session saves its transcript and
-- the latest note extraction as it goes (so a lost instance loses nothing), and the
-- after-call job (src/calls/after-call.mjs) does the rest from this row.
create table calls (
  id text primary key, -- the carrier's call id
  org_id uuid references orgs (id) on delete cascade,
  user_id uuid references users (id) on delete set null,
  direction text not null default 'inbound',
  source text not null default '', -- dial | twilio | dev | fake
  from_e164 text,
  to_e164 text,
  lang text,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  ended_reason text,
  transcript jsonb not null default '[]',
  extraction jsonb, -- the latest note extraction: his note, the agenda's answers, consent (outbound)
  extraction_turns int not null default 0, -- how many turns of the transcript it covers
  objective_ids text[] not null default '{}', -- what was on this call's agenda
  timeline jsonb not null default '[]', -- the monitor's events
  meta jsonb not null default '{}', -- mode, cost
  call_type text not null default '',
  summary text not null default '',
  consolidated_at timestamptz, -- memory step done (it runs once, however often it's tried)
  after_call_at timestamptz, -- every after-call step done
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index calls_user on calls (user_id, started_at desc);
create index calls_recent on calls (started_at desc);
create index calls_open on calls (started_at) where ended_at is null;

create table call_contacts (
  call_id text not null references calls (id) on delete cascade,
  contact_id uuid not null references contacts (id) on delete cascade,
  primary key (call_id, contact_id)
);
create index call_contacts_contact on call_contacts (contact_id);

create table notes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs (id) on delete cascade,
  user_id uuid references users (id) on delete set null,
  call_id text,
  contact_id uuid references contacts (id) on delete set null,
  mode text not null default '',
  lang text not null default '',
  data jsonb not null, -- the template's output: customer_name, work, next_steps, summary, …
  summary text not null default '',
  embedding extensions.vector(768),
  legacy_id text,
  created_at timestamptz not null default now(),
  unique (org_id, legacy_id)
);
create index notes_contact on notes (contact_id, created_at desc);
create index notes_recent on notes (org_id, created_at desc);
create unique index notes_one_per_call on notes (call_id); -- the after-call step may run twice

-- What we know, with where it came from. Never overwritten: a newer fact supersedes an older one.
create table facts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs (id) on delete cascade,
  user_id uuid references users (id) on delete cascade,
  subject text not null check (subject in ('user', 'contact', 'org')),
  contact_id uuid references contacts (id) on delete cascade,
  kind text not null default 'fact',
  text text not null,
  quote text not null default '',
  tags text[] not null default '{}',
  confidence real not null default 1,
  source_call_id text,
  valid_from timestamptz not null default now(),
  superseded_by uuid references facts (id),
  embedding extensions.vector(768),
  legacy_id text,
  created_at timestamptz not null default now(),
  unique (org_id, legacy_id)
);
create index facts_current on facts (org_id, subject, created_at desc) where superseded_by is null;
create index facts_tags on facts using gin (tags);

create table tasks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs (id) on delete cascade,
  user_id uuid references users (id) on delete cascade,
  contact_id uuid references contacts (id) on delete set null,
  contact_name text not null default '',
  text text not null,
  due date,
  status text not null default 'open' check (status in ('open', 'done')),
  done_at timestamptz,
  done_call_id text,
  source_call_id text,
  legacy_id text,
  created_at timestamptz not null default now(),
  unique (org_id, legacy_id)
);
create index tasks_open on tasks (org_id, status, due);

create table objectives (
  id text primary key,
  org_id uuid not null references orgs (id) on delete cascade,
  user_id uuid references users (id) on delete cascade,
  template text not null,
  version int not null default 1,
  params jsonb not null default '{}',
  mode text not null default 'next_inbound',
  status text not null default 'pending' check (status in ('pending', 'done', 'expired', 'cancelled')),
  priority int not null default 0,
  lang text,
  result jsonb,
  attempts int not null default 0,
  max_attempts int not null default 3,
  calls text[] not null default '{}',
  not_before timestamptz,
  deadline timestamptz,
  created_by text not null default 'admin',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index objectives_pending on objectives (user_id, status, priority desc, created_at);

-- The pilot's research (config/discovery.json): which questions were asked and
-- answered, and which calls asked one. Its findings are facts tagged area:/hyp:/stance:.
create table research_state (
  user_id uuid primary key references users (id) on delete cascade,
  org_id uuid not null references orgs (id) on delete cascade,
  questions jsonb not null default '{}',
  calls jsonb not null default '[]',
  updated_at timestamptz not null default now()
);

-- Every tool run that changed something, for the audit trail (idempotency itself is per call, in memory).
create table tool_runs (
  key text primary key, -- callId:name:hash(input)
  org_id uuid references orgs (id) on delete cascade,
  call_id text,
  name text not null,
  args jsonb,
  status text not null,
  result jsonb,
  created_at timestamptz not null default now()
);

-- Max's requests (src/admin/requests.mjs): his instruction, the plan he approved, and
-- what came of it. The request follows its objective.
create table requests (
  id text primary key,
  org_id uuid references orgs (id) on delete cascade,
  user_id uuid references users (id) on delete set null, -- who gets asked
  instruction text not null,
  plan jsonb not null,
  plan_hash text not null,
  card jsonb not null,
  turns jsonb not null default '[]', -- Max's answers to clarifications, in order
  status text not null default 'draft' check (status in ('draft', 'approved', 'done', 'expired', 'cancelled')),
  objective_id text references objectives (id) on delete set null,
  result jsonb,
  log jsonb not null default '[]', -- what happened on the way (couldn't reach him, moved to his next call, …)
  created_by text not null default 'admin',
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  closed_at timestamptz,
  notified_at timestamptz,
  updated_at timestamptz not null default now()
);
create index requests_recent on requests (created_at desc);
create index requests_objective on requests (objective_id);

-- Outbound calls (src/jobs/scheduler.mjs): one errand per user, with its tries. Claimed
-- with FOR UPDATE SKIP LOCKED. It only ever dials a users row (consent, window, pause
-- are checked against it); there is no way to dial a raw number.
create table outbound_calls (
  id text primary key,
  org_id uuid not null references orgs (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  objective_ids text[] not null,
  status text not null default 'queued' check (status in ('queued', 'dialing', 'in_call', 'done', 'failed', 'cancelled')),
  attempts int not null default 0,
  max_attempts int not null default 3,
  next_attempt_at timestamptz not null default now(),
  call_id text, -- the current or last try's call
  carrier text,
  outcome text, -- the last try: answered, no-answer, busy, voicemail, declined, later, completed, …
  log jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index outbound_calls_due on outbound_calls (status, next_attempt_at);
create index outbound_calls_call on outbound_calls (call_id);

-- All background work (src/jobs/queue.mjs): at least once, retried with backoff, then
-- "dead" for a human to look at. `key` makes enqueueing idempotent ("after_call:<call id>").
-- A running job holds a lease (locked_until); a crashed worker's job is taken again after it.
create table jobs (
  id bigint generated always as identity primary key,
  kind text not null,
  key text not null unique,
  payload jsonb not null default '{}',
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'dead')),
  attempts int not null default 0,
  max_attempts int not null default 5,
  run_at timestamptz not null default now(),
  locked_until timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index jobs_due on jobs (run_at) where status in ('queued', 'running');

-- Pre-recorded lines (greeting, fillers, …) by hash of model, voice and text: a new
-- instance loads them in one query instead of synthesising them again (cold starts).
create table voice_clips (
  key text primary key,
  pcm bytea not null,
  created_at timestamptz not null default now()
);

alter table orgs enable row level security;
alter table users enable row level security;
alter table contacts enable row level security;
alter table calls enable row level security;
alter table call_contacts enable row level security;
alter table notes enable row level security;
alter table facts enable row level security;
alter table tasks enable row level security;
alter table objectives enable row level security;
alter table research_state enable row level security;
alter table tool_runs enable row level security;
alter table requests enable row level security;
alter table outbound_calls enable row level security;
alter table jobs enable row level security;
alter table voice_clips enable row level security;
