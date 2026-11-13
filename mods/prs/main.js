// PR radar: your open pull requests and the ones waiting on your review, with CI and review state.
// Uses the GitHub CLI (`gh`) and whatever account it's logged in to on this machine.
// Optional config ~/.config/herdr-mods/prs.json: { "filter": "org:acme", "hostname": "github.com",
// "limit": 15, "pollSeconds": 120, "includeTeamReviews": false }. props.panel: the layout node to watch for hidden.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { home, readTextFile, props as blockProps } from "herdr";
import { C, ACCENT, COMPACT_BELOW, a, label, txt, frame, chip, sh, openUrl, panelHidden, ago } from "./hud.js";

const CONFIG = "/.config/herdr-mods/prs.json";

const QUERY = `
fragment P on PullRequest { number title url isDraft updatedAt reviewDecision mergeable
  repository { nameWithOwner } author { login }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } }
query($mine: String!, $review: String!, $n: Int!) {
  mine: search(query: $mine, type: ISSUE, first: $n) { issueCount nodes { ...P } }
  review: search(query: $review, type: ISSUE, first: $n) { issueCount nodes { ...P } } }`;

async function loadConfig() {
  try {
    const t = await readTextFile(home() + CONFIG);
    return t && t.trim() ? JSON.parse(t) : {};
  } catch { return {}; }
}

async function fetchPRs(cfg) {
  const extra = cfg.filter ? ` ${cfg.filter}` : "";
  const n = Math.max(1, Math.min(50, Number(cfg.limit) || 15));
  const args = ["api", "graphql"];
  if (cfg.hostname) args.push("--hostname", cfg.hostname);
  args.push("-f", `query=${QUERY}`,
    "-f", `mine=is:pr is:open author:@me archived:false sort:updated-desc${extra}`,
    // user-review-requested: asked of you by name; review-requested also counts your teams.
    "-f", `review=is:pr is:open ${cfg.includeTeamReviews ? "review-requested" : "user-review-requested"}:@me archived:false sort:updated-desc${extra}`,
    "-F", `n=${n}`);
  const r = await sh('command -v gh >/dev/null 2>&1 || exit 127; exec gh "$@"', args, 30000);
  if (r.code === 127) return { ok: false, error: "GH CLI NOT INSTALLED" };
  if (r.code !== 0) return { ok: false, error: /auth|login|token/i.test(r.stderr ?? "") ? "GH NOT LOGGED IN · RUN gh auth login" : "GITHUB UNREACHABLE" };
  try {
    const d = JSON.parse(r.stdout).data;
    const norm = (p) => ({
      number: p.number, title: p.title, url: p.url, draft: p.isDraft, updated: Date.parse(p.updatedAt),
      review: p.reviewDecision, conflict: p.mergeable === "CONFLICTING",
      repo: p.repository?.nameWithOwner ?? "", author: p.author?.login ?? "",
      ci: p.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null,
    });
    return { ok: true, at: Date.now(), mine: d.mine.nodes.map(norm), review: d.review.nodes.map(norm), mineCount: d.mine.issueCount, reviewCount: d.review.issueCount };
  } catch { return { ok: false, error: "UNEXPECTED GH OUTPUT" }; }
}

const CI = {
  SUCCESS: ["●", C.ok, "PASS"], FAILURE: ["●", C.crit, "FAIL"], ERROR: ["●", C.crit, "ERROR"],
  PENDING: ["◐", C.warn, "RUNNING"], EXPECTED: ["◐", C.warn, "WAITING"],
};
const ciOf = (s) => CI[s] ?? ["○", C.dim, "NO CI"];

export default class Prs extends View {
  init(props, cx) {
    this.panel = (props ?? blockProps() ?? {}).panel ?? null;
    this.width = 380;
    this.data = null;
    this.poll(cx);
    this.timerSecs = 120;
    cx.timer.every(30000, (cx) => {
      if (panelHidden(this.panel) || this.busy) return;
      if (!this.data || Date.now() - (this.data.at ?? 0) >= this.timerSecs * 1000) this.poll(cx);
    });
  }

