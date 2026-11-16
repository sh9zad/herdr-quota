#!/bin/sh
# Install the mods into this machine's herdr-app and stack them in the shown layout.
#   ./install.sh                     every mod: quota (+ tab-bar toggle and section strip), vitals, nextup, prs, fleet, pipelines, jira
#   ./install.sh quota vitals        only these (quota is always the column's anchor)
#   ./install.sh --mod-only [mods]   copy the mods only (wire the layout yourself)
# HERDR_APP_HOME overrides ~/.config/herdr-app, as it does for herdr-app itself.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
APP="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
ALL="quota vitals nextup prs fleet pipelines jira"

MOD_ONLY=0
[ "${1:-}" = "--mod-only" ] && { MOD_ONLY=1; shift; }
MODS="${*:-$ALL}"
case " $MODS " in *" quota "*) ;; *) MODS="quota $MODS" ;; esac

[ -d "$APP" ] || { echo "herdr-app home not found at $APP (open the Herdr app once first)"; exit 1; }
command -v herdr-app >/dev/null 2>&1 || { echo "herdr-app not on PATH"; exit 1; }

# 1. The mods. mod.json first: with "place": "none" herdr won't auto-dock a stray copy.
for m in $MODS; do
  [ -d "$HERE/mods/$m" ] || { echo "unknown mod: $m (have: $ALL)"; exit 1; }
  DEST="$APP/mods/$m"
  mkdir -p "$DEST"
  cp "$HERE/mods/$m/mod.json" "$DEST/mod.json"
  [ "$m" = quota ] || cp "$HERE/shared/hud.js" "$DEST/hud.js"
  for f in "$HERE/mods/$m"/*.js; do cp "$f" "$DEST/"; done
  herdr-app check "$DEST"
done

# 2. Per-machine config is never touched; absent means defaults / auto-detect.
[ -f "$HOME/.config/herdr-quota/accounts.json" ] && echo "quota accounts: ~/.config/herdr-quota/accounts.json" || echo "quota accounts: auto-detect"
case " $MODS " in *" jira "*) [ -f "$HOME/.config/herdr-mods/jira.json" ] || echo "jira: not configured yet; create ~/.config/herdr-mods/jira.json (README)";; esac
case " $MODS " in *" nextup "*) [ -f "$HOME/.config/herdr-mods/nextup.json" ] || echo "nextup: no calendar yet; create ~/.config/herdr-mods/nextup.json (README)";; esac

[ "$MOD_ONLY" = 1 ] && { echo "mods installed in $APP/mods"; exit 0; }

# 3. The layout. Shipped layouts (main, terminals, win98) can't change structure: clone first.
command -v python3 >/dev/null 2>&1 || { echo "python3 missing: add the layout nodes by hand (README)"; exit 1; }
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
STACK=$(echo "$MODS" | tr ' ' '\n' | grep -v '^quota$' | paste -sd, -)
python3 "$HERE/scripts/add-to-layout.py" "$APP/layouts/$LAYOUT.json" ${STACK:+--stack "$STACK"}
sleep 2
herdr-app status | python3 -c 'import json,sys; e=json.load(sys.stdin).get("errors") or []; print("herdr errors:", e) if e else print("ok: no herdr errors")'
echo "done: click the CL/CX readout in the tab bar to show or hide the column"
