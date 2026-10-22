import type { Project } from "./api";
import "./project-tree.css";
export const INBOX = "00000000-0000-0000-0000-000000000000";
export function projectRows(projects: Project[]) {
  const rows: { project: Project; depth: number; path: string }[] = [];
  function visit(parentId: string | null, depth: number, prefix: string) {
    const children = projects.filter(p => (p.parentId || null) === parentId);
    if (parentId) children.sort((a, b) => Number(a.name) - Number(b.name));
    for (const project of children) {
      const path = prefix ? `${prefix} / ${project.name}` : project.name;
      rows.push({ project, depth, path });
      visit(project.id, depth + 1, path);
    }
  }
  visit(null, 0, "");
  return rows;
}
export function subtreeIds(projects: Project[], id: string): string[] {
  return [id, ...projects.filter(p => p.parentId === id).flatMap(p => subtreeIds(projects, p.id))];
}

const collapsed = new Set<string>();
try {
  const saved: unknown = JSON.parse(localStorage.getItem("glassnote.collapsedProjects") || "[]");
  if (Array.isArray(saved)) saved.filter((id): id is string => typeof id === "string").forEach(id => collapsed.add(id));
} catch { /* Collapsing still works when preferences cannot be read. */ }
export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
type ProjectRow = ReturnType<typeof projectRows>[number];

export function projectTreeHtml(projects: Project[], rowHtml: (row: ProjectRow) => string, prefix: string) {
  const branches: { root: ProjectRow; children: ProjectRow[] }[] = [];
  for (const row of projectRows(projects)) {
    if (row.depth === 0) branches.push({ root: row, children: [] });
    else branches.at(-1)?.children.push(row);
  }
  return branches.map(({root, children}) => {
    if (!children.length) return `<div class="project-tree-branch">${rowHtml(root)}</div>`;
    const id = escapeHtml(root.project.id), name = escapeHtml(root.project.name), closed = collapsed.has(root.project.id);
    return `<div class="project-tree-branch" data-tree-project="${id}" data-collapsed="${closed}"><div class="project-tree-row"><button type="button" class="project-disclosure" data-collapse-project="${id}" data-project-name="${name}" aria-expanded="${!closed}" aria-controls="${prefix}-${id}" aria-label="${closed ? "Expand" : "Collapse"} ${name}"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg></button>${rowHtml(root)}</div><div class="project-tree-children" id="${prefix}-${id}" aria-hidden="${closed}" ${closed ? "inert" : ""}><div class="project-tree-inner">${children.map(rowHtml).join("")}</div></div></div>`;
  }).join("");
}
function setCollapsed(id: string, closed: boolean) {
  if (closed) collapsed.add(id); else collapsed.delete(id);
  try { localStorage.setItem("glassnote.collapsedProjects", JSON.stringify([...collapsed])); } catch { /* Keep the preference for this window. */ }
  document.querySelectorAll<HTMLElement>("[data-tree-project]").forEach(branch => {
    if (branch.dataset.treeProject !== id) return;
    const button = branch.querySelector<HTMLButtonElement>(".project-disclosure")!;
    const children = branch.querySelector<HTMLElement>(".project-tree-children")!;
    if (closed && children.contains(document.activeElement)) button.focus({ preventScroll: true });
    branch.dataset.collapsed = String(closed);
    button.setAttribute("aria-expanded", String(!closed));
    button.setAttribute("aria-label", `${closed ? "Expand" : "Collapse"} ${button.dataset.projectName}`);
    children.inert = closed; children.setAttribute("aria-hidden", String(closed));
  });
}
export function expandProjectBranch(id: string) {
  if (collapsed.has(id)) setCollapsed(id, false);
}
document.addEventListener("click", event => {
  const button = (event.target as Element).closest<HTMLButtonElement>("[data-collapse-project]");
  if (button?.dataset.collapseProject) {
    event.preventDefault();
    setCollapsed(button.dataset.collapseProject, button.getAttribute("aria-expanded") === "true");
  }
});
