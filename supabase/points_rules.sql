-- Comuna: points rules so the leaderboard can't be gamed with submissions.
-- Run once in Supabase > SQL Editor (replaces the leaderboard_month view).
--  * Only your first 3 approved event submissions each week earn points.
--  * Duplicates: mark them status = 'duplicate' (not 'approved') in event_submissions, so they earn nothing.
--  * Check-ins only count when the app confirmed you were there (distance_m within 600 m).
--  * Gift cards: only people with 3+ confirmed check-ins this month qualify (see the gift_card_eligible column).

-- how far (meters) the phone was from the event when checking in; filled in by the app
alter table checkins add column if not exists distance_m int;

create or replace view leaderboard_month as
with subs as (
  select user_id,
         row_number() over (partition by user_id, date_trunc('week', created_at) order by created_at) as n
  from event_submissions
  where status = 'approved' and created_at >= date_trunc('month', now())
),
pts as (
  select user_id, 10 as p, 0 as ci from rsvps    where created_at >= date_trunc('month', now())
  union all
  select user_id, 50, 1            from checkins where created_at >= date_trunc('month', now()) and distance_m <= 600
  union all
  select user_id, 25, 0            from subs     where n <= 3
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
