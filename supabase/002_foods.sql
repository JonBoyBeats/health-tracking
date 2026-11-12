-- Step 2: the shared food list, and links from log entries to the food and amount eaten.
-- Run once in Supabase: SQL Editor -> New query -> paste this file -> Run.

-- Every food either of us has logged from a search or scan. Searched first next time.
create table public.foods (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  brand text,
  barcode text,
  source text not null,          -- usda, off (Open Food Facts), manual
  source_id text,                -- the food's id in that source
  calories numeric not null default 0,   -- nutrients per 100 g (or 100 ml)
  protein numeric not null default 0,
  carbs numeric not null default 0,
  fat numeric not null default 0,
  fiber numeric not null default 0,
  servings jsonb not null default '[]',  -- [{ "label": "1 slice (40 g)", "grams": 40 }]
  is_estimate boolean not null default false,
  search_text text generated always as (lower(name || ' ' || coalesce(brand, ''))) stored,
  created_by uuid references auth.users on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  unique (source, source_id)
);

create index foods_barcode on public.foods (barcode);
create index foods_recent on public.foods (last_used_at desc);

alter table public.log_entries
  add column food_id uuid references public.foods on delete set null,
  add column amount numeric,
  add column unit text,
  add column grams numeric;

alter table public.foods enable row level security;
create policy household on public.foods for all to authenticated using (true) with check (true);
grant select, insert, update, delete on public.foods to authenticated;
