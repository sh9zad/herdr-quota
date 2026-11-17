#!/usr/bin/env python3
"""Add the quota tab-bar readout and side panel to a herdr-app layout. Idempotent.

Usage: add-to-layout.py <path to layouts/NAME.json> [--hidden] [--stack vitals,nextup,prs,fleet,pipelines,jira]

- Toggle ("quota-toggle"): placed right after the block whose mod is "tabs". If that block
  isn't already in a row, it's wrapped in one ("quota-tabs-row") that keeps its size.
- Sections strip ("quota-sections"): right after the toggle. One chip per stacked mod shows or hides it.
- Panel ("quota-panel" > "quota"): appended to the row that holds the active-tab block
  ({"content": {"tab": "active"}}), next to any other side panels.
- --stack: more mods stacked in the same column under quota, in that order (each gets
  props.panel = "quota-panel" so it can skip polling while the column is hidden).
Writes a backup next to the file first. Prints what it did.
"""
import json, shutil, sys, time

def walk(node, parent=None):
    yield node, parent
    for c in node.get("children", []) or []:
        yield from walk(c, node)

def find(root, pred):
    for n, p in walk(root):
        if pred(n):
            return n, p
    return None, None

def main():
    argv = sys.argv[1:]
    stack = []
    if "--stack" in argv:
        i = argv.index("--stack")
        stack = [m for m in (argv[i + 1] if i + 1 < len(argv) else "").split(",") if m]
        del argv[i:i + 2]
    args = [a for a in argv if not a.startswith("--")]
    if len(args) != 1:
        sys.exit(__doc__)
    path, hidden = args[0], "--hidden" in argv
    root = json.load(open(path))
    changed = []

    if not find(root, lambda n: n.get("id") == "quota-toggle")[0]:
        tabs, parent = find(root, lambda n: (n.get("content") or {}).get("mod") == "tabs")
        if not tabs:
            sys.exit("no block with mod 'tabs' found: add the toggle by hand (see README)")
        toggle = {"id": "quota-toggle", "type": "block", "size": {"px": 150},
                  "content": {"mod": "quota", "props": {"role": "toggle"}}}
        if parent.get("type") == "row":
            i = parent["children"].index(tabs)
            parent["children"].insert(i + 1, toggle)
        else:
            i = parent["children"].index(tabs)
            row = {"id": "quota-tabs-row", "type": "row", "size": tabs.get("size", {"px": 42}),
                   "resizable": False, "children": [tabs, toggle]}
            tabs["size"] = {"weight": 1}
            parent["children"][i] = row
        changed.append("toggle")

    if not find(root, lambda n: n.get("id") == "quota-sections")[0]:
        toggle, parent = find(root, lambda n: n.get("id") == "quota-toggle")
        i = parent["children"].index(toggle)
        parent["children"].insert(i + 1, {"id": "quota-sections", "type": "block", "size": {"px": 290},
                                          "content": {"mod": "quota", "props": {"role": "sections"}}})
        changed.append("sections strip")

    panel = find(root, lambda n: n.get("id") == "quota-panel")[0]
    if panel and panel.get("min", 0) > 80:  # older installs: let the compact mode shrink it
        panel["min"] = 80
        changed.append("compact min width")
    if not panel:
        main_block, row = find(root, lambda n: (n.get("content") or {}).get("tab") == "active")
        if not main_block or row.get("type") != "row":
            sys.exit("no row holding the active-tab block found: add the panel by hand (see README)")
        row["children"].append({
            "id": "quota-panel", "type": "column", "hidden": hidden,
            "size": {"px": 400}, "min": 80, "max": 640,
            "children": [{"id": "quota", "type": "block", "content": {"mod": "quota"}}],
        })
        changed.append("panel")
        panel = find(root, lambda n: n.get("id") == "quota-panel")[0]

    WEIGHTS = {"quota": 5, "vitals": 3, "nextup": 2, "prs": 3, "fleet": 2, "pipelines": 3, "jira": 3}
    for mod in stack:
        if find(root, lambda n: (n.get("content") or {}).get("mod") == mod)[0]:
            continue
        q = find(panel, lambda n: n.get("id") == "quota")[0]
        if q is not None and "size" not in q:
            q["size"] = {"weight": WEIGHTS["quota"]}
        panel["children"].append({"id": mod, "type": "block", "size": {"weight": WEIGHTS.get(mod, 3)},
                                  "min": 60, "content": {"mod": mod, "props": {"panel": "quota-panel"}}})
        changed.append(mod)

    if changed:
        shutil.copy(path, f"{path}.bak-quota-{time.strftime('%Y%m%d%H%M%S')}")
        with open(path, "w") as f:
            json.dump(root, f, indent=2)
        print(f"added {' and '.join(changed)} to {path}")
    else:
        print(f"already present in {path}")

if __name__ == "__main__":
    main()
