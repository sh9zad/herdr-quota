// Quota telemetry: what's left of each Claude and Codex subscription window.
// Accounts: ~/.config/herdr-quota/accounts.json, or this machine's default logins (see data.js).
// Roles (props.role): the panel (default), or "toggle", the tab-bar readout that shows/hides
// the layout's "quota-panel" node. The toggle is always drawn, so it does the polling and
// publishes through shared state; the panel only reads (and can force a resync).
// Role "sections" is a tab-bar strip of chips. Each chip shows or hides one stacked mod.
import { View, div, PathBuilder, Background } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, shared, setShared, layout, settings, nextCommand, props as blockProps } from "herdr";
import { KEY, CONFIG_PATH, loadAccounts, read, pace, span, windowLabel } from "./data.js";

const PANEL = "quota-panel";
const COMPACT_KEY = "quota.compact.v1"; // shared, so it survives restarts and other copies agree
const WIDE_KEY = "quota.wideWidth.v1";
const COMPACT_W = 92;
const SECTIONS = [["vitals", "VIT"], ["nextup", "NXT"], ["prs", "PRS"], ["fleet", "FLT"], ["pipelines", "CI"], ["jira", "JIRA"]];
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

function dial(id, w, accent, size, now, compact = false) {
  const c = size / 2, r = compact ? c - 7 : c - 12;
  const g = compact ? [7, 4, 2] : [11, 6, 2.5];
  const remain = Math.max(0, Math.min(100, 100 - w.used));
  const col = level(remain, accent);
  const end = START + (SWEEP * remain) / 100;
  const p = pace(w, now);
  const el = div().id(id).relative().w(size).h(size).flex_none()
    // fine graduation ring
    .child(layer(compact ? ticks(c, r + 3, r + 5, r + 3, 10, 1) : ticks(c, r + 5, r + 8, r + 3, 2, 1), a(C.lineHi, 0.9)))
    // track
    .child(layer(arc(c, r, START, START + SWEEP, compact ? 2 : 3), C.line));
  // decorative inner ring
  if (!compact) el.child(layer(arc(c, r - 13, START, START + SWEEP, 1), a(C.line, 1)));
  if (remain > 0.4) {
    el.child(layer(arc(c, r, START, end, g[0]), Background.solid(col).opacity(0.10)))
      .child(layer(arc(c, r, START, end, g[1]), Background.solid(col).opacity(0.22)))
      .child(layer(arc(c, r, START, end, g[2]), col))
      .child(layer(radial(c, r - (compact ? 4 : 6), r + (compact ? 5 : 9), end, compact ? 1.5 : 2), C.white)); // needle tip
  }
  // ghost marker: where an even burn would leave you now
  if (p.expected != null) el.child(layer(radial(c, r - (compact ? 3 : 5), r + (compact ? 3 : 5), START + (SWEEP * (100 - p.expected)) / 100, 1.5), a(C.mid, 0.9)));
  if (compact) {
    return el
      .child(h_flex().absolute().top(0).left(0).size_full().items_center().justify_center()
        .child(h_flex().items_end().gap(1)
          .child(div().font_family(mono()).text_size(size * (Math.round(remain) >= 100 ? 0.21 : 0.25)).text_color(C.white).child(String(Math.round(remain))))
          .child(div().font_family(mono()).text_size(7.5).text_color(C.mid).pb(2).child("%"))))
      .child(h_flex().absolute().bottom(0).left(0).w_full().justify_center()
        .child(div().font_family(mono()).text_size(8.5).text_color(col).child(windowLabel(w.minutes))));
  }
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

// Short tag for a compact column: CL / CX for default names, else initials.
function abbrev(acc) {
  const n = String(acc.name ?? "").trim();
  if (!n || n.toLowerCase() === acc.provider) return acc.provider === "claude" ? "CL" : "CX";
  const words = n.split(/\s+/);
  return (words.length > 1 ? words.map((w) => w[0]).join("") : n.slice(0, 3)).slice(0, 3).toUpperCase();
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
    if (this.role === "sections") return;
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
      // Commands (bindable in keys.json): quota.compact, quota.expand, quota.toggle-compact.
      cx.spawn(async (cx) => {
        for (;;) {
          const c = await nextCommand();
          const name = typeof c === "string" ? c : c?.name;
          if (name === "compact") this.setCompact(true);
          else if (name === "expand") this.setCompact(false);
          else if (name === "toggle-compact") this.setCompact(!shared(COMPACT_KEY));
          cx.notify();
        }
      });
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
    if (this.role === "sections") return this.renderSections();
    return this.role === "toggle" ? this.renderToggle() : this.renderPanel(cx);
  }

  // One chip per stacked mod that the layout holds. A lit chip means the section is shown.
  // A click on a chip also shows the column when the column is hidden.
  renderSections() {
    const root = layout(), column = find(root, PANEL);
    const chips = SECTIONS.filter(([id]) => find(root, id)).map(([id, tag]) => {
      const on = !find(root, id).hidden;
      return h_flex().id(`sec-${id}`).h(22).px(6).flex_none().items_center().rounded(4)
        .border(1).border_color(on ? a(ACCENT.codex, 0.35) : C.line)
        .bg(on ? a(ACCENT.codex, 0.08) : "#00000000")
        .hover((s) => s.bg(a(C.text, 0.06)))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => {
          if (column?.hidden) run("layout.show", { id: PANEL });
          run(on && !column?.hidden ? "layout.hide" : "layout.show", { id });
        })
        .child(div().font_family(mono()).text_size(8.5).text_color(on ? C.text : C.dim).child(tag));
    });
    return h_flex().size_full().pr(4).gap(4).items_center().justify_end().children(chips);
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

  // Compact: a slim column of small stacked gauges. The panel node is resized to fit and
  // restored to its previous width when expanded again.
  setCompact(on) {
    if (on) {
      if (this.width > COMPACT_W + 20) setShared(WIDE_KEY, Math.round(this.width));
      setShared(COMPACT_KEY, true);
      run("layout.resize", { id: PANEL, px: COMPACT_W });
    } else {
      setShared(COMPACT_KEY, false);
      run("layout.resize", { id: PANEL, px: Math.max(340, Number(shared(WIDE_KEY)) || 400) });
    }
  }

  renderCompact(st, now) {
    const accounts = st.accounts ?? [], readings = st.readings ?? {};
    const SIZE = 62;
    const blocks = accounts.map((acc, i) => {
      const r = readings[acc.id], accent = ACCENT[acc.provider];
      const tagRow = h_flex().items_center().gap(4)
        .child(div().w(5).h(5).bg(accent))
        .child(div().font_family(mono()).text_size(9).font_semibold().text_color(C.text).child(abbrev(acc)));
      let body;
      if (!r) body = div().font_family(mono()).text_size(9).text_color(C.dim).py(10).child("···").loop("opacity", { from: 0.3, to: 1, period: 1400 });
      else if (!r.ok) body = div().font_family(mono()).text_size(14).text_color(C.crit).py(8).child("⚠");
      else body = v_flex().items_center().gap(4).children(r.windows.slice(0, 2).map((w, j) =>
        div().id(`c-${acc.id}-${j}`).hover((s) => s.opacity(0.85)).on_click(() => this.setCompact(false))
          .child(dial(`cd-${acc.id}-${j}`, w, accent, SIZE, now, true))));
      return v_flex().w_full().items_center().gap(6).pt(i ? 10 : 0).when(i > 0, (el) => el.border_t(1).border_color(C.line))
        .child(tagRow).child(body);
    });
    return v_flex().id("root").size_full().bg(C.hull).relative()
      .on_size_change((size, cx) => { if (Math.abs((this.width ?? 0) - size.width) > 2) { this.width = size.width; cx.notify(); } })
      .child(layer(RECT(), Background.pattern_slash(a(C.text, 0.018), 1, 7)))
      .child(v_flex().w_full().items_center().gap(6).pt(12).pb(10).border_b(1).border_color(C.line)
        .child(h_flex().id("expand").h(22).w(30).items_center().justify_center().border(1).border_color(C.lineHi)
          .hover((s) => s.bg(a(C.text, 0.06)).border_color(C.mid))
          .on_click(() => this.setCompact(false))
          .child(div().font_family(mono()).text_size(10).text_color(C.mid).child("‹›"))))
      .child(v_flex().id("scroll").flex_1().w_full().overflow_y_scrollbar().items_center().pt(12).pb(12).gap(10)
        .children(blocks));
  }

  renderPanel(cx) {
    const st = getState(), now = Date.now();
    if (shared(COMPACT_KEY)) return this.renderCompact(st, now);
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
          .child(h_flex().id("compact").h(22).w(26).items_center().justify_center().border(1).border_color(C.lineHi)
            .hover((s) => s.bg(a(C.text, 0.06)).border_color(C.mid))
            .on_click(() => this.setCompact(true))
            .child(div().font_family(mono()).text_size(10).text_color(C.mid).child("›‹")))
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
