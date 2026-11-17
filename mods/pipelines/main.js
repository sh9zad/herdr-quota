// Pipelines: your latest GitHub Actions runs, one row per repo, branch and workflow.
// It uses the GitHub CLI (`gh`) and the account that `gh` is logged in to on this machine.
// Repos come from the config, or else from the repos of your open pull requests.
// Optional config ~/.config/herdr-mods/pipelines.json:
// { "repos": ["acme/api"], "limit": 12, "pollSeconds": 120, "hostname": "github.com" }
// props.panel: the layout column to watch for hidden.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { home, readTextFile, props as blockProps } from "herdr";
import { C, ACCENT, COMPACT_BELOW, a, label, txt, frame, chip, sh, openUrl, panelHidden, ago } from "./hud.js";

const CONFIG = "/.config/herdr-mods/pipelines.json";
const MAX_REPOS = 6;
const GH = 'command -v gh >/dev/null 2>&1 || exit 127; [ -n "$1" ] && export GH_HOST="$1"; shift; exec gh "$@"';

async function loadConfig() {
  try {
    const t = await readTextFile(home() + CONFIG);
    return t && t.trim() ? JSON.parse(t) : {};
  } catch { return {}; }
}

const gh = (cfg, args) => sh(GH, [cfg.hostname ?? "", ...args], 30000);
const failure = (r) => (r.code === 127 ? "GH CLI NOT INSTALLED"
  : /auth|login|token/i.test(r.stderr ?? "") ? "GH NOT LOGGED IN · RUN gh auth login" : "GITHUB UNREACHABLE");

// state: running, pass, fail or off (cancelled or skipped).
function stateOf(run) {
  if (run.status !== "completed") return "running";
  if (run.conclusion === "success") return "pass";
  if (run.conclusion === "cancelled" || run.conclusion === "skipped" || run.conclusion === "neutral") return "off";
  return "fail";
}

async function fetchRuns(cfg) {
  const who = await gh(cfg, ["api", "user", "-q", ".login"]);
  if (who.code !== 0) return { ok: false, error: failure(who) };
  const login = who.stdout.trim();
  let repos = Array.isArray(cfg.repos) ? cfg.repos : [];
  if (!repos.length) {
    const r = await gh(cfg, ["search", "prs", "--author", "@me", "--state", "open", "--limit", "30", "--json", "repository"]);
    if (r.code !== 0) return { ok: false, error: failure(r) };
    try { repos = [...new Set(JSON.parse(r.stdout).map((p) => p.repository?.nameWithOwner).filter(Boolean))]; }
    catch { return { ok: false, error: "UNEXPECTED GH OUTPUT" }; }
  }
  repos = repos.slice(0, MAX_REPOS);
  const fields = "databaseId,displayTitle,headBranch,status,conclusion,workflowName,createdAt,url";
  const results = await Promise.all(repos.map(async (repo) => {
    const r = await gh(cfg, ["run", "list", "-R", repo, "--user", login, "-L", "8", "--json", fields]);
    if (r.code !== 0) return { repo, error: true, runs: [] };
    try { return { repo, runs: JSON.parse(r.stdout) }; } catch { return { repo, error: true, runs: [] }; }
  }));
  const seen = new Set(), runs = [];
  for (const res of results) {
    for (const x of res.runs) {
      const key = `${res.repo}|${x.headBranch}|${x.workflowName}`;
      if (seen.has(key)) continue; // the list is newest first, so the first run per key is the latest
      seen.add(key);
      runs.push({
        repo: res.repo, title: x.displayTitle, branch: x.headBranch, flow: x.workflowName,
        state: stateOf(x), url: x.url, at: Date.parse(x.createdAt),
      });
    }
  }
  runs.sort((p, q) => q.at - p.at);
  const limit = Math.max(1, Math.min(40, Number(cfg.limit) || 12));
  return { ok: true, at: Date.now(), runs: runs.slice(0, limit), repos: repos.length, failedRepos: results.filter((x) => x.error).length };
}

const STATE = {
  pass: ["●", C.ok, "PASS"], fail: ["●", C.crit, "FAIL"], running: ["◐", C.warn, "RUNNING"], off: ["○", C.dim, "STOPPED"],
};

