// A small iCalendar (RFC 5545) reader: enough for real-world Google / Outlook / iCloud feeds.
// Handles folded lines, TZID / UTC / floating / all-day times, RRULE (DAILY, WEEKLY, MONTHLY,
// YEARLY with INTERVAL, COUNT, UNTIL, BYDAY incl. ordinals, BYMONTHDAY), EXDATE, RECURRENCE-ID
// overrides and cancellations. The mod runtime has no Intl, so the caller supplies
// `toUtc(wallMs, tzid)`: wallMs is the wall-clock time encoded as if it were UTC.

const DAY = 86400000;
const WD = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

export function parseICS(text) {
  const lines = text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const events = [];
  let cur = null, depth = 0;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { cur = { exdates: [], attendees: [] }; depth = 0; continue; }
    if (!cur) continue;
    if (line.startsWith("BEGIN:")) { depth++; continue; } // VALARM etc.
    if (line.startsWith("END:")) { if (line === "END:VEVENT" && depth === 0) { events.push(cur); cur = null; } else depth--; continue; }
    if (depth > 0) continue;
    const p = prop(line);
    if (!p) continue;
    switch (p.name) {
      case "UID": cur.uid = p.value; break;
      case "SUMMARY": cur.summary = unescape(p.value); break;
      case "LOCATION": cur.location = unescape(p.value); break;
      case "DESCRIPTION": cur.description = unescape(p.value); break;
      case "URL": cur.url = p.value; break;
      case "STATUS": cur.status = p.value.toUpperCase(); break;
      case "DTSTART": cur.start = time(p); break;
      case "DTEND": cur.end = time(p); break;
      case "DURATION": cur.duration = duration(p.value); break;
      case "RRULE": cur.rrule = rrule(p.value); break;
      case "EXDATE": for (const v of p.value.split(",")) cur.exdates.push(time({ ...p, value: v })); break;
      case "RECURRENCE-ID": cur.recurrenceId = time(p); break;
      case "ATTENDEE": cur.attendees.push({ email: p.value.replace(/^mailto:/i, "").toLowerCase(), partstat: (p.params.PARTSTAT ?? "").toUpperCase() }); break;
    }
  }
  return events.filter((e) => e.start);
}

function prop(line) {
  let i = 0, q = false;
  for (; i < line.length; i++) { const ch = line[i]; if (ch === '"') q = !q; else if (ch === ":" && !q) break; }
  if (i >= line.length) return null;
  const head = line.slice(0, i).split(";"), params = {};
  for (const kv of head.slice(1)) { const j = kv.indexOf("="); if (j > 0) params[kv.slice(0, j).toUpperCase()] = kv.slice(j + 1).replace(/^"|"$/g, ""); }
  return { name: head[0].toUpperCase(), params, value: line.slice(i + 1) };
}
const unescape = (s) => s.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");

// { wall, tz, utc, allDay }: wall is the wall clock as a UTC-encoded ms; utc set when it's "Z".
function time(p) {
  const v = p.value.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(v);
  if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  const allDay = !m[4] || p.params.VALUE === "DATE";
  return { wall, allDay, z: !!m[7], tz: m[7] ? "UTC" : p.params.TZID ?? null };
}
function duration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return null;
  const ms = (((+(m[2] ?? 0) * 7 + +(m[3] ?? 0)) * 24 + +(m[4] ?? 0)) * 60 + +(m[5] ?? 0)) * 60000 + +(m[6] ?? 0) * 1000;
  return m[1] === "-" ? -ms : ms;
}
function rrule(v) {
  const r = {};
  for (const part of v.split(";")) { const [k, x] = part.split("="); if (k && x != null) r[k.toUpperCase()] = x; }
  return {
    freq: r.FREQ, interval: Math.max(1, +(r.INTERVAL ?? 1)), count: r.COUNT ? +r.COUNT : null,
    until: r.UNTIL ? time({ value: r.UNTIL, params: {} }) : null,
    byday: r.BYDAY ? r.BYDAY.split(",").map((d) => { const m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(d.trim()); return m ? { n: m[1] ? +m[1] : 0, wd: WD[m[2]] } : null; }).filter(Boolean) : null,
    bymonthday: r.BYMONTHDAY ? r.BYMONTHDAY.split(",").map(Number) : null,
    bymonth: r.BYMONTH ? r.BYMONTH.split(",").map(Number) : null,
  };
}

// Every TZID the events use, so the caller can look their offsets up in one go.
export function tzids(events) {
  const s = new Set();
  for (const e of events) for (const t of [e.start, e.end, e.recurrenceId, ...e.exdates]) if (t?.tz && t.tz !== "UTC") s.add(t.tz);
  return [...s];
}

