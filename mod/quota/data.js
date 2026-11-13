// Where the numbers come from. Nothing here is tied to one person: the accounts come from
// ~/.config/herdr-quota/accounts.json on this machine, or are auto-detected when it's absent.
// Every reader returns the same shape:
// { ok, plan, at, seen?, windows: [{ key, label, minutes, used, resetsAt, stale? }], extra, error? }
// used is 0..100, resetsAt is epoch ms.
import { exec, home, readTextFile } from "herdr";

export const KEY = "quota.state.v2"; // shared: { [accountId]: reading }
export const CONFIG_PATH = "~/.config/herdr-quota/accounts.json";

const DEFAULT_POLL = { claudeSeconds: 180, codexSeconds: 60 };

const expand = (p) => (p && p.startsWith("~/") ? `${home()}/${p.slice(2)}` : p);
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// ---- Accounts ----

// Returns { accounts: [{ id, provider, name, ... }], poll, source: "file" | "auto", error? }
export async function loadAccounts() {
  let raw = null;
  try { raw = await readTextFile(expand(CONFIG_PATH)); } catch { raw = null; }
  if (raw != null && raw.trim()) {
    try {
      const cfg = JSON.parse(raw);
      const seen = {};
      const accounts = (cfg.accounts ?? [])
        .filter((a) => a && (a.provider === "claude" || a.provider === "codex") && a.enabled !== false)
        .map((a) => {
          let id = slug(`${a.provider}-${a.name ?? a.provider}`);
          seen[id] = (seen[id] ?? 0) + 1;
          if (seen[id] > 1) id += `-${seen[id]}`;
          return { ...a, id, name: a.name ?? a.provider };
        });
      return { accounts, poll: { ...DEFAULT_POLL, ...(cfg.poll ?? {}) }, source: "file" };
    } catch (e) {
      return { accounts: [], poll: DEFAULT_POLL, source: "file", error: `BAD CONFIG · ${CONFIG_PATH}` };
    }
  }
  return { accounts: await detect(), poll: DEFAULT_POLL, source: "auto" };
}

// No config: whatever this machine's default Claude Code and Codex logins are.
async function detect() {
  const out = [];
  const sh = async (script) => {
    try { return await exec("sh", ["-c", script], { timeout: 10000 }); } catch { return { code: 1, stdout: "" }; }
  };
  const claude = await sh(`
    if command -v security >/dev/null 2>&1 && security find-generic-password -s "Claude Code-credentials" >/dev/null 2>&1; then echo keychain; exit 0; fi
    f="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json"; [ -f "$f" ] && { echo "file:$f"; exit 0; }
    exit 1`);
  if (claude.code === 0) {
    const v = claude.stdout.trim();
    out.push({ id: "claude", provider: "claude", name: "Claude",
      credentials: v === "keychain" ? { keychain: "Claude Code-credentials" } : { file: v.slice(5) } });
  }
  const codex = await sh(`d="\${CODEX_HOME:-$HOME/.codex}"; [ -d "$d/sessions" ] && { echo "$d"; exit 0; }; exit 1`);
  if (codex.code === 0) out.push({ id: "codex", provider: "codex", name: "Codex", home: codex.stdout.trim() });
  return out;
}

export function read(account) {
  return account.provider === "claude" ? readClaude(account) : readCodex(account);
}

// ---- Claude: a Claude Code login → Anthropic's usage endpoint ----
// credentials: { keychain: "<service>" } (macOS) | { file: "<path to .credentials.json>" }
// The keychain service is "Claude Code-credentials" for the default CLAUDE_CONFIG_DIR; other
// config dirs get a suffixed service (list them: security dump-keychain | grep "Claude Code").

async function claudeCreds(c = {}) {
  if (c.file) {
    const txt = await readTextFile(expand(c.file));
    return JSON.parse(txt).claudeAiOauth;
  }
  const service = c.keychain ?? "Claude Code-credentials";
  const args = ["find-generic-password", "-s", service, "-w"];
  if (c.keychainAccount) args.splice(1, 0, "-a", c.keychainAccount);
  const r = await exec("security", args, { timeout: 10000 });
  if (r.code !== 0) throw new Error("keychain");
  return JSON.parse(r.stdout.trim()).claudeAiOauth;
}

