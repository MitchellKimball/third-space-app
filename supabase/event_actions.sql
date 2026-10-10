-- Comuna: per-event view and tap tracking (for host stats).
-- Run once in Supabase > SQL Editor.

create table if not exists public.event_actions (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  event_id     text not null,
  event_title  text,
  action       text not null check (action in
                 ('view','interested','rsvp','directions','calendar','link','invite','checkin')),
  neighborhood text,
  category     text,
  created_at   timestamptz not null default now()
);
create index if not exists event_actions_event_idx on public.event_actions (event_id, created_at);

-- Users can only add their own rows; nobody can read raw rows from the app.
alter table public.event_actions enable row level security;
drop policy if exists "insert own actions" on public.event_actions;
create policy "insert own actions" on public.event_actions
  for insert to authenticated with check (auth.uid() = user_id);

-- Summary for you and Mitchell (read it in the Supabase dashboard).
create or replace view public.event_stats with (security_invoker = true) as
select event_id,
       max(event_title)                                              as event_title,
       count(*) filter (where action = 'view')                       as views,
       count(distinct user_id) filter (where action = 'view')        as unique_viewers,
       count(*) filter (where action in ('interested','rsvp'))       as interested,
       count(*) filter (where action = 'directions')                 as directions,
       count(*) filter (where action = 'calendar')                   as calendar_adds,
       count(*) filter (where action = 'link')                       as link_clicks,
       count(*) filter (where action = 'invite')                     as invites,
       count(*) filter (where action = 'checkin')                    as checkins,
       max(created_at)                                               as last_activity
from public.event_actions
group by event_id;
