#!/bin/sh
# Install the quota mod into this machine's herdr-app, and add it to the shown layout.
#   ./install.sh              copy the mod + add toggle and panel to the shown layout
#   ./install.sh --mod-only   copy the mod only (wire the layout yourself)
# HERDR_APP_HOME overrides ~/.config/herdr-app, as it does for herdr-app itself.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
APP="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
DEST="$APP/mods/quota"

[ -d "$APP" ] || { echo "herdr-app home not found at $APP (open the Herdr app once first)"; exit 1; }
command -v herdr-app >/dev/null 2>&1 || { echo "herdr-app not on PATH"; exit 1; }

# 1. The mod. mod.json first: with "place": "none" herdr won't auto-dock a stray copy.
mkdir -p "$DEST"
cp "$HERE/mod/quota/mod.json" "$DEST/mod.json"
cp "$HERE/mod/quota/data.js" "$DEST/data.js"
cp "$HERE/mod/quota/main.js" "$DEST/main.js"
herdr-app check "$DEST"

# 2. Per-machine account config: never overwritten; absent means auto-detect.
CFG="$HOME/.config/herdr-quota/accounts.json"
[ -f "$CFG" ] && echo "accounts: using $CFG" || echo "accounts: auto-detect (create $CFG to choose; see accounts.example.json)"

[ "${1:-}" = "--mod-only" ] && { echo "mod installed at $DEST"; exit 0; }

# 3. The layout. Shipped layouts (main, terminals, win98) can't change structure: clone first.
command -v python3 >/dev/null 2>&1 || { echo "python3 missing: add the layout nodes by hand (README, step 3)"; exit 1; }
LAYOUT=$(herdr-app status | python3 -c 'import json,sys; print(json.load(sys.stdin)["layout"])')
case "$LAYOUT" in
  main|terminals|win98)
    NEW="$LAYOUT-quota"
    if [ ! -f "$APP/layouts/$NEW.json" ]; then
      herdr-app do layout.clone --name "$LAYOUT" --as "$NEW" >/dev/null
      sleep 1
    else
      herdr-app do layout.switch --name "$NEW" >/dev/null
    fi
    LAYOUT="$NEW" ;;
esac
python3 "$HERE/scripts/add-to-layout.py" "$APP/layouts/$LAYOUT.json"
sleep 2
herdr-app status | python3 -c 'import json,sys; e=json.load(sys.stdin).get("errors") or []; print("herdr errors:", e) if e else print("ok: no herdr errors")'
echo "done: click the CL/CX readout in the tab bar to show or hide the panel"
