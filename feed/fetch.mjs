// Comuna nightly event feed.
// Pulls upcoming events from the sources in sources.json, keeps the ones inside the area,
// drops things that aren't really events, and upserts them into Supabase `feed_events`.
//   DRY_RUN=1 node feed/fetch.mjs   → prints what it would save, writes nothing
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, EVENTBRITE_TOKEN (all GitHub secrets)
import { readFileSync } from 'node:fs';

const cfg = JSON.parse(readFileSync(new URL('./sources.json', import.meta.url)));
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, EVENTBRITE_TOKEN } = process.env;
const DRY = !!process.env.DRY_RUN;
const [W, S, E, N] = cfg.area.bbox;
const now = new Date(), until = new Date(Date.now() + cfg.area.days_ahead * 864e5);

const getJSON = async (url, headers = {}) => { const r = await fetch(url, { headers }); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); };
const strip = t => String(t || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

// ---------- what counts as an event ----------
// "A special thing happening" — not a business simply being open.
const NOT_EVENT = /\b(happy hour|open daily|business hours|now open|grand opening sale|daily specials?|gift cards?|appointment only|office hours)\b/i;
function category(t) {
  t = t.toLowerCase();
  return /comedy|improv|stand-?up|theat|drag|cabaret/.test(t) ? 'comedy'
    : /film|screening|movie|cinema/.test(t) ? 'film'
    : /run club|\brun\b|yoga|pilates|meditat|sound bath|wellness|breathwork/.test(t) ? 'wellness'
    : /book|author|reading|talk|lecture|workshop|class|course|learn|seminar|panel/.test(t) ? 'workshops'
    : /market|fair|pop-?up shop|vendor|flea|sale/.test(t) ? 'markets'
    : /concert|music|jazz|band|dj|choir|orchestra|art|gallery|exhibit/.test(t) ? 'music'
    : /hike|beach|garden|nature|cleanup|bird/.test(t) ? 'outdoors'
    : /trivia|game|chess|pickleball|volleyball|tournament/.test(t) ? 'sports'
    : /tasting|dinner|brunch|wine|beer|food|cook/.test(t) ? 'food'
    : /meetup|mixer|social|networking|club/.test(t) ? 'social'
    : 'community';
}
const inArea = (lat, lng) => lat == null || lng == null || (lng >= W && lng <= E && lat >= S && lat <= N);
const inWindow = d => d && d >= new Date(now.getTime() - 6 * 36e5) && d <= until;

// ---------- sources ----------
async function eventbrite(src) {
  if (!EVENTBRITE_TOKEN) { console.warn('skip Eventbrite: no EVENTBRITE_TOKEN'); return []; }
  const out = []; let url = `https://www.eventbriteapi.com/v3/organizers/${src.id}/events/?status=live&order_by=start_asc&expand=venue,ticket_availability`;
  while (url) {
    const j = await getJSON(url, { Authorization: `Bearer ${EVENTBRITE_TOKEN}` });
    for (const e of j.events || []) {
      const v = e.venue || {}, a = v.address || {};
      out.push({ source: 'eventbrite', source_id: e.id, source_name: src.name, trusted: !!src.trusted,
        title: e.name?.text, description: strip(e.description?.text || e.summary).slice(0, 600),
        start_at: e.start?.utc, end_at: e.end?.utc, venue: v.name || src.name, address: a.localized_address_display || '',
        lat: v.latitude ? +v.latitude : null, lng: v.longitude ? +v.longitude : null,
        price: e.is_free ? 'Free' : 'Paid', link: e.url, image: e.logo?.url || null, online: !!e.online_event });
    }
    url = j.pagination?.has_more_items ? `https://www.eventbriteapi.com/v3/organizers/${src.id}/events/?status=live&order_by=start_asc&expand=venue,ticket_availability&continuation=${j.pagination.continuation}` : null;
  }
  return out;
}

async function localist(src) {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const j = await getJSON(`${src.base}/api/2/events?days=${cfg.area.days_ahead}&pp=100&page=${page}`);
    for (const { event: e } of j.events || []) {
      const inst = e.event_instances?.[0]?.event_instance || {};
      out.push({ source: 'localist', source_id: `${e.id}-${inst.id || ''}`, source_name: src.name, trusted: !!src.trusted,
        title: e.title, description: strip(e.description_text || e.description).slice(0, 600),
        start_at: inst.start, end_at: inst.end, venue: e.location_name || src.name, address: e.address || e.location || '',
        lat: e.geo?.latitude ? +e.geo.latitude : null, lng: e.geo?.longitude ? +e.geo.longitude : null,
        price: e.free ? 'Free' : (e.ticket_cost ? 'Paid' : ''), link: e.localist_url || e.url, image: e.photo_url || null, online: e.experience === 'virtual' });
    }
    if (!j.page || page >= j.page.total) break;
  }
  return out;
}