  poll(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      await cx.sleep(0);
      cx.notify();
      try {
        const cfg = await loadConfig();
        this.timerSecs = Math.max(60, Number(cfg.pollSeconds) || 120);
        const d = await fetchPRs(cfg);
        this.data = d.ok ? d : { ...(this.data ?? {}), ok: false, error: d.error, at: Date.now() };
      } finally { this.busy = false; cx.notify(); }
    });
  }

  row(p, i, showAuthor) {
    const [glyph, col, word] = ciOf(p.ci);
    const tags = [];
    if (p.draft) tags.push(["DRAFT", C.dim]);
    if (p.conflict) tags.push(["CONFLICT", C.crit]);
    if (p.review === "APPROVED") tags.push(["APPROVED", C.ok]);
    else if (p.review === "CHANGES_REQUESTED") tags.push(["CHANGES", C.crit]);
    const repo = p.repo.split("/").pop();
    return h_flex().id(`pr-${p.url}`).w_full().gap(10).px(8).py(7).items_start()
      .border_l(2).border_color(a(col, 0.8)).bg(i % 2 ? "#00000000" : a(C.plate, 0.8))
      .hover((s) => s.bg(a(C.text, 0.05)))
      .on_click(() => openUrl(p.url))
      .child(div().pt(1).font_family("Menlo").text_size(10).text_color(col).child(glyph))
      .child(v_flex().flex_1().min_w(0).gap(3)
        .child(div().text_size(12).text_color(C.text).truncate().child(p.title))
        .child(h_flex().gap(8).items_center()
          .child(label(`${repo} #${p.number}`, C.dim, 8))
          .when(showAuthor && !!p.author, (e) => e.child(label(`@${p.author}`, C.mid, 8)))
          .child(label(word, col, 8))
          .children(tags.map(([t, c]) => div().px(4).border(1).border_color(a(c, 0.4)).child(label(t, c, 7.5))))))
      .child(label(ago(Date.now() - p.updated), C.dim, 8));
  }

  render(cx) {
    const compact = this.width < COMPACT_BELOW, A = ACCENT.prs, d = this.data;
    const onSize = (size, cx) => { if (Math.abs(this.width - size.width) > 2) { this.width = size.width; cx.notify(); } };
    const failing = d?.mine ? d.mine.filter((p) => p.ci === "FAILURE" || p.ci === "ERROR").length : 0;
    let body;
    if (!d) body = label("SCANNING", C.dim, 9).loop("opacity", { from: 0.3, to: 1, period: 1400 });
    else if (!d.mine) body = v_flex().w_full().items_center().py(16).gap(6).child(txt("⚠", 16, C.crit)).child(label(d.error, C.crit, 8.5));
    else if (compact) {
      const stat = (id, tag, n, col, url) => v_flex().id(id).items_center().gap(2).py(4).w_full()
        .hover((s) => s.bg(a(C.text, 0.05))).on_click(() => openUrl(url))
        .child(txt(String(n), 20, n ? col : C.dim)).child(label(tag, C.dim, 7.5));
      body = v_flex().w_full().gap(4)
        .child(stat("c-rv", "REVIEW", d.reviewCount, C.warn, "https://github.com/pulls/review-requested"))
        .child(stat("c-pr", "MINE", d.mineCount, A, "https://github.com/pulls"))
        .child(stat("c-ci", "CI FAIL", failing, C.crit, "https://github.com/pulls"));
    } else {
      const section = (title, count, list, showAuthor, empty) => v_flex().w_full().gap(4)
        .child(h_flex().w_full().justify_between().pb(2).child(label(title, C.mid, 8.5)).child(label(String(count), A, 8.5)))
        .when(list.length === 0, (e) => e.child(div().py(6).child(label(empty, C.dim, 8))))
        .children(list.map((p, i) => this.row(p, i, showAuthor)));
      const summary = h_flex().w_full().gap(8).children([
        ["REVIEW", d.reviewCount, C.warn], ["MINE", d.mineCount, A], ["CI FAIL", failing, C.crit],
      ].map(([t, n, c]) => v_flex().flex_1().items_center().py(6).border(1).border_color(n ? a(c, 0.35) : C.line).bg(n ? a(c, 0.05) : "#00000000")
        .child(txt(String(n), 18, n ? c : C.dim)).child(label(t, C.dim, 7.5))));
      body = v_flex().w_full().gap(14)
        .child(summary)
        .when(!d.ok, (e) => e.child(label(`⚠ ${d.error} · SHOWING LAST SCAN`, C.warn, 8)))
        .child(section("AWAITING YOUR REVIEW", d.reviewCount, d.review, true, "NOTHING WAITING ON YOU"))
        .child(section("YOUR PULL REQUESTS", d.mineCount, d.mine, false, "NO OPEN PULL REQUESTS"));
    }
    return frame({
      title: "GITHUB", sub: "PR RADAR", accent: A, compact, compactTag: "PRS", onSize, id: "prs-root",
      right: chip("prs-sync", this.busy ? "◐ SYNC" : `↻ ${d?.at ? ago(Date.now() - d.at) : "--"}`, (_e, cx) => this.poll(cx)),
      body,
    });
  }
}
