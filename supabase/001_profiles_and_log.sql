-- Step 1: people, their daily targets, and the food log.
-- Run once in Supabase: SQL Editor -> New query -> paste this file -> Run.

-- One row per login. Created automatically when a user is added in Authentication.
create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  name text not null default '',
  target_calories numeric not null default 2000,
  target_protein numeric not null default 150,
  target_carbs numeric not null default 200,
  target_fat numeric not null default 65,
  target_fiber numeric not null default 30,
  created_at timestamptz not null default now()
);

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, name) values (new.id, split_part(new.email, '@', 1));
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Users added before this script ran get a profile too.
insert into public.profiles (id, name)
select id, split_part(email, '@', 1) from auth.users
on conflict (id) do nothing;

-- Everything eaten. Nutrients are stored as eaten, so later edits to a food never change past days.
create table public.log_entries (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references public.profiles on delete cascade,
  logged_by uuid references auth.users on delete set null default auth.uid(),
  eaten_on date not null,
  meal text not null check (meal in ('breakfast', 'lunch', 'dinner', 'snack')),
  description text not null,
  calories numeric not null default 0,
  protein numeric not null default 0,
  carbs numeric not null default 0,
  fat numeric not null default 0,
  fiber numeric not null default 0,
  is_estimate boolean not null default false,
  created_at timestamptz not null default now()
);

create index log_entries_day on public.log_entries (eaten_on, person_id);

-- Household access: public sign-up is off, so the only signed-in users are the two of us,
-- and both of us can see and log everything. Signed-out visitors get nothing.
alter table public.profiles enable row level security;
alter table public.log_entries enable row level security;

create policy household on public.profiles for all to authenticated using (true) with check (true);
create policy household on public.log_entries for all to authenticated using (true) with check (true);

grant select, insert, update, delete on public.profiles, public.log_entries to authenticated;