// Occurrences overlapping [from, to]: [{ start, end, allDay, summary, location, description, url, uid, attendees }]
export function expand(events, from, to, toUtc) {
  const abs = (t) => (t.z ? t.wall : toUtc(t.wall, t.allDay ? null : t.tz));
  const overrides = new Map(); // uid|utc → override event
  for (const e of events) if (e.recurrenceId && e.uid) overrides.set(`${e.uid}|${abs(e.recurrenceId)}`, e);
  const out = [];
  const push = (e, start) => {
    const len = e.end ? abs(e.end) - abs(e.start) : e.duration != null ? e.duration : e.start.allDay ? DAY : 0;
    const end = start + Math.max(0, len);
    if (end >= from && start <= to && e.status !== "CANCELLED") {
      out.push({ start, end, allDay: e.start.allDay, summary: e.summary ?? "(no title)", location: e.location ?? "",
        description: e.description ?? "", url: e.url ?? "", uid: e.uid, attendees: e.attendees });
    }
  };
  for (const e of events) {
    if (e.recurrenceId) { push(e, abs(e.start)); continue; }
    if (!e.rrule) { push(e, abs(e.start)); continue; }
    const ex = new Set(e.exdates.filter(Boolean).map(abs));
    const until = e.rrule.until ? (e.rrule.until.z ? e.rrule.until.wall : toUtc(e.rrule.until.wall, e.start.tz)) : Infinity;
    let n = 0;
    for (const wall of occurrences(e.start.wall, e.rrule)) {
      const start = toUtc(wall, e.start.allDay ? null : e.start.z ? "UTC" : e.start.tz);
      if (start > until || start > to) break;
      n++;
      if (e.rrule.count && n > e.rrule.count) break;
      if (ex.has(start)) continue;
      const o = overrides.get(`${e.uid}|${start}`);
      if (o) continue; // the override was pushed on its own (or cancelled)
      push(e, start);
    }
  }
  return out.sort((x, y) => x.start - y.start);
}

// Wall-clock candidates in order, starting at dtstart. Capped so a bad rule can't spin.
function* occurrences(dt, r) {
  const d0 = new Date(dt), tod = dt - Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), d0.getUTCDate());
  const dayStart = (ms) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
  let guard = 0;
  const MAX = 50000;
  if (r.freq === "DAILY") {
    for (let k = 0; guard++ < MAX; k += r.interval) {
      const w = dt + k * DAY;
      if (r.byday && !r.byday.some((b) => b.wd === new Date(w).getUTCDay())) continue;
      if (r.bymonth && !r.bymonth.includes(new Date(w).getUTCMonth() + 1)) continue;
      yield w;
    }
  } else if (r.freq === "WEEKLY") {
    const days = (r.byday ?? [{ wd: d0.getUTCDay() }]).map((b) => (b.wd + 6) % 7).sort((x, y) => x - y); // Monday = 0
    const monday = dayStart(dt) - ((d0.getUTCDay() + 6) % 7) * DAY;
    for (let wk = 0; guard++ < MAX; wk += r.interval) {
      for (const off of days) {
        const w = monday + (wk * 7 + off) * DAY + tod;
        if (w >= dt) yield w;
      }
    }
  } else if (r.freq === "MONTHLY" || r.freq === "YEARLY") {
    const y0 = d0.getUTCFullYear(), m0 = d0.getUTCMonth();
    const step = r.freq === "MONTHLY" ? r.interval : 12 * r.interval;
    for (let k = 0; guard++ < MAX / 10; k += step) {
      const y = y0 + Math.floor((m0 + k) / 12), m = (m0 + k) % 12;
      if (r.bymonth && !r.bymonth.includes(m + 1)) continue;
      const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      let dates = [];
      if (r.byday && r.byday.length) {
        for (const b of r.byday) {
          const all = [];
          for (let d = 1; d <= dim; d++) if (new Date(Date.UTC(y, m, d)).getUTCDay() === b.wd) all.push(d);
          if (b.n > 0) { if (all[b.n - 1]) dates.push(all[b.n - 1]); } else if (b.n < 0) { if (all[all.length + b.n]) dates.push(all[all.length + b.n]); } else dates.push(...all);
        }
      } else if (r.bymonthday) {
        dates = r.bymonthday.map((d) => (d < 0 ? dim + d + 1 : d)).filter((d) => d >= 1 && d <= dim);
      } else {
        const d = d0.getUTCDate();
        if (d <= dim) dates = [d];
      }
      for (const d of [...new Set(dates)].sort((x, y) => x - y)) {
        const w = Date.UTC(y, m, d) + tod;
        if (w >= dt) yield w;
      }
    }
  } else {
    yield dt;
  }
}

const MEETING = /https?:\/\/(?:[\w-]+\.)*(?:meet\.google\.com|zoom\.us|teams\.microsoft\.com|teams\.live\.com|webex\.com|whereby\.com|around\.co|chime\.aws)\/[^\s<>"')]+/i;
export function meetingLink(ev) {
  for (const s of [ev.location, ev.url, ev.description]) { const m = MEETING.exec(s ?? ""); if (m) return m[0]; }
  return null;
}
