import { layout, run } from "herdr";

export const PANEL = "quota-panel";
export const SECTIONS = [["quota", "QTA"], ["vitals", "VIT"], ["nextup", "NXT"], ["prs", "PRS"], ["fleet", "FLT"], ["pipelines", "CI"], ["jira", "JIRA"]];

export function find(node, id) {
  if (!node) return null;
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// Read the current layout at click time, so a stale render cannot close the last section.
export function hideSection(id) {
  const column = find(layout(), PANEL);
  const visible = (column?.children ?? []).filter((node) => !node.hidden);
  if (visible.length > 1 && visible.some((node) => node.id === id)) {
    run("layout.hide", { id });
  }
}

export function toggleSection(id) {
  const column = find(layout(), PANEL), section = find(column, id);
  if (!section) return;
  if (column.hidden || section.hidden) {
    if (column.hidden) run("layout.show", { id: PANEL });
    run("layout.show", { id });
  } else {
    hideSection(id);
  }
}
