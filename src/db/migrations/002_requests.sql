-- Admin requests (phase 5): Max's instruction, the plan he approved, and what came
-- of it. The request follows its objective; notify_status is the outbox for telling him.

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
  created_by text not null default 'admin',
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  closed_at timestamptz,
  notify_status text not null default 'none' check (notify_status in ('none', 'pending', 'sent', 'failed')),
  notify_attempts int not null default 0,
  notify_error text,
  notified_at timestamptz,
  updated_at timestamptz not null default now()
);
create index requests_recent on requests (created_at desc);
create index requests_objective on requests (objective_id);
create index requests_notify on requests (notify_status) where notify_status in ('pending', 'failed');
alter table requests enable row level security;
