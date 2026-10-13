-- Outbound calls (phase 6): one job per user and errand, claimed by the scheduler with
-- FOR UPDATE SKIP LOCKED. A job only ever dials a users row (consent, window, pause
-- are checked against it); there is no way to dial a raw number.

create table call_jobs (
  id text primary key,
  org_id uuid not null references orgs (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  objective_ids text[] not null,
  status text not null default 'queued' check (status in ('queued', 'dialing', 'in_call', 'done', 'failed', 'cancelled')),
  attempts int not null default 0,
  max_attempts int not null default 3,
  next_attempt_at timestamptz not null default now(),
  call_id text,          -- the current or last attempt's call
  carrier text,
  outcome text,          -- the last attempt: answered, no-answer, busy, voicemail, declined, later, completed, …
  log jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index call_jobs_due on call_jobs (status, next_attempt_at);
create index call_jobs_call on call_jobs (call_id);
alter table call_jobs enable row level security;

-- What happened to a request on the way (couldn't reach him, moved to his next call, …).
alter table requests add column log jsonb not null default '[]';
