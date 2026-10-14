-- The demo (src/memory/pg.mjs, ensureDemoUser): one user, in an org of its own, that the
-- online test phone and Max's own number reach. Its calls are saved and summarised like any
-- other, into its own memory; it gets no research questions, and nobody's memory gets its calls.
alter table users add column demo boolean not null default false;
