// Jira: your open tickets, grouped by status category, from the Jira Cloud REST API.
// Config ~/.config/herdr-mods/jira.json is required:
// { "site": "acme.atlassian.net", "email": "you@acme.com",
//   "tokenCommand": "security find-generic-password -s herdr-jira -w",
//   "jql": "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC",
//   "limit": 15, "pollSeconds": 180 }
// "tokenCommand" prints an Atlassian API token. "token" also works, but a command keeps the token out of the file.
// The token goes to curl on stdin, so it never appears in a process list.
// props.panel: the layout column to watch for hidden.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { home, readTextFile, props as blockProps } from "herdr";
import { C, ACCENT, COMPACT_BELOW, a, label, txt, frame, chip, sh, openUrl, panelHidden, ago } from "./hud.js";

const CONFIG = "/.config/herdr-mods/jira.json";
const CONFIG_HINT = "~/.config/herdr-mods/jira.json";
const DEFAULT_JQL = "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";

// $1 site, $2 email, $3 token command, $4 token, $5 jql, $6 limit.
const CURL = `
TOKEN="$4"
[ -n "$3" ] && TOKEN=$(eval "$3")
[ -n "$TOKEN" ] || exit 64
printf 'user = "%s:%s"\\n' "$2" "$TOKEN" | curl -sS -m 20 -K - -G "https://$1/rest/api/3/search/jql" \\
  --data-urlencode "jql=$5" --data-urlencode "maxResults=$6" \\
  --data-urlencode "fields=summary,status,priority,issuetype,updated" -w '\\n%{http_code}'
`;

async function loadConfig() {
  try {
    const t = await readTextFile(home() + CONFIG);
    return t && t.trim() ? JSON.parse(t) : null;
  } catch { return null; }
}

async function fetchIssues(cfg) {
  if (!cfg?.site || !cfg?.email || !(cfg.token || cfg.tokenCommand)) return { ok: false, error: `NOT CONFIGURED · SEE ${CONFIG_HINT}`, setup: true };
  const limit = Math.max(1, Math.min(50, Number(cfg.limit) || 15));
  const r = await sh(CURL, [cfg.site, cfg.email, cfg.tokenCommand ?? "", cfg.token ?? "", cfg.jql || DEFAULT_JQL, String(limit)], 30000);
  if (r.code === 64) return { ok: false, error: "TOKEN COMMAND PRINTED NOTHING" };
  if (r.code !== 0) return { ok: false, error: "JIRA UNREACHABLE" };
  const cut = r.stdout.lastIndexOf("\n");
  const status = r.stdout.slice(cut + 1).trim();
  if (status === "401" || status === "403") return { ok: false, error: "JIRA REJECTED THE TOKEN" };
  if (status !== "200") return { ok: false, error: `JIRA ERROR ${status}` };
  try {
    const issues = JSON.parse(r.stdout.slice(0, cut)).issues.map((i) => ({
      key: i.key, title: i.fields.summary, status: i.fields.status?.name ?? "",
      cat: i.fields.status?.statusCategory?.key ?? "new", type: i.fields.issuetype?.name ?? "",
      priority: i.fields.priority?.name ?? "", updated: Date.parse(i.fields.updated),
      url: `https://${cfg.site}/browse/${i.key}`,
    }));
    return { ok: true, at: Date.now(), issues, limit };
  } catch { return { ok: false, error: "UNEXPECTED JIRA OUTPUT" }; }
}

const isBlocked = (i) => /block|impediment|on hold/i.test(i.status);
const tone = (i) => (isBlocked(i) ? C.crit : i.cat === "indeterminate" ? ACCENT.jira : C.dim);

