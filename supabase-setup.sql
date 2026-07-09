-- ============================================================
-- Calibre — Supabase setup (run in the SQL Editor of your project)
--
-- ⚠️ IMPORTANT: this replaces the old insecure table.
-- The old schema used a single shared row (id = 'main') writable
-- by the anon key, meaning ANYONE on the internet could read and
-- overwrite your data. The new schema stores one row per signed-in
-- user, protected by Row Level Security.
--
-- Your existing data is safe: it also lives in your browser's
-- localStorage, and the app uploads it automatically the first
-- time you sign in on that browser.
-- ============================================================

-- 1. Remove the old insecure table
drop table if exists public.calibre_data;

-- 2. New table: one row per user
create table public.calibre_data (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  data        jsonb not null,
  updated_at  timestamptz not null default now()
);

-- 3. Row Level Security: users can only touch their own row.
--    With RLS enabled and no matching policy, the anon key gets nothing.
alter table public.calibre_data enable row level security;

create policy "select own row"
  on public.calibre_data for select
  using (auth.uid() = user_id);

create policy "insert own row"
  on public.calibre_data for insert
  with check (auth.uid() = user_id);

create policy "update own row"
  on public.calibre_data for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ============================================================
-- Also do these two things in the Supabase dashboard:
--
-- A) Authentication → Sign In / Up → make sure "Email" is enabled
--    (magic links / OTP — it is on by default).
--
-- B) Authentication → URL Configuration → set your Site URL to
--    https://calibre-app-mu.vercel.app and add it to the redirect
--    allow-list, so magic links land back on the app.
-- ============================================================