// minimal iCalendar reader (Luma calendars and most venue calendars export .ics)
function parseICS(text) {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/), evs = []; let cur = null;
  const val = l => l.slice(l.indexOf(':') + 1).replace(/\\n/g, '\n').replace(/\\([,;\\])/g, '$1');
  const date = l => { const v = val(l); const m = v.match(/^(\d{4})(\d\d)(\d\d)(?:T(\d\d)(\d\d)(\d\d)(Z)?)?/); if (!m) return null;
    if (!m[4]) return new Date(`${m[1]}-${m[2]}-${m[3]}T12:00:00-08:00`);
    // times without Z are local LA time
    return m[7] ? new Date(Date.UTC(m[1], m[2] - 1, m[3], m[4], m[5], m[6])) : new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${laOffset(+m[1], +m[2], +m[3])}`); };
  for (const l of lines) {
    if (l === 'BEGIN:VEVENT') cur = {}; else if (l === 'END:VEVENT') { if (cur) evs.push(cur); cur = null; }
    else if (cur) { const k = l.split(/[;:]/)[0];
      if (k === 'SUMMARY') cur.title = val(l); else if (k === 'DESCRIPTION') cur.description = val(l); else if (k === 'LOCATION') cur.location = val(l);
      else if (k === 'URL') cur.url = val(l); else if (k === 'UID') cur.uid = val(l); else if (k === 'DTSTART') cur.start = date(l); else if (k === 'DTEND') cur.end = date(l);
      else if (k === 'GEO') { const [a, b] = val(l).split(/[;,]/).map(Number); cur.lat = a; cur.lng = b; } }
  }
  return evs;
}
function laOffset(y, m, d) { // PDT (-07:00) from 2nd Sunday of March to 1st Sunday of November, else PST
  const nth = (mo, n) => { const f = new Date(Date.UTC(y, mo - 1, 1)).getUTCDay(); return 1 + ((7 - f) % 7) + 7 * (n - 1); };
  const t = m * 100 + d, s = 300 + nth(3, 2), e = 1100 + nth(11, 1); return t >= s && t < e ? '-07:00' : '-08:00';
}
async function ical(src) {
  const r = await fetch(src.url); if (!r.ok) throw new Error(`${r.status} ${src.url}`);
  return parseICS(await r.text()).map(e => {
    const loc = e.location || '', parts = loc.split(',');
    return { source: 'ical', source_id: `${src.name}:${e.uid || e.title + e.start?.toISOString()}`, source_name: src.name, trusted: !!src.trusted,
      title: e.title, description: strip(e.description).slice(0, 600), start_at: e.start?.toISOString(), end_at: e.end?.toISOString(),
      venue: src.venue || (parts.length > 2 ? parts[0] : src.name), address: src.address || loc, lat: e.lat ?? null, lng: e.lng ?? null,
      price: /free/i.test(e.description || '') ? 'Free' : '', link: e.url || src.link || null, image: null, online: /zoom\.us|google meet|online/i.test(loc) };
  });
}

// ---------- run ----------
export async function run() {
  const jobs = [
    ...cfg.eventbrite_organizers.map(s => ['Eventbrite ' + s.name, () => eventbrite(s)]),
    ...cfg.localist.map(s => ['Calendar ' + s.name, () => localist(s)]),
    ...cfg.ical.map(s => ['iCal ' + s.name, () => ical(s)]),
  ];
  let all = [];
  for (const [name, fn] of jobs) {
    try { const got = await fn(); console.log(`${name}: ${got.length} raw`); all.push(...got); }
    catch (e) { console.warn(`${name} failed: ${e.message}`); }   // one broken source never stops the rest
  }
  const seen = new Set();
  const keep = all.filter(e => {
    const d = e.start_at && new Date(e.start_at);
    if (!e.title || !inWindow(d) || e.online || !inArea(e.lat, e.lng)) return false;
    if (!e.address && e.lat == null) return false;                      // can't put it on the map
    if (NOT_EVENT.test(`${e.title} ${e.description}`)) return false;
    const k = e.title.toLowerCase().replace(/\W+/g, '') + '|' + d.toISOString().slice(0, 10); if (seen.has(k)) return false; seen.add(k);
    return true;
  }).map(e => ({ ...e, category: category(`${e.title} ${e.description}`), status: e.trusted ? 'approved' : 'pending', fetched_at: new Date().toISOString() }));
  keep.forEach(e => delete e.trusted);
  console.log(`keeping ${keep.length} of ${all.length}`);

  if (DRY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    if (!DRY) console.warn('No Supabase secrets set: dry run only.');
    keep.slice(0, 40).forEach(e => console.log(`  ${e.start_at.slice(0, 16)}  [${e.status}] [${e.category}] ${e.title} @ ${e.venue}`));
    return keep;
  }
  for (let i = 0; i < keep.length; i += 200) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/feed_events?on_conflict=source,source_id`, { method: 'POST',
      headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify(keep.slice(i, i + 200)) });
    if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  }
  console.log(`saved ${keep.length} events to Supabase`);
  return keep;
}
if (import.meta.url === `file://${process.argv[1]}`) run().catch(e => { console.error(e); process.exit(1); });
