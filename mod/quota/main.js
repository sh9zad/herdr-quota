// Quota telemetry: what's left of each Claude and Codex subscription window.
// Accounts: ~/.config/herdr-quota/accounts.json, or this machine's default logins (see data.js).
// Roles (props.role): the panel (default), or "toggle", the tab-bar readout that shows/hides
// the layout's "quota-panel" node. The toggle is always drawn, so it does the polling and
// publishes through shared state; the panel only reads (and can force a resync).
import { View, div, PathBuilder, Background } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, shared, setShared, layout, settings, props as blockProps } from "herdr";
import { KEY, CONFIG_PATH, loadAccounts, read, pace, span, windowLabel } from "./data.js";

const PANEL = "quota-panel";
const TICK = 30 * 1000;             // countdown refresh in the panel

// ---- Palette: a deep-space instrument panel ----
const C = {
  void: "#080B10",
  hull: "#0C1118",
  plate: "#101722",
  line: "#1B2533",
  lineHi: "#2A3850",
  dim: "#5B6C82",
  mid: "#8C9DB4",
  text: "#D6E2F0",
  white: "#F4F8FF",
  ok: "#4BE3A4",
  warn: "#FFB547",
  crit: "#FF5A5F",
};
const ACCENT = { claude: "#FF9E6B", codex: "#6CD6FF" };
const a = (hex, alpha) => hex + Math.round(Math.max(0, Math.min(1, alpha)) * 255).toString(16).padStart(2, "0");
const mono = () => settings().font_family || "Menlo";
const track = (s) => s; // mono caps carry the look; spaced glyphs read too loose

const level = (remain, accent) => remain <= 10 ? C.crit : remain <= 25 ? C.warn : accent;
const STATE_COLOR = { NOMINAL: C.ok, ELEVATED: C.warn, OVERBURN: C.crit, DEPLETED: C.crit };

// ---- Canvas geometry ----
const rad = (d) => (d * Math.PI) / 180;
const pt = (c, r, deg) => [c + r * Math.cos(rad(deg)), c + r * Math.sin(rad(deg))];
const START = 135, SWEEP = 270; // a 270° dial open at the bottom, filling clockwise

function arc(c, r, from, to, width) {
  const s = pt(c, r, from), e = pt(c, r, to);
  return PathBuilder.stroke(width).move_to(s[0], s[1]).arc_to(r, r, 0, to - from > 180, true, e[0], e[1]).build();
}
function ticks(c, r1, r2, majorR, step, width) {
  const b = PathBuilder.stroke(width);
  for (let p = 0; p <= 100; p += step) {
    const deg = START + (SWEEP * p) / 100, inner = p % 10 === 0 ? majorR : r1;
    const s = pt(c, inner, deg), e = pt(c, r2, deg);
    b.move_to(s[0], s[1]).line_to(e[0], e[1]);
  }
  return b.build();
}
function radial(c, r1, r2, deg, width) {
  const s = pt(c, r1, deg), e = pt(c, r2, deg);
  return PathBuilder.stroke(width).move_to(s[0], s[1]).line_to(e[0], e[1]).build();
}
const RECT = () => PathBuilder.fill().move_to("0%", "0%").line_to("100%", "0%").line_to("100%", "100%").line_to("0%", "100%").close().build();
const layer = (path, bg) => window.paint_path(path, bg).absolute().top(0).left(0).size_full();
const fade = (color, angle = 90) => layer(RECT(), Background.linear_gradient(angle, Background.stop(a(color, 0.55), 0), Background.stop(a(color, 0), 100)));

// ---- Pieces ----

// HUD corner brackets around a box.
function brackets(color, len = 9) {
  const corner = (v, h) => {
    let el = div().absolute().w(len).h(len).border_color(color);
    el = v === "t" ? el.top(-1).border_t(1) : el.bottom(-1).border_b(1);
    return h === "l" ? el.left(-1).border_l(1) : el.right(-1).border_r(1);
  };
  return [corner("t", "l"), corner("t", "r"), corner("b", "l"), corner("b", "r")];
}

function label(text, color = C.dim, size = 10) {
  size = Math.max(9.5, size + 1);
  return div().font_family(mono()).text_size(size).text_color(color).whitespace_nowrap().child(track(text));
}

