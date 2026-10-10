-- Comuna: points rules (run once in Supabase > SQL Editor; safe to re-run).
--  Interested +10, RSVP +25: only your first 5 saves each day earn points.
--  Verified check-in +100: only when the app confirmed you were there (within 600 m).
--  Approved event you added +25: only your first 3 each week.
--  Turnout bonus on events you added: +5 per person Interested, +25 per verified check-in (max 500 per event).
--  Duplicates: set status = 'duplicate' (or 'rejected') instead of 'approved'; they earn nothing.
--  Gift cards: 3+ verified check-ins this month (gift_card_eligible column).

alter table checkins add column if not exists distance_m int;
alter table rsvps    add column if not exists kind text default 'interested';

create or replace view leaderboard_month as
with m as (select date_trunc('month', now()) as start),
saves as (
  select user_id, kind,
         row_number() over (partition by user_id, (created_at at time zone 'America/Los_Angeles')::date order by created_at) as n
  from rsvps, m where created_at >= m.start
),
good_checkins as (
  select * from checkins, m where created_at >= m.start and distance_m <= 600
),
subs as (
  select id, user_id,
         row_number() over (partition by user_id, date_trunc('week', created_at) order by created_at) as n
  from event_submissions, m
  where status = 'approved' and created_at >= m.start
),
turnout as (   -- other people's activity on events you added (app event ids look like SUB-123)
  select s.user_id,
         least(500,
           5  * (select count(*) from rsvps r, m where r.event_id = 'SUB-' || s.id and r.user_id <> s.user_id and r.created_at >= m.start)
         + 25 * (select count(*) from good_checkins c where c.event_id = 'SUB-' || s.id and c.user_id <> s.user_id)
         ) as p
  from event_submissions s where s.status = 'approved'
),
pts as (
  select user_id, case when kind = 'rsvp' then 25 else 10 end as p, 0 as ci from saves where n <= 5
  union all
  select user_id, 100, 1 from good_checkins
  union all
  select user_id, 25, 0  from subs where n <= 3
  union all
  select user_id, p, 0   from turnout where p > 0
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
