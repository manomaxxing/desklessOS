-- Who can log in to the admin page (src/admin/team.mjs). An owner invites someone by
-- email; they set their name and password on the link (it works once, for 7 days).
-- Passwords are scrypt hashes; an invite is kept as the SHA-256 of its token.
-- session_version ends someone's sessions: a new password bumps it, removal deletes the row.
create table members (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text not null default '',
  role text not null default 'member' check (role in ('owner', 'member')),
  password_hash text,
  invite_hash text unique,
  invite_expires_at timestamptz,
  session_version int not null default 0,
  invited_by text not null default '',
  last_login_at timestamptz,
  created_at timestamptz not null default now()
);
alter table members enable row level security;

-- The call's summary for the dashboard (src/calls/recap.mjs): title, overview, topics,
-- action items, open questions. Written by the after-call job, or on demand.
alter table calls add column recap jsonb;