function dial(id, w, accent, size, now) {
  const c = size / 2, r = c - 12;
  const remain = Math.max(0, Math.min(100, 100 - w.used));
  const col = level(remain, accent);
  const end = START + (SWEEP * remain) / 100;
  const p = pace(w, now);
  const el = div().id(id).relative().w(size).h(size).flex_none()
    // fine graduation ring
    .child(layer(ticks(c, r + 5, r + 8, r + 3, 2, 1), a(C.lineHi, 0.9)))
    // decorative inner ring
    .child(layer(arc(c, r - 13, START, START + SWEEP, 1), a(C.line, 1)))
    // track
    .child(layer(arc(c, r, START, START + SWEEP, 3), C.line));
  if (remain > 0.4) {
    el.child(layer(arc(c, r, START, end, 11), Background.solid(col).opacity(0.10)))
      .child(layer(arc(c, r, START, end, 6), Background.solid(col).opacity(0.22)))
      .child(layer(arc(c, r, START, end, 2.5), col))
      .child(layer(radial(c, r - 6, r + 9, end, 2), C.white)); // needle tip
  }
  // ghost marker: where an even burn would leave you now
  if (p.expected != null) el.child(layer(radial(c, r - 5, r + 5, START + (SWEEP * (100 - p.expected)) / 100, 1.5), a(C.mid, 0.9)));
  return el
    .child(v_flex().absolute().top(0).left(0).size_full().items_center().justify_center().gap(1)
      .child(h_flex().items_end().gap(1)
        .child(div().font_family(mono()).text_size(size * 0.24).font_light().text_color(C.white).child(String(Math.round(remain))))
        .child(div().font_family(mono()).text_size(11).text_color(C.mid).pb(4).child("%")))
      .child(label("LEFT", C.dim, 8.5)))
    .child(h_flex().absolute().bottom(4).left(0).w_full().justify_center()
      .child(div().font_family(mono()).text_size(10).text_color(col).child(windowLabel(w.minutes))));
}

function readout(w, accent, now) {
  const p = pace(w, now);
  const stateCol = STATE_COLOR[p.state] ?? C.mid;
  const row = (k, v, vc = C.text) => h_flex().w_full().justify_between().items_center()
    .child(label(k, C.dim, 8.5)).child(div().font_family(mono()).text_size(11.5).text_color(vc).child(v));
  return v_flex().w_full().gap(3).px(2)
    .child(h_flex().justify_center().pb(2).child(label(w.label, C.mid, 9.5)))
    .child(row("RESET", w.resetsAt ? `T−${span(w.resetsAt - now)}` : w.stale ? "ROLLED" : "--"))
    .child(row("USED", `${Math.round(w.used)}%`))
    .child(row("PACE", p.state, stateCol))
    .when(p.projected != null, (el) => el.child(row("AT RESET", `≈${Math.min(999, Math.round(p.projected))}%`, p.projected >= 100 ? C.crit : C.mid)));
}

// A slim bar for model-scoped caps.
function bar(w, accent) {
  const remain = Math.max(0, 100 - w.used), col = level(remain, accent);
  return v_flex().w_full().gap(4)
    .child(h_flex().justify_between().child(label(w.label, C.mid, 9)).child(label(`${Math.round(remain)}% REMAIN`, col, 9)))
    .child(div().relative().w_full().h(4).bg(C.line)
      .child(div().absolute().top(0).left(0).h_full().w(`${remain}%`).bg(col)));
}

function statusPill(s, now) {
  let col = C.ok, text = "LINKED";
  if (!s) { col = C.dim; text = "ACQUIRING"; }
  else if (!s.ok) { col = C.crit; text = "FAULT"; }
  else if (s.seen && now - s.seen > 3600 * 1000) { col = C.warn; text = "CACHED"; }
  const dot = div().w(5).h(5).rounded_full().bg(col);
  return h_flex().gap(6).items_center().px(7).h(18).border(1).border_color(a(col, 0.35)).bg(a(col, 0.06))
    .child(s?.ok ? dot.loop("opacity", { from: 0.25, to: 1, period: 2400 }) : dot)
    .child(label(text, col, 8.5));
}