export default class Pipelines extends View {
  init(props, cx) {
    this.panel = (props ?? blockProps() ?? {}).panel ?? null;
    this.width = 380;
    this.data = null;
    this.timerSecs = 120;
    this.poll(cx);
    cx.timer.every(30000, (cx) => {
      if (panelHidden(this.panel, "pipelines") || this.busy) return;
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
        const d = await fetchRuns(cfg);
        this.data = d.ok ? d : { ...(this.data ?? {}), ok: false, error: d.error, at: Date.now() };
      } finally { this.busy = false; cx.notify(); }
    });
  }

  row(p, i) {
    const [glyph, col, word] = STATE[p.state];
    return h_flex().id(`run-${p.url}`).w_full().gap(10).px(8).py(7).items_start()
      .border_l(2).border_color(a(col, 0.8)).bg(i % 2 ? "#00000000" : a(C.plate, 0.8))
      .hover((s) => s.bg(a(C.text, 0.05)))
      .on_click(() => openUrl(p.url))
      .child(div().pt(1).font_family("Menlo").text_size(10).text_color(col).child(glyph))
      .child(v_flex().flex_1().min_w(0).gap(3)
        .child(div().text_size(12).text_color(C.text).truncate().child(p.title))
        .child(h_flex().gap(8).items_center()
          .child(label(`${p.repo.split("/").pop()} · ${p.branch}`, C.dim, 8))
          .child(label(word, col, 8))))
      .child(label(ago(Date.now() - p.at), C.dim, 8));
  }

  render(cx) {
    const compact = this.width < COMPACT_BELOW, A = ACCENT.pipelines, d = this.data;
    const onSize = (size, cx) => { if (Math.abs(this.width - size.width) > 2) { this.width = size.width; cx.notify(); } };
    const count = (s) => (d?.runs ?? []).filter((p) => p.state === s).length;
    const tiles = [["RUNNING", count("running"), C.warn], ["FAILED", count("fail"), C.crit], ["PASSED", count("pass"), C.ok]];
    let body;
    if (!d) body = label("SCANNING", C.dim, 9).loop("opacity", { from: 0.3, to: 1, period: 1400 });
    else if (!d.runs) body = v_flex().w_full().items_center().py(16).gap(6).child(txt("⚠", 16, C.crit)).child(label(d.error, C.crit, 8.5));
    else if (compact) {
      body = v_flex().w_full().gap(4).children(tiles.map(([t, n, c]) =>
        v_flex().items_center().gap(2).py(4).w_full().child(txt(String(n), 20, n ? c : C.dim)).child(label(t, C.dim, 7.5))));
    } else {
      const summary = h_flex().w_full().gap(8).children(tiles.map(([t, n, c]) =>
        v_flex().flex_1().items_center().py(6).border(1).border_color(n ? a(c, 0.35) : C.line).bg(n ? a(c, 0.05) : "#00000000")
          .child(txt(String(n), 18, n ? c : C.dim)).child(label(t, C.dim, 7.5))));
      body = v_flex().w_full().gap(10).child(summary)
        .when(!d.ok, (e) => e.child(label(`⚠ ${d.error} · SHOWING LAST SCAN`, C.warn, 8)))
        .when(d.failedRepos > 0, (e) => e.child(label(`⚠ ${d.failedRepos} REPO(S) UNREADABLE`, C.warn, 8)))
        .when(d.runs.length === 0, (e) => e.child(div().py(6).child(label(d.repos ? "NO RECENT RUNS" : "NO OPEN PRS · SET repos IN pipelines.json", C.dim, 8))))
        .children(d.runs.map((p, i) => this.row(p, i)));
    }
    return frame({
      title: "ACTIONS", sub: "PIPELINES", accent: A, compact, compactTag: "CI", onSize, id: "pipelines-root", hide: "pipelines",
      right: chip("pl-sync", this.busy ? "◐ SYNC" : `↻ ${d?.at ? ago(Date.now() - d.at) : "--"}`, (_e, cx) => this.poll(cx)),
      body,
    });
  }
}
