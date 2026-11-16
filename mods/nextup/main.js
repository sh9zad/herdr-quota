// Next up: a countdown ring to your next calendar event (or the one you're in), a join button
// for its meeting link, and the rest of the day. Reads iCalendar feeds listed in
// ~/.config/herdr-mods/nextup.json (Google: Settings → your calendar → "Secret address in iCal
// format"). props.panel: the layout node to watch for hidden.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { home, readTextFile, props as blockProps } from "herdr";
import { C, ACCENT, COMPACT_BELOW, a, label, txt, gauge, frame, chip, sh, openUrl, panelHidden, hhmm } from "./hud.js";
import { parseICS, expand, tzids, meetingLink } from "./ics.js";

const CONFIG = "/.config/herdr-mods/nextup.json";
const HOUR = 3600000;
const WINDOWS_TZ = {
  "Pacific Standard Time": "America/Los_Angeles", "Mountain Standard Time": "America/Denver",
  "Central Standard Time": "America/Chicago", "Eastern Standard Time": "America/New_York",
  "GMT Standard Time": "Europe/London", "W. Europe Standard Time": "Europe/Berlin",
  "Romance Standard Time": "Europe/Paris", "Central European Standard Time": "Europe/Warsaw",
  "India Standard Time": "Asia/Kolkata", "Tokyo Standard Time": "Asia/Tokyo",
  "AUS Eastern Standard Time": "Australia/Sydney", "UTC": "UTC", "Coordinated Universal Time": "UTC",
};
const ianaOf = (tz) => { const t = String(tz).replace(/^\//, ""); return WINDOWS_TZ[t] ?? t; };

// Offsets for each TZID at 6-hour samples across the window, from the system's tz database.
const TZ_SCRIPT = `
sys=$(readlink /etc/localtime 2>/dev/null | sed 's|.*/zoneinfo/||'); [ -z "$sys" ] && sys=$(cat /etc/timezone 2>/dev/null)
echo "SYS $sys"
epochs="$1"; shift
for tz in "$@"; do
  [ -f "/usr/share/zoneinfo/$tz" ] || { echo "BAD $tz"; continue; }
  for e in $(echo "$epochs" | tr , ' '); do
    o=$(TZ="$tz" date -r "$e" +%z 2>/dev/null || TZ="$tz" date -d "@$e" +%z 2>/dev/null)
    echo "OFF $tz $e $o"
  done
done`;

async function tzTable(names, from, to) {
  const epochs = [];
  for (let t = from - 12 * HOUR; t <= to + 12 * HOUR; t += 6 * HOUR) epochs.push(Math.floor(t / 1000));
  const r = await sh(TZ_SCRIPT, [epochs.join(","), ...names], 20000);
  const table = { sys: null, off: {} };
  for (const line of (r.stdout ?? "").split("\n")) {
    const p = line.trim().split(" ");
    if (p[0] === "SYS") table.sys = p[1] ?? null;
    if (p[0] === "OFF" && p.length >= 4) {
      const m = /^([+-])(\d{2})(\d{2})$/.exec(p[3]);
      if (m) (table.off[p[1]] ??= []).push([Number(p[2]) * 1000, (m[1] === "-" ? -1 : 1) * (+m[2] * 60 + +m[3])]);
    }
  }
  return table;
}

function makeToUtc(table) {
  const local = (wall) => { const d = new Date(wall); return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()).getTime(); };
  return (wall, tz) => {
    if (tz === "UTC") return wall;
    if (!tz) return local(wall);
    const name = ianaOf(tz);
    if (name === "UTC") return wall;
    if (name === table.sys) return local(wall);
    const samples = table.off[name];
    if (!samples?.length) return local(wall); // unknown zone: assume it's ours
    let best = samples[0];
    for (const s of samples) if (Math.abs(s[0] - wall) < Math.abs(best[0] - wall)) best = s;
    return wall - best[1] * 60000;
  };
}

async function loadConfig() {
  try { const t = await readTextFile(home() + CONFIG); return t && t.trim() ? { ok: true, cfg: JSON.parse(t) } : { ok: true, cfg: null }; }
  catch (e) { return { ok: false }; }
}

async function loadEvents(cfg) {
  const now = Date.now(), from = now - 12 * HOUR, to = now + Math.max(6, Number(cfg.lookaheadHours) || 36) * HOUR;
  const cals = (cfg.calendars ?? []).filter((c) => c && c.enabled !== false && (c.ics || c.file));
  const parsed = [], errors = [];
  await Promise.all(cals.map(async (c) => {
    try {
      let text;
      if (c.file) text = await readTextFile(c.file.startsWith("~/") ? home() + c.file.slice(1) : c.file);
      else {
        const res = await fetch(c.ics.replace(/^webcal:/i, "https:"));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        text = await res.text();
      }
      parsed.push({ cal: c, events: parseICS(text ?? "") });
    } catch (e) { errors.push(`${c.name ?? "CALENDAR"}: ${String(e?.message ?? e).slice(0, 40)}`); }
  }));
  const names = [...new Set(parsed.flatMap((p) => tzids(p.events)).map(ianaOf))].filter((n) => n !== "UTC" && /^[\w+\-/]+$/.test(n));
  const toUtc = makeToUtc(await tzTable(names, from, to));
  const me = (cfg.me ?? []).map((x) => String(x).toLowerCase());
  const ignore = (cfg.ignore ?? []).map((p) => { try { return new RegExp(p, "i"); } catch { return null; } }).filter(Boolean);
  let list = [];
  for (const { cal, events } of parsed) {
    for (const o of expand(events, from, to, toUtc)) {
      if (cfg.hideAllDay !== false && o.allDay) continue;
      if (me.length && o.attendees.some((x) => me.includes(x.email) && x.partstat === "DECLINED")) continue;
      if (ignore.some((r) => r.test(o.summary))) continue;
      list.push({ ...o, cal: cal.name ?? "", link: meetingLink(o) });
    }
  }
  list.sort((x, y) => x.start - y.start);
  return { at: now, events: list, errors };
}

const fmtLeft = (ms) => {
  const m = Math.max(0, Math.ceil(ms / 60000));
  if (m < 60) return [String(m), "M"];
  if (m < 1440) return [`${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`, "H"];
  return [String(Math.floor(m / 1440)), "D"];
};
const durText = (ms) => { const m = Math.round(ms / 60000); return m < 60 ? `${m}M` : `${Math.floor(m / 60)}H${m % 60 ? ` ${m % 60}M` : ""}`; };

export default class NextUp extends View {
  init(props, cx) {
    this.panel = (props ?? blockProps() ?? {}).panel ?? null;
    this.width = 380;
    this.state = null; // { configured, events, errors, at }
    this.refresh(cx);
    cx.timer.every(30000, (cx) => {
      if (panelHidden(this.panel, "nextup")) return;
      const every = Math.max(2, Number(this.cfg?.refreshMinutes) || 10) * 60000;
      if (!this.busy && (!this.state || Date.now() - (this.state.at ?? 0) >= every)) this.refresh(cx);
      else cx.notify(); // countdowns
    });
  }

  refresh(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      await cx.sleep(0);
      cx.notify();
      try {
        const c = await loadConfig();
        if (!c.ok) { this.state = { configured: true, events: [], errors: ["BAD CONFIG JSON"], at: Date.now() }; return; }
        this.cfg = c.cfg;
        if (!c.cfg || !(c.cfg.calendars ?? []).length) { this.state = { configured: false, at: Date.now() }; return; }
        const r = await loadEvents(c.cfg);
        this.state = { configured: true, ...r };
      } catch (e) {
        this.state = { configured: true, events: this.state?.events ?? [], errors: [String(e?.message ?? e).slice(0, 60)], at: Date.now() };
      } finally { this.busy = false; cx.notify(); }
    });
  }

  render(cx) {
    const compact = this.width < COMPACT_BELOW, A = ACCENT.nextup, s = this.state, now = Date.now();
    const onSize = (size, cx) => { if (Math.abs(this.width - size.width) > 2) { this.width = size.width; cx.notify(); } };
    let body;
    if (!s) body = label("SYNCING", C.dim, 9).loop("opacity", { from: 0.3, to: 1, period: 1400 });
    else if (!s.configured) {
      body = compact ? v_flex().items_center().gap(4).child(txt("◌", 18, C.dim)).child(label("NO CAL", C.dim, 7.5))
        : v_flex().w_full().gap(6).py(4)
          .child(label("NO CALENDAR LINKED", C.warn, 9))
          .child(div().text_size(11).text_color(C.mid).child(`Add an iCal feed URL to ~${CONFIG} (see the repo README).`));
    } else {
      const evs = (s.events ?? []).filter((e) => e.end > now);
      const current = evs.filter((e) => e.start <= now);
      const upcoming = evs.filter((e) => e.start > now);
      const focus = current[0] ?? upcoming[0] ?? null;
      const later = (current.length ? upcoming : upcoming.slice(1)).slice(0, 4);
      if (!focus) {
        body = compact ? v_flex().items_center().gap(4).child(txt("✓", 18, C.ok)).child(label("CLEAR", C.dim, 7.5))
          : v_flex().w_full().items_center().py(10).gap(6).child(label("NO EVENTS AHEAD", C.ok, 9)).child(label(`NEXT ${Number(this.cfg?.lookaheadHours) || 36}H CLEAR`, C.dim, 8));
      } else {
        const live = focus.start <= now;
        const left = live ? focus.end - now : focus.start - now;
        const [val, unit] = fmtLeft(left);
        const fill = live ? ((now - focus.start) / Math.max(1, focus.end - focus.start)) * 100 : Math.max(0, 100 - (left / HOUR) * 100);
        const col = live ? C.ok : left <= 2 * 60000 ? C.crit : left <= 10 * 60000 ? C.warn : A;
        const size = compact ? 62 : 118;
        const ring = gauge({ id: "nu-ring", size, fill, value: val, unit, caption: live ? "REMAIN" : "T-MINUS", tag: live ? "LIVE" : "", color: col, compact, full: true });
        if (compact) {
          body = v_flex().w_full().items_center().gap(6).px(6)
            .child(focus.link ? div().id("nu-join").on_click(() => openUrl(focus.link)).hover((x) => x.opacity(0.85)).child(ring) : ring)
            .child(div().w_full().text_size(9.5).text_color(C.text).text_center().truncate().child(focus.summary))
            .child(label(hhmm(focus.start), C.dim, 7.5));
        } else {
          const details = v_flex().flex_1().min_w(0).gap(5)
            .child(label(live ? "IN PROGRESS" : "NEXT", live ? C.ok : C.mid, 8.5))
            .child(div().text_size(14).font_semibold().text_color(C.white).child(focus.summary))
            .child(txt(`${hhmm(focus.start)}–${hhmm(focus.end)} · ${durText(focus.end - focus.start)}`, 11, C.mid))
            .when(!!focus.location && !/^https?:/.test(focus.location), (e) => e.child(div().text_size(11).text_color(C.dim).truncate().child(focus.location)))
            .when(!!focus.cal, (e) => e.child(label(focus.cal, C.dim, 8)))
            .when(!!focus.link, (e) => e.child(h_flex().pt(2).child(
              h_flex().id("nu-join").h(24).px(10).gap(6).items_center().border(1).border_color(a(col, 0.6)).bg(a(col, 0.1))
                .hover((x) => x.bg(a(col, 0.2))).on_click(() => openUrl(focus.link))
                .child(div().w(5).h(5).rounded_full().bg(col).when(live || left < 10 * 60000, (d) => d.loop("opacity", { from: 0.3, to: 1, period: 1000 })))
                .child(label(live ? "REJOIN" : "JOIN", col, 8.5)))));
          body = v_flex().w_full().gap(14)
            .child(h_flex().w_full().gap(14).items_center().child(ring).child(details))
            .when(later.length > 0, (e) => e.child(v_flex().w_full().gap(2)
              .child(h_flex().w_full().justify_between().pb(2).child(label("LATER", C.mid, 8.5)).child(label(String(upcoming.length - (current.length ? 0 : 1)), A, 8.5)))
              .children(later.map((ev, i) => h_flex().id(`nu-l-${i}`).w_full().gap(10).py(5).px(6).items_center()
                .bg(i % 2 ? "#00000000" : a(C.plate, 0.8))
                .when(!!ev.link, (r) => r.hover((x) => x.bg(a(C.text, 0.05))).on_click(() => openUrl(ev.link)))
                .child(txt(hhmm(ev.start), 11, C.mid))
                .child(div().flex_1().min_w(0).text_size(12).text_color(C.text).truncate().child(ev.summary))
                .child(label(durText(ev.end - ev.start), C.dim, 8))))));
        }
      }
      if (!compact && s.errors?.length) body = v_flex().w_full().gap(8).child(body).children(s.errors.map((er) => label(`⚠ ${er}`, C.warn, 8)));
    }
    return frame({
      title: "CHRONO", sub: "NEXT UP", accent: A, compact, compactTag: "CAL", onSize, id: "nextup-root", hide: "nextup",
      right: chip("nu-sync", this.busy ? "◐ SYNC" : `↻ ${hhmm(now)}`, (_e, cx) => this.refresh(cx)),
      body,
    });
  }
}
