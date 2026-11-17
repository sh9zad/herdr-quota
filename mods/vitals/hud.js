// The shared instrument-panel look for the vitals, prs and nextup mods.
// install.sh copies this file into each of those mods as ./hud.js; edit it here, not there.
import { div, PathBuilder, Background } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, settings, layout } from "herdr";

export const C = {
  void: "#080B10", hull: "#0C1118", plate: "#101722", line: "#1B2533", lineHi: "#2A3850",
  dim: "#5B6C82", mid: "#8C9DB4", text: "#D6E2F0", white: "#F4F8FF",
  ok: "#4BE3A4", warn: "#FFB547", crit: "#FF5A5F",
};
export const ACCENT = {
  claude: "#FF9E6B", codex: "#6CD6FF", vitals: "#A98BFF", prs: "#4BE3A4", nextup: "#FFD36B",
};
export const COMPACT_BELOW = 170; // px: narrower than this, a mod draws its compact form

export const a = (hex, alpha) => hex + Math.round(Math.max(0, Math.min(1, alpha)) * 255).toString(16).padStart(2, "0");
export const mono = () => settings().font_family || "Menlo";
export const PATHS = 'PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"; export PATH';

export function sh(script, args = [], timeout = 20000) {
  return exec("sh", ["-c", `${PATHS}\n${script}`, "herdr-mod", ...args], { timeout })
    .catch((e) => ({ code: 127, stdout: "", stderr: String(e?.message ?? e) }));
}

export function openUrl(url) {
  if (url) sh('command -v open >/dev/null 2>&1 && exec open "$1"; exec xdg-open "$1"', [url]);
}

export function find(node, id) {
  if (!node) return null;
  if (node.id === id) return node;
  for (const ch of node.children ?? []) { const f = find(ch, id); if (f) return f; }
  return null;
}
// Whether the layout node this mod lives in (props.panel) is hidden: skip polling then.
export const panelHidden = (panel) => !!(panel && find(layout(), panel)?.hidden);

export function label(text, color = C.dim, size = 10) {
  return div().font_family(mono()).text_size(Math.max(9.5, size + 1)).text_color(color).whitespace_nowrap().child(String(text));
}
export const txt = (text, size, color = C.text) => div().font_family(mono()).text_size(size).text_color(color).child(String(text));

// ---- Canvas ----
const rad = (d) => (d * Math.PI) / 180;
const pt = (c, r, deg) => [c + r * Math.cos(rad(deg)), c + r * Math.sin(rad(deg))];
export const START = 135, SWEEP = 270;
export const RECT = () => PathBuilder.fill().move_to("0%", "0%").line_to("100%", "0%").line_to("100%", "100%").line_to("0%", "100%").close().build();
export const layer = (path, bg) => window.paint_path(path, bg).absolute().top(0).left(0).size_full();
export const fade = (color, angle = 90) => layer(RECT(), Background.linear_gradient(angle, Background.stop(a(color, 0.55), 0), Background.stop(a(color, 0), 100)));
export const texture = () => layer(RECT(), Background.pattern_slash(a(C.text, 0.018), 1, 7));

