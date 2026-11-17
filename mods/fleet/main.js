// Fleet: every agent running in Herdr, with its status and how long it has held that status.
// It reads the live agents() list, so it needs no polling and no config.
// props.panel: the layout column to watch for hidden.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, run, props as blockProps } from "herdr";
import { C, ACCENT, COMPACT_BELOW, a, label, txt, frame, panelHidden, ago } from "./hud.js";

// status: [glyph, color, word, sort rank]. Blocked agents wait for you, so they sort first.
const ST = {
  blocked: ["▲", C.warn, "BLOCKED", 0],
  done: ["●", C.ok, "DONE", 1],
  working: ["◐", ACCENT.fleet, "WORKING", 2],
  idle: ["○", C.dim, "IDLE", 3],
};
const stOf = (s) => ST[s] ?? ST.idle;

export default class Fleet extends View {
  init(props, cx) {
    this.panel = (props ?? blockProps() ?? {}).panel ?? null;
    this.width = 380;
    this.since = {}; // address -> { s: status, at: ms when this mod first saw that status }
    cx.timer.every(30000, (cx) => { if (!panelHidden(this.panel, "fleet")) cx.notify(); });
  }

  track(list, now) {
    const live = new Set();
    for (const g of list) {
      live.add(g.address);
      if (this.since[g.address]?.s !== g.status) this.since[g.address] = { s: g.status, at: now };
    }
    for (const k of Object.keys(this.since)) if (!live.has(k)) delete this.since[k];
  }

  row(g, i, now) {
    const [glyph, col, word] = stOf(g.status);
    const where = [g.space_name, g.tab_name].filter(Boolean).join(" / ");
    return h_flex().id(`ag-${g.address}`).w_full().gap(10).px(8).py(7).items_start()
      .border_l(2).border_color(a(col, 0.8)).bg(i % 2 ? "#00000000" : a(C.plate, 0.8))
      .hover((s) => s.bg(a(C.text, 0.05)))
      .on_click(() => run("pane.focus", { terminal: g.address }))
      .child(div().pt(1).font_family("Menlo").text_size(10).text_color(col).child(glyph))
      .child(v_flex().flex_1().min_w(0).gap(3)
        .child(div().text_size(12).text_color(C.text).truncate().child(g.program?.name || g.app || "agent"))
        .child(div().text_size(10).text_color(C.mid).truncate().child(g.title || where))
        .child(h_flex().gap(8).items_center()
          .child(label(word, col, 8))
          .when(!!where, (e) => e.child(label(where.toUpperCase(), C.dim, 8)))))
      .child(label(ago(now - (this.since[g.address]?.at ?? now)), C.dim, 8));
  }

  render(cx) {
    const compact = this.width < COMPACT_BELOW, A = ACCENT.fleet, now = Date.now();
    const onSize = (size, cx) => { if (Math.abs(this.width - size.width) > 2) { this.width = size.width; cx.notify(); } };
    const list = [...agents()].sort((x, y) => stOf(x.status)[3] - stOf(y.status)[3] || y.seq - x.seq);
    this.track(list, now);
    const count = (s) => list.filter((g) => g.status === s).length;
    const tiles = [["BLOCKED", count("blocked"), C.warn], ["WORKING", count("working"), A], ["DONE", count("done"), C.ok]];
    let body;
    if (compact) {
      body = v_flex().w_full().gap(4).children(tiles.map(([t, n, c]) =>
        v_flex().items_center().gap(2).py(4).w_full().child(txt(String(n), 20, n ? c : C.dim)).child(label(t, C.dim, 7.5))));
    } else {
      const summary = h_flex().w_full().gap(8).children(tiles.map(([t, n, c]) =>
        v_flex().flex_1().items_center().py(6).border(1).border_color(n ? a(c, 0.35) : C.line).bg(n ? a(c, 0.05) : "#00000000")
          .child(txt(String(n), 18, n ? c : C.dim)).child(label(t, C.dim, 7.5))));
      body = v_flex().w_full().gap(10).child(summary)
        .when(list.length === 0, (e) => e.child(div().py(6).child(label("NO AGENTS RUNNING", C.dim, 8))))
        .children(list.map((g, i) => this.row(g, i, now)));
    }
    return frame({
      title: "FLEET", sub: "AGENTS", accent: A, compact, compactTag: "AGT", onSize, id: "fleet-root", hide: "fleet",
      right: label(`${list.length} LIVE`, C.dim, 8.5),
      body,
    });
  }
}
