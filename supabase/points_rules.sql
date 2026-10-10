-- Comuna: points rules (run once in Supabase > SQL Editor; safe to re-run).
--  Save it:  Interested or RSVP +10. Only your first 5 saves each day earn points.
--  Go:       verified check-in +100 (the app confirmed you were within 600 m)
--              +50 the first time you check in at that place
--              +25 if you saved the event before you went
--              +10 for rating it afterward
--  Share it: approved event you added +25 (first 3 each week),
--              plus +25 for each other person who checks in to it (max 500 per event).
--  Duplicates: set status = 'duplicate' (or 'rejected') instead of 'approved'; they earn nothing.
--  Gift cards: 3+ verified check-ins this month (gift_card_eligible column).

alter table checkins add column if not exists distance_m int;
alter table rsvps    add column if not exists kind text default 'interested';

create or replace view leaderboard_month as
with m as (select date_trunc('month', now()) as start),
saves as (
  select user_id,
         row_number() over (partition by user_id, (created_at at time zone 'America/Los_Angeles')::date order by created_at) as n
  from rsvps, m where created_at >= m.start
),
verified as (   -- all-time verified check-ins, numbered per place so we know your first visit
  select c.*, row_number() over (partition by c.user_id, coalesce(c.venue, c.event_id) order by c.created_at) as visit_n
  from checkins c where c.distance_m <= 600
),
goes as (
  select v.user_id, v.event_id,
         100
         + case when v.visit_n = 1 then 50 else 0 end
         + case when exists (select 1 from rsvps r where r.user_id = v.user_id and r.event_id = v.event_id and r.created_at < v.created_at) then 25 else 0 end
           as p
  from verified v, m where v.created_at >= m.start
),
rated as (      -- one rating per event you actually went to
  select distinct f.user_id, f.event_id
  from feedback f, m
  where f.kind = 'event' and f.created_at >= m.start
    and exists (select 1 from verified v where v.user_id = f.user_id and v.event_id = f.event_id)
),
subs as (
  select id, user_id,
         row_number() over (partition by user_id, date_trunc('week', created_at) order by created_at) as n
  from event_submissions, m
  where status = 'approved' and created_at >= m.start
),
turnout as (    -- other people who went to events you added (app event ids look like SUB-123)
  select s.user_id,
         least(500, 25 * (select count(*) from verified v, m
                          where v.event_id = 'SUB-' || s.id and v.user_id <> s.user_id and v.created_at >= m.start)) as p
  from event_submissions s where s.status = 'approved'
),
pts as (
  select user_id, 10 as p, 0 as ci from saves where n <= 5
  union all
  select user_id, p, 1 from goes
  union all
  select user_id, 10, 0 from rated
  union all
  select user_id, 25, 0 from subs where n <= 3
  union all
  select user_id, p, 0 from turnout where p > 0
)
select pr.id as user_id,
       split_part(coalesce(pr.name,'Explorer'),' ',1)
         || coalesce(' ' || upper(left(nullif(split_part(pr.name,' ',array_length(string_to_array(pr.name,' '),1)),split_part(pr.name,' ',1)),1)) || '.', '') as display_name,
       pr.neighborhood,
       sum(pts.p)::int  as points,
       sum(pts.ci)::int as checkins,
       sum(pts.ci) >= 3 as gift_card_eligible
from pts join profiles pr on pr.id = pts.user_id
group by pr.id, pr.name, pr.neighborhood;

grant select on leaderboard_month to anon, authenticated;