export default class Jira extends View {
  init(props, cx) {
    this.panel = (props ?? blockProps() ?? {}).panel ?? null;
    this.width = 380;
    this.data = null;
    this.timerSecs = 180;
    this.poll(cx);
    cx.timer.every(30000, (cx) => {
      if (panelHidden(this.panel, "jira") || this.busy) return;
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
        this.timerSecs = Math.max(60, Number(cfg?.pollSeconds) || 180);
        const d = await fetchIssues(cfg);
        this.data = d.ok ? d : { ...(this.data ?? {}), ok: false, error: d.error, setup: d.setup, at: Date.now() };
      } finally { this.busy = false; cx.notify(); }
    });
  }

  row(i, n) {
    const col = tone(i);
    return h_flex().id(`jr-${i.key}`).w_full().gap(10).px(8).py(7).items_start()
      .border_l(2).border_color(a(col, 0.8)).bg(n % 2 ? "#00000000" : a(C.plate, 0.8))
      .hover((s) => s.bg(a(C.text, 0.05)))
      .on_click(() => openUrl(i.url))
      .child(v_flex().flex_1().min_w(0).gap(3)
        .child(div().text_size(12).text_color(C.text).truncate().child(i.title))
        .child(h_flex().gap(8).items_center()
          .child(label(i.key, C.dim, 8))
          .child(label(i.status.toUpperCase(), col, 8))
          .when(!!i.priority, (e) => e.child(label(i.priority.toUpperCase(), C.dim, 8)))))
      .child(label(ago(Date.now() - i.updated), C.dim, 8));
  }

  render(cx) {
    const compact = this.width < COMPACT_BELOW, A = ACCENT.jira, d = this.data;
    const onSize = (size, cx) => { if (Math.abs(this.width - size.width) > 2) { this.width = size.width; cx.notify(); } };
    const list = d?.issues ?? [];
    const tiles = [
      ["BLOCKED", list.filter(isBlocked).length, C.crit],
      ["IN PROGRESS", list.filter((i) => i.cat === "indeterminate" && !isBlocked(i)).length, A],
      ["TO DO", list.filter((i) => i.cat === "new" && !isBlocked(i)).length, C.mid],
    ];
    let body;
    if (!d) body = label("SCANNING", C.dim, 9).loop("opacity", { from: 0.3, to: 1, period: 1400 });
    else if (!d.issues) body = v_flex().w_full().items_center().py(16).gap(6).child(txt(d.setup ? "◌" : "⚠", 16, d.setup ? C.dim : C.crit)).child(label(compact && d.setup ? "SETUP" : d.error, d.setup ? C.warn : C.crit, 8.5));
    else if (compact) {
      body = v_flex().w_full().gap(4).children(tiles.map(([t, n, c]) =>
        v_flex().items_center().gap(2).py(4).w_full().child(txt(String(n), 20, n ? c : C.dim)).child(label(t, C.dim, 7.5))));
    } else {
      const summary = h_flex().w_full().gap(8).children(tiles.map(([t, n, c]) =>
        v_flex().flex_1().items_center().py(6).border(1).border_color(n ? a(c, 0.35) : C.line).bg(n ? a(c, 0.05) : "#00000000")
          .child(txt(String(n), 18, n ? c : C.dim)).child(label(t, C.dim, 7.5))));
      body = v_flex().w_full().gap(10).child(summary)
        .when(!d.ok, (e) => e.child(label(`⚠ ${d.error} · SHOWING LAST SCAN`, C.warn, 8)))
        .when(list.length >= d.limit, (e) => e.child(label(`SHOWING FIRST ${d.limit}`, C.dim, 8)))
        .when(list.length === 0, (e) => e.child(div().py(6).child(label("NO OPEN TICKETS", C.dim, 8))))
        .children(list.map((i, n) => this.row(i, n)));
    }
    return frame({
      title: "JIRA", sub: "MY WORK", accent: A, compact, compactTag: "JIRA", onSize, id: "jira-root", hide: "jira",
      right: chip("jr-sync", this.busy ? "◐ SYNC" : `↻ ${d?.at ? ago(Date.now() - d.at) : "--"}`, (_e, cx) => this.poll(cx)),
      body,
    });
  }
}