function card(id, name, provider, accent, s, now, width) {
  const inner = Math.max(240, width - 32 - 28);
  const size = Math.max(104, Math.min(150, Math.floor((inner - 14) / 2)));
  const head = h_flex().w_full().items_center().justify_between()
    .child(h_flex().items_center().gap(8)
      .child(div().w(7).h(7).bg(accent))
      .child(div().font_family(mono()).text_size(12.5).font_semibold().text_color(C.white).child(track(name)))
      .child(label(s?.plan ? `· ${s.plan}` : "", C.dim, 9.5)))
    .child(statusPill(s, now));
  const rule = div().relative().w_full().h(1).child(fade(accent));

  let body;
  if (!s) {
    body = v_flex().w_full().h(size).items_center().justify_center().gap(6)
      .child(label("ESTABLISHING UPLINK", C.dim, 9.5).loop("opacity", { from: 0.3, to: 1, period: 1400 }));
  } else if (!s.ok) {
    body = v_flex().w_full().py(22).items_center().justify_center().gap(6)
      .child(div().font_family(mono()).text_size(18).text_color(C.crit).child("⚠"))
      .child(label(s.error ?? "NO SIGNAL", C.crit, 9.5));
  } else {
    body = v_flex().w_full().gap(14)
      .child(h_flex().w_full().justify_around().items_start().gap(14).children(
        s.windows.slice(0, 2).map((w, i) => v_flex().items_center().gap(8).w(size)
          .child(dial(`${id}-dial-${i}`, w, accent, size, now))
          .child(readout(w, accent, now)))))
      .when((s.extra ?? []).length > 0, (el) => el.child(v_flex().w_full().gap(10).pt(4).children(s.extra.map((w) => bar(w, accent)))));
  }

  const foot = h_flex().w_full().justify_between()
    .child(label(s?.seen ? `SIGNAL ${span(now - s.seen)} AGO` : s?.at ? `SYNC ${clock(s.at)}` : "", C.dim, 8))
    .child(label(provider === "claude" ? "LIVE API" : "SESSION LOG", a(C.dim, 0.8), 8));

  return div().id(id).relative().w_full().bg(C.plate).border(1).border_color(C.line)
    .children(brackets(a(accent, 0.7)))
    .child(div().absolute().top(0).left(0).w(3).h(28).bg(accent))
    .child(v_flex().w_full().p(14).pl(16).gap(12).child(head).child(rule).child(body).child(foot));
}

const clock = (t) => { const d = new Date(t); return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":"); };

function find(node, id) {
  if (!node) return null;
  if (node.id === id) return node;
  for (const ch of node.children ?? []) { const f = find(ch, id); if (f) return f; }
  return null;
}

// ---- Shared state ----
// shared(KEY) = { accounts: [{id, provider, name}], source, error, poll, readings: { [id]: reading } }

const getState = () => shared(KEY) ?? {};
const publish = (patch) => setShared(KEY, { ...getState(), ...patch });
function publishReading(id, reading) {
  const st = getState();
  setShared(KEY, { ...st, readings: { ...(st.readings ?? {}), [id]: reading } });
}

// Reload the account list, then read every account (or only one provider's).
async function pollAll(provider) {
  const cfg = await loadAccounts();
  publish({ accounts: cfg.accounts, source: cfg.source, error: cfg.error ?? null, poll: cfg.poll });
  await Promise.all(cfg.accounts.filter((a) => !provider || a.provider === provider)
    .map(async (a) => publishReading(a.id, await read(a))));
  return cfg;
}

// ---- View ----

export default class Quota extends View {
  init(props, cx) {
    this.role = props?.role ?? blockProps()?.role ?? "panel";
    this.width = 380;
    this.busy = false;
    if (this.role === "toggle") {
      // One loop per provider; intervals come from the config and are re-read every round.
      cx.spawn(async (cx) => {
        const cfg = await pollAll();
        let wait = Math.max(30, Number(cfg.poll.codexSeconds) || 60) * 1000;
        for (;;) { await cx.sleep(wait); const c = await pollAll("codex"); wait = Math.max(30, Number(c.poll.codexSeconds) || 60) * 1000; }
      });
      cx.spawn(async (cx) => {
        let wait = 180000;
        for (;;) {
          await cx.sleep(wait);
          const c = await pollAll("claude");
          wait = Math.max(60, Number(c.poll.claudeSeconds) || 180) * 1000;
        }
      });
    } else {
      cx.timer.every(TICK, (cx) => cx.notify());
      if (!getState().readings) this.resync(cx);
    }
  }

