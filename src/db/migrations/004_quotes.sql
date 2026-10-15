-- Quotes (src/quotes/): made in a call from what he confirmed (the quote_send tool), sent as
-- a PDF into his WhatsApp chat. `data` is the whole quote (items, totals, the business as it
-- was), so the PDF can be made again exactly; no file is kept. Numbered per org and year.
create table quotes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs (id) on delete cascade,
  user_id uuid references users (id) on delete set null,
  call_id text,
  number text not null,
  lang text not null,
  data jsonb not null,
  status text not null default 'saved' check (status in ('saved', 'sent', 'failed')),
  sent_to text,
  message_id text,
  error text,
  created_at timestamptz not null default now(),
  unique (org_id, number)
);
create index quotes_call on quotes (call_id);
alter table quotes enable row level security;
