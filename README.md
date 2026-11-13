# herdr-quota

A [Herdr](https://herdr.dev) desktop-app mod that shows how much of your **Claude** and **Codex** subscription limits is left: a sci-fi gauge panel at the side of the window, plus a compact readout in the tab bar (`● CL 89 | ● CX 100`) that shows and hides it.

For each account it shows:

- the 5-hour (session) window and the weekly window, as % left on an arc gauge;
- the time until each window resets;
- the pace (NOMINAL / ELEVATED / OVERBURN / DEPLETED) and the projected usage at reset;
- a grey tick on each gauge marking where an even burn would put you right now.

Nothing in this repo is tied to one person. Each machine reads **its own** logins: whatever Claude Code and Codex are signed into there, or the accounts listed in that machine's config file.

## Install (for an agent: follow these steps in order)

Requirements: the Herdr desktop app (`herdr-app` on `PATH`, opened at least once so `~/.config/herdr-app` exists), plus `python3` for the layout step. The data side needs Claude Code and/or Codex signed in on the same machine.

1. **Clone and run the installer:**
   ```sh
   git clone <this repo> ~/Repos/herdr-quota   # or wherever
   cd ~/Repos/herdr-quota && ./install.sh
   ```
   The installer:
   - copies `mod/quota/` into `~/.config/herdr-app/mods/quota/` (`mod.json` first, so Herdr doesn't auto-dock a stray copy);
   - runs `herdr-app check` on it;
   - adds the toggle and the panel to the **layout that's currently shown**. Herdr's shipped layouts (`main`, `terminals`, `win98`) can't take structural changes, so the installer first clones one of those to `<name>-quota` and switches to the clone;
   - backs up the layout file (`*.bak-quota-<time>`) before editing it, and leaves it unchanged if the quota nodes are already there.

2. **Verify:**
   - `herdr-app status` should show `"errors": []`.
   - `herdr-app shot /tmp/q.png` should show the readout in the tab bar and the panel on the right.
   - If you see a second, full-height quota column, Herdr auto-docked a copy. Delete the layout node whose `content.mod` is `quota` and whose id is not `quota` or `quota-toggle`.

3. **Wiring the layout by hand** (if the script can't place things, e.g. a custom layout without a `tabs` block): edit `~/.config/herdr-app/layouts/<shown layout>.json`. Never edit a shipped layout; clone it first with `herdr-app do layout.clone --name main --as main-quota`.
   - Toggle, inside the row that holds the tab bar:
     `{"id":"quota-toggle","type":"block","size":{"px":150},"content":{"mod":"quota","props":{"role":"toggle"}}}`
   - Panel, inside the row that holds the `{"tab":"active"}` block:
     `{"id":"quota-panel","type":"column","hidden":false,"size":{"px":400},"min":340,"max":640,"children":[{"id":"quota","type":"block","content":{"mod":"quota"}}]}`
   - The id `quota-panel` matters: the toggle shows and hides that node.
   - Herdr applies the change live. If the file is invalid, it writes the reason to `layout.error` next to it.

4. **Accounts:** usually nothing to do (see below). On macOS, the first Claude read may make the system ask whether `security` can access the "Claude Code-credentials" keychain item. Choose **Always Allow**.

To update later: `git pull && ./install.sh`. The installer is idempotent and never touches the account config.

To uninstall:
- remove `~/.config/herdr-app/mods/quota/`;
- delete the `quota-toggle` and `quota-panel` nodes from the layout. If the installer wrapped the tab bar in a `quota-tabs-row` row, unwrap it, or restore the `*.bak-quota-*` backup.

## Accounts: auto-detect or `~/.config/herdr-quota/accounts.json`

**With no config file**, each machine auto-detects:

| Provider | Where the login comes from |
|---|---|
| Claude | the macOS keychain item `Claude Code-credentials`; otherwise `${CLAUDE_CONFIG_DIR:-~/.claude}/.credentials.json` (Linux) |
| Codex | `${CODEX_HOME:-~/.codex}/sessions` |

**To choose accounts yourself**, or to track more than one, create `~/.config/herdr-quota/accounts.json` on that machine. It lives outside the mod folder, so reinstalling never overwrites it. Start from `accounts.example.json`:

```json
{
  "accounts": [
    { "provider": "claude", "name": "Personal", "credentials": { "keychain": "Claude Code-credentials" } },
    { "provider": "claude", "name": "Work", "credentials": { "file": "~/.claude-work/.credentials.json" } },
    { "provider": "codex",  "name": "Codex", "home": "~/.codex" }
  ],
  "poll": { "claudeSeconds": 180, "codexSeconds": 60 }
}
```

- `provider`: `"claude"` or `"codex"`. Each account gets its own card. The tab-bar number is the lowest "% left" for that provider across its accounts.
- `name`: the card title. Set `"enabled": false` to hide an account without deleting it.
- Claude `credentials` takes one of:
  - `{ "keychain": "<service>" }` (macOS; add `"keychainAccount"` if one service holds several items). The default Claude Code config uses `Claude Code-credentials`. A Claude Code run with a different `CLAUDE_CONFIG_DIR` stores a suffixed service; find it with `security dump-keychain | grep "Claude Code"`.
  - `{ "file": "<path>" }`: a Claude Code `.credentials.json` (Linux, or a non-default config dir).
- Codex `home`: that account's `CODEX_HOME` directory (default `~/.codex`).
- The config is re-read on every poll, so you can edit it without restarting anything. If the JSON is invalid, the panel header says `BAD CONFIG`.
- Credentials never leave the machine except as the bearer token sent to `api.anthropic.com`. No secret is stored in this repo or in the config file. The config only says *where* each login lives.

## How the numbers are read

- **Claude**: the mod reads the Claude Code OAuth token and calls `GET https://api.anthropic.com/api/oauth/usage` with header `anthropic-beta: oauth-2025-04-20`. This is the same data Claude Code's `/usage` shows. The endpoint is **undocumented** and could change; the parsing is in `readClaude` in `mod/quota/data.js`. An expired token shows `TOKEN EXPIRED`. Running `claude` once refreshes it.
- **Codex**: Codex writes `rate_limits` snapshots into its session logs (`<CODEX_HOME>/sessions/**/rollout-*.jsonl`). The mod reads the newest snapshot from the last 8 days, so these numbers only update when Codex runs. The card shows `CACHED` and the time of the last signal when that was over an hour ago. A window whose reset time has passed shows as full (`ROLLED`).
- **Polling**: the tab-bar readout is always drawn, so it does the polling (Claude every 180 s, Codex every 60 s by default). It publishes the results through Herdr shared state; the panel only reads them, and its RESYNC button forces a refresh. Because of this, the toggle needs to be in the layout even if you mostly keep the panel open.

## Files

```
mod/quota/mod.json     "place": "none": the layout decides where it shows
mod/quota/main.js      the view: role "toggle" (tab-bar readout and poller) or the panel (default)
mod/quota/data.js      account loading/detection, the Claude and Codex readers, pace maths
install.sh             copy + check + add to the shown layout
scripts/add-to-layout.py   idempotent layout patcher (toggle after the `tabs` block, panel next to the active tab)
accounts.example.json  config template
```

Look and tuning: colors are in `C` and `ACCENT` at the top of `main.js`. The warning levels (amber at ≤25% left, red at ≤10%) are in `level()`, and the pace rules are in `pace()` in `data.js`. Herdr's mod API reference is `~/.config/herdr-app/AGENTS.md`, `herdr.d.ts` and `gpui-kit.d.ts` on any machine with the app installed. After any edit, run `herdr-app check ~/.config/herdr-app/mods/quota`.
