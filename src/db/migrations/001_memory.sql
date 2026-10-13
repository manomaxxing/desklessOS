-- Memory v2 (phase 4): orgs and users, contacts, calls, notes, facts, tasks,
-- objectives, the pilot's research state, tool runs. Every table carries
-- org_id. Row level security is on with no policies: only the server (service
-- role, which bypasses RLS) reads and writes; Supabase's public API sees nothing.

create schema if not exists extensions;
create extension if not exists vector with schema extensions;
create extension if not exists pg_trgm with schema extensions;
create extension if not exists unaccent with schema extensions;

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

create table calls (
  id text primary key, -- Dial's call id
  org_id uuid not null references orgs (id) on delete cascade,
  user_id uuid references users (id) on delete set null,
  direction text not null default 'inbound',
  from_e164 text,
  to_e164 text,
  lang text,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  ended_reason text,
  transcript jsonb not null default '[]',
  call_type text not null default '',
  summary text not null default '',
  cost jsonb,
  -- the post-call memory step: pending → done | failed (retried) | skipped
  consolidation_status text not null default 'pending' check (consolidation_status in ('pending', 'done', 'failed', 'skipped')),
  consolidation_attempts int not null default 0,
  consolidation_error text,
  consolidated_at timestamptz,
  job jsonb, -- what that step needs (note id, lang, date) while it's not done
  created_at timestamptz not null default now()
);
create index calls_to_consolidate on calls (consolidation_status, ended_at) where consolidation_status in ('pending', 'failed');
create index calls_user on calls (user_id, started_at desc);

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
create index notes_call on notes (call_id);

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
