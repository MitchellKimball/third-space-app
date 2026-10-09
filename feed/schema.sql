-- Run once in Supabase → SQL Editor
create table if not exists feed_events (
  id bigint generated always as identity primary key,
  source text not null,            -- eventbrite | localist | ical
  source_id text not null,
  source_name text,
  title text not null,
  description text,
  start_at timestamptz not null,
  end_at timestamptz,
  venue text,
  address text,
  lat double precision,
  lng double precision,
  price text,
  link text,
  image text,
  category text,
  online boolean default false,
  status text not null default 'pending',   -- approved | pending | rejected
  fetched_at timestamptz default now(),
  unique (source, source_id)
);
alter table feed_events enable row level security;
drop policy if exists "read approved feed" on feed_events;
create policy "read approved feed" on feed_events for select to anon, authenticated using (status = 'approved');
-- The nightly job writes with the service role key, which bypasses RLS. Nobody else can write.