export async function readClaude(account) {
  const at = Date.now();
  let creds;
  try { creds = await claudeCreds(account.credentials); } catch { return { ok: false, at, error: "NO CLAUDE LOGIN FOUND" }; }
  if (!creds?.accessToken) return { ok: false, at, error: "NO CLAUDE TOKEN" };
  const plan = String(creds.subscriptionType ?? "").toUpperCase() || "CLAUDE";
  if (creds.expiresAt && Number(creds.expiresAt) < at) return { ok: false, at, plan, error: "TOKEN EXPIRED · OPEN CLAUDE TO RENEW" };
  try {
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: { Authorization: `Bearer ${creds.accessToken}`, "anthropic-beta": "oauth-2025-04-20" },
    });
    if (res.status === 401) return { ok: false, at, plan, error: "TOKEN EXPIRED · OPEN CLAUDE TO RENEW" };
    if (!res.ok) return { ok: false, at, plan, error: `UPLINK ${res.status}` };
    const d = await res.json();
    const win = (key, label, minutes, w) => w && w.utilization != null
      ? { key, label, minutes, used: Number(w.utilization), resetsAt: w.resets_at ? Date.parse(w.resets_at) : null }
      : null;
    const windows = [win("5h", "SESSION", 300, d.five_hour), win("7d", "WEEKLY", 10080, d.seven_day)].filter(Boolean);
    const extra = [
      win("opus", "OPUS · 7D", 10080, d.seven_day_opus),
      win("sonnet", "SONNET · 7D", 10080, d.seven_day_sonnet),
    ].filter(Boolean);
    return { ok: true, at, plan, windows, extra };
  } catch {
    return { ok: false, at, plan, error: "UPLINK UNREACHABLE" };
  }
}

// ---- Codex: the last rate-limit snapshot Codex wrote into its session logs ----
// home: the account's CODEX_HOME (default ~/.codex).

const CODEX_SCRIPT = `
d="$1/sessions"
[ -d "$d" ] || exit 3
for f in $(find "$d" -name 'rollout-*.jsonl' -mtime -8 2>/dev/null | xargs ls -t 2>/dev/null | head -8); do
  line=$(grep -h '"rate_limits":{"limit_id":"codex"' "$f" 2>/dev/null | tail -1)
  [ -z "$line" ] && line=$(grep -h '"rate_limits":{' "$f" 2>/dev/null | tail -1)
  if [ -n "$line" ]; then printf '%s\\n' "$line"; exit 0; fi
done
exit 4`;

export async function readCodex(account) {
  const at = Date.now();
  const dir = expand(account.home ?? "~/.codex");
  let r;
  try { r = await exec("sh", ["-c", CODEX_SCRIPT, "quota", dir], { timeout: 15000 }); } catch { return { ok: false, at, error: "LOG SCAN FAILED" }; }
  if (r.code === 3) return { ok: false, at, error: "NO CODEX SESSIONS AT " + (account.home ?? "~/.codex") };
  if (r.code !== 0 || !r.stdout.trim()) return { ok: false, at, error: "NO TELEMETRY IN LAST 8 DAYS" };
  let ev;
  try { ev = JSON.parse(r.stdout.trim()); } catch { return { ok: false, at, error: "LOG UNREADABLE" }; }
  const rl = ev?.payload?.rate_limits ?? ev?.rate_limits ?? findKey(ev, "rate_limits");
  if (!rl) return { ok: false, at, error: "NO RATE LIMITS IN LOG" };
  const seen = ev.timestamp ? Date.parse(ev.timestamp) : at;
  const win = (key, w) => {
    if (!w) return null;
    const minutes = Number(w.window_minutes) || (key === "p" ? 300 : 10080);
    let resetsAt = w.resets_at ? Number(w.resets_at) * 1000 : null;
    let used = Number(w.used_percent) || 0, stale = false;
    // The window rolled over since Codex last reported: it's full again.
    if (resetsAt && resetsAt < at) { used = 0; stale = true; resetsAt = null; }
    return { key, label: minutes <= 600 ? "SESSION" : "WEEKLY", minutes, used, resetsAt, stale };
  };
  const windows = [win("p", rl.primary), win("s", rl.secondary)].filter(Boolean).sort((a, b) => a.minutes - b.minutes);
  const plan = String(rl.plan_type ?? "CHATGPT").toUpperCase();
  return { ok: true, at, plan, seen, windows, extra: [] };
}

function findKey(o, k) {
  if (!o || typeof o !== "object") return null;
  if (k in o) return o[k];
  for (const v of Object.values(o)) { const f = findKey(v, k); if (f) return f; }
  return null;
}

// ---- Derived readings ----

export const windowLabel = (m) => (m >= 1440 ? `${Math.round(m / 1440)}D` : `${Math.round(m / 60)}H`);

export function span(ms) {
  if (ms == null || ms < 0) return "--";
  const m = Math.floor(ms / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  if (d > 0) return `${d}D ${String(h).padStart(2, "0")}H`;
  if (h > 0) return `${h}H ${String(mm).padStart(2, "0")}M`;
  return `${mm}M`;
}

// How usage tracks against an even burn across the window.
// expected: where an even pace would be now; projected: where this pace lands at reset.
export function pace(w, now = Date.now()) {
  if (!w.resetsAt) return { expected: null, projected: null, state: w.used >= 100 ? "DEPLETED" : "NOMINAL" };
  const total = w.minutes * 60000, left = Math.max(0, w.resetsAt - now);
  const f = Math.min(1, Math.max(0, 1 - left / total));
  const expected = f * 100;
  const projected = f > 0.04 ? w.used / f : null;
  let state = "NOMINAL";
  if (w.used >= 100) state = "DEPLETED";
  else if (projected != null && projected >= 100) state = "OVERBURN";
  else if (w.used > expected + 10) state = "ELEVATED";
  return { expected, projected, state };
}