export function arcPath(c, r, from, to, width) {
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

// A 270° dial. fill: 0..100 of the arc lit. value/unit: the centre text. caption: under it.
// tag: in the bottom gap. full: a full 360° ring instead (for countdowns).
export function gauge({ id, size, fill, value, unit = "", caption = "", tag = "", color, compact = false, full = false }) {
  const c = size / 2, r = compact ? c - 7 : c - 12;
  const g = compact ? [7, 4, 2] : [11, 6, 2.5];
  const from = full ? -90 : START, sweep = full ? 359.9 : SWEEP;
  const f = Math.max(0, Math.min(100, fill));
  const end = from + (sweep * f) / 100;
  const el = div().id(id).relative().w(size).h(size).flex_none()
    .child(layer(compact ? ticks(c, r + 3, r + 5, r + 3, 10, 1) : ticks(c, r + 5, r + 8, r + 3, 2, 1), a(C.lineHi, 0.9)))
    .child(layer(arcPath(c, r, from, from + sweep, compact ? 2 : 3), C.line));
  if (!compact) el.child(layer(arcPath(c, r - 13, from, from + sweep, 1), C.line));
  if (f > 0.4) {
    el.child(layer(arcPath(c, r, from, end, g[0]), Background.solid(color).opacity(0.10)))
      .child(layer(arcPath(c, r, from, end, g[1]), Background.solid(color).opacity(0.22)))
      .child(layer(arcPath(c, r, from, end, g[2]), color))
      .child(layer(radial(c, r - (compact ? 4 : 6), r + (compact ? 5 : 9), end, compact ? 1.5 : 2), C.white));
  }
  const v = String(value);
  const big = size * (compact ? (v.length >= 3 ? 0.21 : 0.25) : v.length >= 4 ? 0.18 : 0.24);
  return el
    .child(v_flex().absolute().top(0).left(0).size_full().items_center().justify_center().gap(1)
      .child(h_flex().items_end().gap(1)
        .child(div().font_family(mono()).text_size(big).when(!compact, (e) => e.font_light()).text_color(C.white).child(v))
        .when(!!unit, (e) => e.child(div().font_family(mono()).text_size(compact ? 7.5 : 11).text_color(C.mid).pb(compact ? 2 : 4).child(unit))))
      .when(!!caption && !compact, (e) => e.child(label(caption, C.dim, 8.5))))
    .when(!!tag, (e) => e.child(h_flex().absolute().bottom(compact ? 0 : 4).left(0).w_full().justify_center()
      .child(div().font_family(mono()).text_size(compact ? 8.5 : 10).text_color(color).child(tag))));
}

// A filled sparkline of values 0..100 across w×h.
export function sparkline(values, w, h, color) {
  if (values.length < 2) return div().w(w).h(h);
  const n = values.length, x = (i) => (i / (n - 1)) * w, y = (v) => h - 1 - (Math.max(0, Math.min(100, v)) / 100) * (h - 2);
  const line = PathBuilder.stroke(1.5).move_to(x(0), y(values[0]));
  const area = PathBuilder.fill().move_to(0, h).line_to(x(0), y(values[0]));
  for (let i = 1; i < n; i++) { line.line_to(x(i), y(values[i])); area.line_to(x(i), y(values[i])); }
  area.line_to(w, h).close();
  const grid = PathBuilder.stroke(1).dash_array([2, 4]);
  for (const g of [25, 50, 75]) grid.move_to(0, y(g)).line_to(w, y(g));
  return div().relative().w(w).h(h)
    .child(layer(grid.build(), C.line))
    .child(layer(area.build(), Background.linear_gradient(180, Background.stop(a(color, 0.35), 0), Background.stop(a(color, 0), 100))))
    .child(layer(line.build(), color));
}

// The panel chrome every mod shares: title row, optional right side, scrolling body.
export function frame({ title, sub, accent, right, body, compactTag, compact, onSize, id = "root" }) {
  const root = v_flex().id(id).size_full().bg(C.hull).relative().on_size_change(onSize).child(texture());
  if (compact) {
    return root
      .child(h_flex().w_full().justify_center().items_center().gap(4).pt(10).pb(8).border_b(1).border_color(C.line)
        .child(div().w(5).h(5).bg(accent)).child(div().font_family(mono()).text_size(9).font_semibold().text_color(C.text).child(compactTag)))
      .child(v_flex().id(`${id}-scroll`).flex_1().w_full().overflow_y_scrollbar().items_center().pt(10).pb(10).gap(10).child(body));
  }
  return root
    .child(h_flex().w_full().items_center().justify_between().px(16).pt(12).pb(10).border_b(1).border_color(C.line)
      .child(h_flex().items_center().gap(10)
        .child(div().relative().w(12).h(12).border(1).border_color(a(accent, 0.8))
          .child(div().absolute().top(3).left(3).w(4).h(4).bg(accent)))
        .child(div().font_family(mono()).text_size(12.5).font_semibold().text_color(C.white).child(title))
        .child(div().font_family(mono()).text_size(12.5).text_color(C.dim).child("//"))
        .child(div().font_family(mono()).text_size(12.5).text_color(C.mid).child(sub)))
      .child(right ?? div()))
    .child(v_flex().id(`${id}-scroll`).flex_1().w_full().overflow_y_scrollbar().px(16).pt(12).pb(14).gap(12).child(body));
}

// A small bordered button for headers.
export function chip(id, text, onClick, color = C.mid) {
  return h_flex().id(id).h(20).px(7).items_center().border(1).border_color(C.lineHi)
    .hover((s) => s.bg(a(C.text, 0.06)).border_color(C.mid))
    .on_click(onClick).child(label(text, color, 8));
}

export function ago(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "NOW";
  if (m < 60) return `${m}M`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}H`;
  return `${Math.floor(h / 24)}D`;
}
export const hhmm = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
