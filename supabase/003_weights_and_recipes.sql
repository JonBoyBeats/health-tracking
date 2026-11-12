-- Step 4: body weight, and recipes.
-- Run once in Supabase: SQL Editor -> New query -> paste this file -> Run.

-- One weight per person per day, in pounds.
create table public.weights (
  person_id uuid not null references public.profiles on delete cascade,
  measured_on date not null,
  pounds numeric not null check (pounds > 0),
  created_at timestamptz not null default now(),
  primary key (person_id, measured_on)
);

alter table public.weights enable row level security;
create policy household on public.weights for all to authenticated using (true) with check (true);
grant select, insert, update, delete on public.weights to authenticated;

-- A recipe is a saved food (source 'recipe') whose nutrients come from its ingredients:
-- [{ "food_id": ..., "name": ..., "amount": 2, "unit": "1 large (50 g)", "grams": 100,
--    "calories": ..., "protein": ..., "carbs": ..., "fat": ..., "fiber": ... }]
alter table public.foods add column ingredients jsonb;