  resync(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      await cx.sleep(0);
      cx.notify();
      try { await pollAll(); } finally { this.busy = false; cx.notify(); }
    });
  }

  render(cx) {
    return this.role === "toggle" ? this.renderToggle() : this.renderPanel(cx);
  }

  renderToggle() {
    const st = getState(), node = find(layout(), PANEL), on = node && !node.hidden;
    const accounts = st.accounts ?? [], readings = st.readings ?? {};
    // Per provider, the lowest "left" across its accounts' shortest window.
    const lowest = (provider) => {
      const vals = accounts.filter((a) => a.provider === provider).map((a) => readings[a.id])
        .filter((r) => r?.ok && r.windows[0]).map((r) => Math.max(0, 100 - r.windows[0].used));
      return vals.length ? Math.min(...vals) : null;
    };
    const num = (v, accent) => div().font_family(mono()).text_size(11).text_color(v == null ? C.dim : level(v, accent)).child(v == null ? "--" : String(Math.round(v)));
    const tag = (t) => div().font_family(mono()).text_size(9).text_color(C.dim).child(t);
    const has = (p) => accounts.some((a) => a.provider === p);
    const parts = [];
    for (const [p, t] of [["claude", "CL"], ["codex", "CX"]]) {
      if (!has(p)) continue;
      if (parts.length) parts.push(div().w(1).h(12).bg(C.lineHi));
      parts.push(div().w(6).h(6).rounded_full().bg(ACCENT[p]), tag(t), num(lowest(p), ACCENT[p]));
    }
    if (!parts.length) parts.push(tag("QUOTA"));
    return h_flex().size_full().pr(10).items_center().justify_end()
      .child(h_flex().id("toggle-quota").h(26).px(9).gap(6).flex_none().items_center().rounded(6)
        .border(1).border_color(on ? a(ACCENT.codex, 0.35) : "#00000000")
        .bg(on ? a(ACCENT.codex, 0.08) : "#00000000")
        .hover((s) => s.bg(a(C.text, 0.06)))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => run("layout.toggle", { id: PANEL }))
        .children(parts));
  }

  renderPanel(cx) {
    const st = getState(), now = Date.now();
    const accounts = st.accounts ?? [], readings = st.readings ?? {};
    const all = accounts.map((x) => readings[x.id]).filter((x) => x?.ok).flatMap((x) => x.windows);
    const worst = all.length ? Math.min(...all.map((w) => 100 - w.used)) : null;
    const overall = st.error ? [st.error, C.crit]
      : worst == null ? ["ACQUIRING", C.dim]
      : worst <= 10 ? ["CRITICAL", C.crit] : worst <= 25 ? ["LOW RESERVES", C.warn] : ["ALL SYSTEMS NOMINAL", C.ok];

    const header = v_flex().w_full().gap(10).px(16).pt(14).pb(12).border_b(1).border_color(C.line)
      .child(h_flex().w_full().items_center().justify_between()
        .child(h_flex().items_center().gap(10)
          .child(div().relative().w(14).h(14).border(1).border_color(a(ACCENT.codex, 0.8))
            .child(div().absolute().top(4).left(4).w(4).h(4).bg(ACCENT.codex).loop("opacity", { from: 0.3, to: 1, period: 1800 })))
          .child(div().font_family(mono()).text_size(13).font_semibold().text_color(C.white).child("QUOTA"))
          .child(div().font_family(mono()).text_size(13).text_color(C.dim).child("//"))
          .child(div().font_family(mono()).text_size(13).text_color(C.mid).child("RESERVES")))
        .child(h_flex().items_center().gap(4)
          .child(h_flex().id("resync").h(22).px(8).items_center().gap(5).border(1).border_color(C.lineHi)
            .hover((s) => s.bg(a(C.text, 0.06)).border_color(C.mid))
            .on_click((_e, cx) => this.resync(cx))
            .child(this.busy
              ? div().font_family(mono()).text_size(10).text_color(ACCENT.codex).frames(["◐", "◓", "◑", "◒"], 120)
              : div().font_family(mono()).text_size(10).text_color(C.mid).child("↻"))
            .child(label("RESYNC", C.mid, 8.5)))
          .child(h_flex().id("close").w(22).h(22).items_center().justify_center()
            .hover((s) => s.bg(a(C.text, 0.06)))
            .on_click(() => run("layout.hide", { id: PANEL }))
            .child(div().text_size(12).text_color(C.dim).child("✕")))))
      .child(h_flex().w_full().items_center().justify_between()
        .child(h_flex().items_center().gap(6)
          .child(div().w(5).h(5).bg(overall[1]))
          .child(label(overall[0], overall[1], 9)))
        .child(label(`T ${clock(now)}`, C.dim, 9)));

    const cards = accounts.map((acc) =>
      card(acc.id, String(acc.name).toUpperCase(), acc.provider, ACCENT[acc.provider], readings[acc.id], now, this.width));
    if (!cards.length && st.accounts) {
      cards.push(v_flex().w_full().p(16).gap(8).bg(C.plate).border(1).border_color(C.line)
        .child(label("NO ACCOUNTS DETECTED", C.warn, 9.5))
        .child(label(`LOG IN TO CLAUDE CODE OR CODEX, OR LIST ACCOUNTS IN ${CONFIG_PATH}`, C.dim, 8)));
    }

    return v_flex().id("root").size_full().bg(C.hull).relative()
      .on_size_change((size, cx) => { if (Math.abs((this.width ?? 0) - size.width) > 2) { this.width = size.width; cx.notify(); } })
      .child(layer(RECT(), Background.pattern_slash(a(C.text, 0.018), 1, 7)))
      .child(header)
      .child(v_flex().id("scroll").flex_1().w_full().overflow_y_scrollbar().px(16).pt(10).pb(16).gap(16)
        .children(cards)
        .child(h_flex().w_full().justify_between().pt(2)
          .child(label("GREY TICK · EVEN-PACE MARK", a(C.dim, 0.8), 8))
          .child(label(st.source === "file" ? "ACCOUNTS · CONFIG" : "ACCOUNTS · AUTO", a(C.dim, 0.8), 8))));
  }
}
