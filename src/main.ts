import "./style.css";
import { listen, emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { call, media, native, type Capture, type Snapshot } from "./api";
import { INBOX, projectRows, subtreeIds, projectTreeHtml, expandProjectBranch } from "./projects";
import { icon } from "./icons";
import { afterPaint, prepareGlass } from "./presentation";

const root = document.querySelector<HTMLDivElement>("#app")!;
const view = new URLSearchParams(location.search).get("view") || "library";
document.body.dataset.view = view;
document.documentElement.dataset.view = view;
const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const date = (s: string) =>
  new Date(s).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const time = (s: string) =>
  new Date(s).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
const button = (action: string, label: string, symbol: string, cls = "") =>
  `<button type="button" data-action="${action}" class="${cls}" title="${label}" aria-label="${label}">${icon(symbol)}<span>${label}</span></button>`;
const iconButton = (action: string, label: string, symbol: string, cls = "") =>
  `<button type="button" data-action="${action}" class="icon-button ${cls}" title="${label}" aria-label="${label}">${icon(symbol)}</button>`;
let data: Snapshot;
let selectedId: string | null = null;
let projectId = "";
let detailKey = "";
let projectsKey = "", capturesKey = "", listedProject = "";
let modelProgress = 0;
let transcriptionProgress = 0;
let refreshQueued = false;
let refreshAgain = false;
let libraryInitialized = false;
const edits = new Map<string, string>();
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
let saveChain = Promise.resolve();

function toast(message: unknown, error = false) {
  let container = document.querySelector<HTMLDivElement>("#toast");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast";
    container.setAttribute("role", "status");
    document.body.append(container);
  }
  container.textContent = String(message);
  container.dataset.error = String(error);
  container.classList.add("visible");
  setTimeout(
    () => container?.classList.remove("visible"),
    error ? 10000 : 6000,
  );
}
async function safely(work: () => Promise<unknown>) {
  try {
    await work();
  } catch (error) {
    toast(error, true);
  }
}
function markSaved(label: string) {
  const el = document.querySelector("#save-status");
  if (el) el.textContent = label;
}
function queueSave(id: string, text: string) {
  edits.set(id, text);
  markSaved("Saving…");
  clearTimeout(saveTimers.get(id));
  saveTimers.set(
    id,
    setTimeout(() => {
      // persistEdit reports the failure and retains the edit for a later retry.
      void persistEdit(id).catch(() => {});
    }, 650),
  );
}
async function persistEdit(id: string) {
  clearTimeout(saveTimers.get(id));
  saveTimers.delete(id);
  const text = edits.get(id);
  if (text === undefined) return;
  const task = saveChain.then(async () => {
    try {
      await call("save_transcript", { id, text });
      const capture = data?.captures.find((c) => c.id === id);
      if (capture) capture.transcript = text;
      if (edits.get(id) === text) edits.delete(id);
      markSaved("Saved");
    } catch (error) {
      markSaved("Not saved");
      toast(error, true);
      throw error;
    }
  });
  saveChain = task.catch(() => {});
  await task;
}
async function flushEdits() {
  for (const id of [...edits.keys()]) await persistEdit(id);
  await saveChain;
}

function dialog(
  title: string,
  body: string,
  confirmLabel: string,
  inputValue?: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    const el = document.createElement("dialog");
    el.className = "small-dialog";
    el.innerHTML = `<form method="dialog"><h2>${esc(title)}</h2><p>${esc(body)}</p>${inputValue !== undefined ? `<label class="sr-only" for="dialog-name">Project name</label><input id="dialog-name" name="name" value="${esc(inputValue)}" maxlength="80" required autocomplete="off">` : ""}<footer><button value="cancel" formnovalidate>Cancel</button><button class="primary ${confirmLabel.startsWith("Delete") ? "destructive" : ""}" value="confirm">${esc(confirmLabel)}</button></footer></form>`;
    el.addEventListener(
      "close",
      () => {
        const value =
          el.returnValue === "confirm"
            ? el.querySelector<HTMLInputElement>("input")?.value || "confirmed"
            : null;
        el.remove();
        resolve(value);
      },
      { once: true },
    );
    document.body.append(el);
    el.showModal();
    const input = el.querySelector<HTMLInputElement>("input");
    if (input) {
      input.focus();
      input.select();
    }
  });
}
function currentCapture() {
  return data?.captures.find(
    (c) => c.id === selectedId,
  );
}
function renderMovePicker(c: Capture) {
  const picker = document.querySelector<HTMLElement>("#move-project");
  if (!picker) return;
  const rows = projectRows(data.projects), selected = rows.find(row => row.project.id === c.projectId);
  const summary = picker.querySelector("summary")!;
  summary.setAttribute("aria-label", `Move capture from ${selected?.path || "Inbox"}`);
  summary.setAttribute("aria-disabled", String(isBusy(c)));
  const label = summary.querySelector("span")!;
  if (label.textContent !== selected?.path) label.textContent = selected?.path || "Inbox";
  const menu = picker.querySelector<HTMLElement>(".destination-options")!;
  const key = JSON.stringify(data.projects);
  if (menu.dataset.key !== key) {
    menu.innerHTML = projectTreeHtml(data.projects, ({project: p, depth, path}) => `<button type="button" class="destination-option ${depth ? "subfolder" : ""}" style="--depth:${depth}" data-move-project="${p.id}" title="${esc(path)}">${icon(p.id === INBOX ? "inbox" : "folder")}<span>${esc(p.name)}</span>${icon("check")}</button>`, "move-children");
    menu.dataset.key = key;
  }
  menu.querySelectorAll<HTMLButtonElement>("[data-move-project]").forEach(button => {
    button.setAttribute("aria-pressed", String(button.dataset.moveProject === c.projectId));
    button.disabled = isBusy(c);
  });
}
function isBusy(c: Capture) {
  return c.status === "recording" || c.status === "transcribing";
}

function renderShell() {
  root.innerHTML = `<main class="app-window"><header class="titlebar" data-tauri-drag-region><div class="brand" data-tauri-drag-region><img src="/glassnote.svg" alt="">Glassnote</div><div class="titlebar-note" data-tauri-drag-region>Screenshots with a voice</div><div class="window-controls">${iconButton("minimize", "Minimize", "minimize")}${iconButton("maximize", "Maximize", "maximize")}${iconButton("close", "Close to tray", "close")}</div></header><div class="workspace"><aside class="sidebar"><div class="sidebar-heading"><span>Projects</span>${iconButton("new-project", "New project", "plus")}</div><nav id="projects" class="project-tree" aria-label="Projects"></nav><div class="sidebar-bottom"><div id="local-state"></div>${button("settings", "Settings", "settings", "quiet")}<span class="shortcut" id="shortcut-label"></span></div></aside><section class="library"><header class="library-heading"><div><h1 id="project-name"></h1><span id="capture-count" class="muted"></span></div><div class="library-actions"><details class="project-actions-menu"><summary title="Project actions" aria-label="Project actions">${icon("more")}</summary><div class="project-action-list">${button("new-subproject", "New subfolder", "plus")}${button("rename-project", "Rename project", "rename")}${button("copy-folder", "Copy folder as path", "link")}${button("export-zip", "Export as ZIP", "export")}<hr>${button("delete-project", "Delete project", "trash", "danger")}</div></details>${button("capture", "Capture", "plus", "primary")}</div></header><div id="warning" class="warning" hidden></div><div class="library-content"><div id="captures" class="capture-list" aria-label="Captures"></div><div id="detail" class="detail"></div></div></section></div></main>`;
}
function renderLibrary() {
  const projects = document.querySelector("#projects")!;
  const rows = projectRows(data.projects);
  const treeKey = JSON.stringify(rows.map(({project: p}) => [p, data.captures.filter(c => c.projectId === p.id).length]));
  if (treeKey !== projectsKey) {
    projectsKey = treeKey;
    projects.innerHTML = projectTreeHtml(data.projects, ({project: p, depth, path}) =>
      `<button class="project ${depth ? "subfolder" : "root-project"}" style="--depth:${depth}" title="${esc(path)}" data-project="${p.id}">${icon(p.id === INBOX ? "inbox" : "folder")}<span>${esc(p.name)}</span><small>${data.captures.filter(c => c.projectId === p.id).length}</small></button>`, "library-children");
  }
  projects.querySelectorAll<HTMLButtonElement>("[data-project]").forEach(button => {
    button.classList.toggle("selected", button.dataset.project === projectId);
    button.setAttribute("aria-current", button.dataset.project === projectId ? "page" : "false");
  });
  const project = data.projects.find((p) => p.id === projectId)!;
  document.querySelector<HTMLButtonElement>('[data-action="new-subproject"]')!.hidden = !!project.parentId;
  const heading = document.querySelector("#project-name")!;
  heading.textContent = project.parentId ? `Folder ${project.name}` : project.name;
  heading.setAttribute("title", projectRows(data.projects).find(row => row.project.id === projectId)?.path || project.name);
  let breadcrumb = document.querySelector<HTMLButtonElement>("#parent-project");
  if (!breadcrumb) { breadcrumb = document.createElement("button"); breadcrumb.id = "parent-project"; breadcrumb.className = "project-breadcrumb"; heading.before(breadcrumb); }
  const parent = data.projects.find(p => p.id === project.parentId);
  breadcrumb.hidden = !parent; breadcrumb.textContent = parent ? `‹ ${parent.name}` : "";
  if (parent) breadcrumb.dataset.project = parent.id;
  document.querySelector<HTMLButtonElement>('[data-action="delete-project"]')!.disabled = projectId === INBOX;
  const captures = data.captures.filter((c) => c.projectId === projectId);
  document.querySelector("#capture-count")!.textContent =
    `${captures.length} ${captures.length === 1 ? "capture" : "captures"}${data.projects.some(p => p.parentId === projectId) ? ` · ${data.projects.filter(p => p.parentId === projectId).length} subfolders` : ""}`;
  const rename = document.querySelector<HTMLButtonElement>(
    '[data-action="rename-project"]',
  )!;
  rename.hidden = !!project.parentId;
  rename.disabled = projectId === INBOX || !!project.parentId;
  const deleteButton = document.querySelector<HTMLButtonElement>('[data-action="delete-project"]')!;
  deleteButton.querySelector("span")!.textContent = project.parentId ? "Delete subfolder" : "Delete project";
  deleteButton.setAttribute("aria-label", project.parentId ? "Delete subfolder" : "Delete project");
  const list = document.querySelector("#captures")!;
  const listKey = JSON.stringify(captures.map(c => [c.id, c.screenshotPath, c.audioPath, c.createdAt, c.draft, c.status, c.transcript]));
  if (listKey !== capturesKey || listedProject !== projectId) {
  const previousScroll = listedProject === projectId ? list.scrollTop : 0;
  capturesKey = listKey; listedProject = projectId;
  list.innerHTML = captures.length
    ? captures
        .map(
          (c, i) =>
            `<button class="capture-item ${c.id === selectedId ? "selected" : ""}" data-capture="${c.id}" aria-pressed="${c.id === selectedId}"><div class="thumbnail"><img loading="lazy" src="${esc(media(c.screenshotPath))}" alt="Screenshot ${captures.length - i}">${c.audioPath ? `<span class="voice-badge" title="Voice note">${icon("wave")}</span>` : ""}</div><div class="capture-item-meta"><span>${date(c.createdAt)}</span><span>${c.draft ? "Unfinished" : time(c.createdAt)}</span></div><p>${esc(c.transcript ? c.transcript.slice(0, 90) : c.status === "transcribing" ? "Transcribing…" : c.audioPath ? "Voice note" : "No voice note")}</p></button>`,
        )
        .join("")
    : '<div class="list-empty">Your captures<br>will appear here.</div>';
  list.scrollTop = previousScroll;
  }
  list.querySelectorAll<HTMLButtonElement>("[data-capture]").forEach(button => {
    button.classList.toggle("selected", button.dataset.capture === selectedId);
    button.setAttribute("aria-pressed", String(button.dataset.capture === selectedId));
  });
  const local = document.querySelector("#local-state")!;
  local.innerHTML = `<span class="status-dot ${data.modelReady ? "ready" : ""}"></span><span>${data.modelDownloading ? "Downloading model" : data.modelReady ? "Speech model ready" : "Set up voice notes"}</span>`;
  document.querySelector("#shortcut-label")!.textContent =
    data.settings.shortcut.replaceAll("+", " + ");
  const warnings = [data.shortcutError, ...data.warnings].filter(Boolean);
  const warning = document.querySelector<HTMLDivElement>("#warning")!;
  warning.hidden = !warnings.length;
  warning.textContent = warnings.join(" ");
  renderDetail();
}
function renderDetail() {
  const c = currentCapture();
  const el = document.querySelector<HTMLDivElement>("#detail")!;
  const key = c
    ? `${c.id}|${c.status}|${c.audioPath}|${c.audioSeconds}|${c.screenshotPath}|${JSON.stringify(c.annotations)}|${c.draft}|${c.error}`
    : "empty";
  if (key === detailKey) {
    const input = el.querySelector<HTMLTextAreaElement>("#transcript");
    if (c && input && !edits.has(c.id) && document.activeElement !== input)
      input.value = c.transcript;
    if (c) renderMovePicker(c);
    return;
  }
  detailKey = key;
  if (!c) {
    el.innerHTML = `<div class="empty-state"><div class="empty-symbol">${icon("capture")}<span>${icon("wave")}</span></div><h2>Keep the screen<br>and the thought together.</h2><p>Capture a detail, say what matters,<br>and keep them in one place.</p>${button("capture", "Take a screenshot", "capture", "primary")}<span class="empty-shortcut">Or press ${esc(data.settings.shortcut)}</span></div>`;
    return;
  }
  el.innerHTML = `<div class="detail-toolbar"><span class="detail-date">${date(c.createdAt)} at ${time(c.createdAt)}</span><div>${c.draft ? button("resume", "Continue capture", "mic", "quiet") : ""}<details id="move-project" class="destination-picker"><summary title="Move capture to a folder">${icon("folder")}<span></span>${icon("down")}</summary><div class="destination-menu"><p>Move to</p><div class="destination-options project-tree"></div></div></details>${iconButton("delete", "Delete capture", "trash", "danger")}</div></div><div class="detail-scroll"><figure class="screenshot"><img src="${esc(media(c.screenshotPath))}" alt="Captured screenshot" draggable="false"><figcaption>${c.width} × ${c.height}</figcaption></figure><section class="note"><div class="note-heading"><h2>${icon("wave")}Voice note</h2><span id="save-status" class="muted">${isBusy(c) ? "" : edits.has(c.id) ? "Not saved" : "Saved"}</span></div>${c.error ? `<div class="note-error">${esc(c.error)}${c.audioPath ? button("retry", "Retry transcription", "wave", "quiet") : button("resume", "Record a note", "mic", "quiet")}</div>` : ""}${isBusy(c) ? `<div class="processing"><span class="spinner"></span><span id="transcription-label">${c.status === "recording" ? "Recording in the floating toolbar…" : "Transcribing on your computer…"}</span></div>` : ""}<label class="sr-only" for="transcript">Transcript</label><textarea id="transcript" spellcheck="true" placeholder="${c.audioPath ? "Your transcript will appear here." : "Add a note, or continue this capture to record your voice."}" ${isBusy(c) ? "disabled" : ""}>${esc(edits.get(c.id) ?? c.transcript)}</textarea><div class="note-foot">${icon("link")}Linked to this screenshot${!c.draft ? button("resume", "Continue recording", "mic", "text-button") : ""}</div></section>${c.annotations.some(a => a.type === "pin") ? `<section class="note numbered-library"><div class="note-heading"><h2>Numbered notes</h2>${button("resume", "Edit annotations", "rename", "text-button")}</div>${c.annotations.filter(a => a.type === "pin").map((a, i) => `<div class="library-pin"><span>${i + 1}</span><p>${esc(a.text || "No text yet")}</p></div>`).join("")}</section>` : ""}</div>`;
  renderMovePicker(c);
}
function updateModelProgress() {
  const percent = Math.round(modelProgress * 100);
  const fill = document.querySelector<HTMLElement>("#model-progress-fill");
  if (fill) fill.style.width = `${percent}%`;
  const label = document.querySelector("#model-progress-label");
  if (label) label.textContent = `${percent}% downloaded`;
}
async function refresh() {
  if (libraryInitialized && document.hidden) { refreshAgain = true; return; }
  if (refreshQueued) {
    refreshAgain = true;
    return;
  }
  refreshQueued = true;
  try {
    data = await call("snapshot", {});
    document.body.classList.toggle("opaque", !data.transparency);
    if (!projectId || !data.projects.some((p) => p.id === projectId))
      projectId = data.settings.activeProjectId;
    {
      if (
        !selectedId ||
        !data.captures.some(
          (c) => c.id === selectedId && c.projectId === projectId,
        )
      )
        selectedId =
          data.captures.find((c) => c.projectId === projectId)?.id || null;
      renderLibrary();
    }
    renderSettingsStatus();
    libraryInitialized = true;
  } finally {
    refreshQueued = false;
    if (refreshAgain) {
      refreshAgain = false;
      void safely(refresh);
    }
  }
}
function renderSettingsStatus() {
  const status = document.querySelector("#model-settings-status");
  if (!status) return;
  status.innerHTML = `<div class="model-status"><span class="status-dot ${data.modelReady ? "ready" : ""}"></span>${data.modelReady ? "Ready for offline transcription" : data.modelDownloading ? "Downloading speech model" : "One download. Then fully offline."}</div><p>Whisper tiny.en · English · 32 MB<br>Transcription runs on your computer.</p>${data.modelDownloading ? '<div class="progress-track"><div id="model-progress-fill"></div></div><span id="model-progress-label">Downloading…</span>' + button("cancel-download", "Cancel download", "close", "quiet") : button("download", data.modelReady ? "Download again" : "Download speech model", "wave", data.modelReady ? "quiet" : "primary")}`;
  updateModelProgress();
}
function openSettings() {
  if (document.querySelector("#settings-dialog")) return;
  const el = document.createElement("dialog");
  el.id = "settings-dialog";
  el.className = "settings-dialog";
  el.innerHTML = `<header><h2>Settings</h2>${iconButton("close-settings", "Close settings", "close")}</header><section><h3>Voice notes</h3><div id="model-settings-status"></div></section><section><h3>Capture shortcut</h3><p>Works while Glassnote is running in the tray.</p><form id="shortcut-form"><label class="sr-only" for="shortcut-input">Keyboard shortcut</label><input id="shortcut-input" value="${esc(data.settings.shortcut)}" spellcheck="false" maxlength="80"><button type="submit">Save shortcut</button></form><p class="setting-hint">For example: Ctrl+Alt+S</p></section><section class="privacy-note">${icon("folder")}<p>Your screenshots, voice recordings, and transcripts stay on this computer. Copy a folder path to share with an agent, or export a ZIP.</p></section>`;
  el.addEventListener("close", () => el.remove(), { once: true });
  document.body.append(el);
  renderSettingsStatus();
  el.showModal();
}

document.addEventListener("pointerdown", event => {
  if (!(event.target as Element).closest(".project-actions-menu")) document.querySelector(".project-actions-menu")?.removeAttribute("open");
  if (!(event.target as Element).closest(".destination-picker")) document.querySelector(".destination-picker")?.removeAttribute("open");
});
document.addEventListener("click", (event) => {
  if (view === "recorder") return;
  const target = (event.target as Element).closest<HTMLElement>(
    "[data-action],[data-project],[data-capture],[data-move-project]",
  );
  if (!target) return;
  void safely(async () => {
    if (target.dataset.moveProject) {
      const capture = currentCapture();
      document.querySelector("#move-project")?.removeAttribute("open");
      if (capture && !isBusy(capture) && capture.projectId !== target.dataset.moveProject) {
        await flushEdits();
        await call("move_capture", { id: capture.id, projectId: target.dataset.moveProject });
        await refresh();
      }
      return;
    }
    if (target.dataset.project) {
      await flushEdits();
      projectId = target.dataset.project;
      selectedId = null;
      detailKey = "";
      await call("choose_project", { id: projectId });
      await refresh();
      return;
    }
    if (target.dataset.capture) {
      await flushEdits();
      selectedId = target.dataset.capture;
      detailKey = "";
      renderLibrary();
      return;
    }
    const action = target.dataset.action;
    document.querySelector<HTMLDetailsElement>(".project-actions-menu")?.removeAttribute("open");
    const c = currentCapture();
    switch (action) {
      case "minimize":
        await flushEdits();
        await getCurrentWindow().minimize();
        break;
      case "maximize":
        await getCurrentWindow().toggleMaximize();
        break;
      case "close":
        await flushEdits();
        await getCurrentWindow().close();
        break;
      case "capture":
        await flushEdits();
        await call("capture_screen", {});
        break;
      case "settings":
        openSettings();
        break;
      case "close-settings":
        document.querySelector<HTMLDialogElement>("#settings-dialog")?.close();
        break;
      case "new-subproject": {
        await flushEdits();
        target.setAttribute("disabled", "");
        try {
          const p = await call("create_project", { name: "", parentId: projectId });
          expandProjectBranch(projectId);
          projectId = p.id; selectedId = null;
          await call("choose_project", { id: p.id });
          await refresh();
        } finally { target.removeAttribute("disabled"); }
        break;
      }
      case "new-project": {
        await flushEdits();
        const name = await dialog("New project", "Keep related captures in one place.", "Create project", "");
        if (name) {
          const p = await call("create_project", { name, parentId: null });
          projectId = p.id; selectedId = null;
          await call("choose_project", { id: p.id });
          await refresh();
        }
        break;
      }
      case "rename-project": {
        const p = data.projects.find((p) => p.id === projectId)!;
        const name = await dialog(
          "Rename project",
          "Choose a name for this group of captures.",
          "Rename",
          p.name,
        );
        if (name) {
          await call("rename_project", { id: p.id, name });
          await refresh();
        }
        break;
      }
      case "delete-project": {
        const project = data.projects.find(p => p.id === projectId)!;
        const ids = subtreeIds(data.projects, projectId);
        const count = data.captures.filter(c => ids.includes(c.projectId)).length;
        if (await dialog(`Delete ${project.name}?`, `Permanently delete ${count} ${count === 1 ? "capture" : "captures"}${ids.length > 1 ? ` and ${ids.length - 1} subfolders` : ""}, including their screenshots, notes, and recordings. This cannot be undone.`, "Delete everything")) {
          await flushEdits(); await call("delete_project", { id: projectId });
          projectId = project.parentId || INBOX; selectedId = null; detailKey = "";
          await refresh(); toast("Project and its contents deleted");
        }
        break;
      }
      case "copy-folder":
      case "export-zip": {
        await flushEdits(); target.setAttribute("disabled", "");
        try {
          if (action === "copy-folder") {
            await call("copy_project_path", { projectId });
            toast("Folder path copied · current snapshot, including subfolders");
          } else {
            const path = await call("export_project_zip", { projectId });
            if (path) toast(`ZIP saved to ${path}`);
          }
        } finally { target.removeAttribute("disabled"); }
        break;
      }
      case "delete":
        if (
          c &&
          (await dialog(
            "Delete this capture?",
            "This removes its screenshot, transcript, and recording from this computer.",
            "Delete capture",
          ))
        ) {
          await flushEdits();
          await call("delete_capture", { id: c.id });
          selectedId = null;
          await refresh();
        }
        break;
      case "resume":
        if (c) {
          await flushEdits();
          await call("resume_capture", { id: c.id });
        }
        break;
      case "retry":
        if (c) {
          await flushEdits();
          transcriptionProgress = 0;
          await call("retry_transcription", { id: c.id });
          await refresh();
        }
        break;
      case "library":
        await call("open_library", {});
        break;
      case "setup":
        await call("open_library", {});
        await listenOnceSettings();
        break;
      case "download":
        modelProgress = 0;
        await call("download_model", {});
        await refresh();
        break;
      case "cancel-download":
        await call("cancel_model_download", {});
        toast("Cancelling download…");
        break;
    }
  });
});
async function listenOnceSettings() {
  await emitTo("main", "open-settings", {});
}
document.addEventListener("input", (event) => {
  if (view === "recorder") return;
  const input = event.target as HTMLTextAreaElement;
  if (input.id === "transcript" || input.id === "recorder-transcript") {
    const c = currentCapture();
    if (c) queueSave(c.id, input.value);
  }
});
document.addEventListener("submit", (event) => {
  if (view === "recorder") return;
  if ((event.target as HTMLElement).id === "shortcut-form") {
    event.preventDefault();
    void safely(async () => {
      await call("set_shortcut", {
        value: document
          .querySelector<HTMLInputElement>("#shortcut-input")!
          .value.trim(),
      });
      toast("Capture shortcut saved");
      await refresh();
    });
  }
});
document.addEventListener("keydown", (event) => {
  if (view === "recorder") return;
  const menu = document.querySelector<HTMLElement>(".destination-picker[open],.project-actions-menu[open]");
  if (menu && event.key === "Escape") {
    menu.removeAttribute("open"); menu.querySelector("summary")?.focus(); event.preventDefault();
  }
  if (menu && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    const buttons = [...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled):not([hidden])")].filter(button => !button.closest("[inert]") && button.checkVisibility());
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
    buttons[next]?.focus(); event.preventDefault();
  }
  if ((event.ctrlKey || event.metaKey) && event.key === "s") {
    event.preventDefault();
    void safely(flushEdits);
  }
});

async function selector() {
  const info = await call("selector_info", {});
  root.innerHTML = `<main class="selection-screen"><img class="frozen-screen" data-glass-backdrop src="${esc(media(info.screenshotPath))}" alt="" draggable="false" crossorigin="anonymous"><div class="selection-dimmer"></div><div class="selection-hint glass">${icon("capture")}Click for full screen · drag for a detail<span>Esc to cancel</span></div><div id="selection-box" hidden><span id="selection-size"></span></div><div id="selection-error" role="alert"></div></main>`;
  const screen = document.querySelector<HTMLElement>(".selection-screen")!;
  const box = document.querySelector<HTMLElement>("#selection-box")!;
  let start: { x: number; y: number } | null = null;
  let end = { x: 0, y: 0 };
  let pending = false;
  await listen("capture-selected", () => {
    pending = true;
    draw();
    screen.classList.add("capture-held");
    document.querySelector(".selection-hint")?.classList.add("hidden");
  });
  const draw = () => {
    if (!start) return;
    const dragging = Math.hypot(end.x - start.x, end.y - start.y) >= 5;
    screen.classList.toggle("drag-selecting", dragging && !pending);
    if (!dragging && !pending) { box.hidden = true; return; }
    const x = Math.min(start.x, end.x),
      y = Math.min(start.y, end.y),
      w = Math.abs(end.x - start.x),
      h = Math.abs(end.y - start.y);
    box.hidden = false;
    Object.assign(box.style, {
      left: `${x}px`,
      top: `${y}px`,
      width: `${w}px`,
      height: `${h}px`,
    });
    document.querySelector("#selection-size")!.textContent =
      `${Math.round((w * info.width) / innerWidth)} × ${Math.round((h * info.height) / innerHeight)}`;
  };
  screen.addEventListener("pointerdown", (event) => {
    if (pending || event.button !== 0) return;
    start = { x: event.clientX, y: event.clientY };
    end = { ...start };
    screen.setPointerCapture(event.pointerId);
    document.querySelector(".selection-hint")?.classList.add("hidden");
    draw();
  });
  screen.addEventListener("pointermove", (event) => {
    if (!start || pending) return;
    end = {
      x: Math.max(0, Math.min(innerWidth, event.clientX)),
      y: Math.max(0, Math.min(innerHeight, event.clientY)),
    };
    draw();
  });
  screen.addEventListener("pointerup", (event) => {
    if (!start || pending) return;
    screen.releasePointerCapture(event.pointerId);
    end = {
      x: Math.max(0, Math.min(innerWidth, event.clientX)),
      y: Math.max(0, Math.min(innerHeight, event.clientY)),
    };
    if (Math.hypot(end.x - start.x, end.y - start.y) < 5) {
      start = { x: 0, y: 0 };
      end = { x: innerWidth, y: innerHeight };
    } else if (Math.abs(end.x - start.x) < 2 || Math.abs(end.y - start.y) < 2) {
      start = null; box.hidden = true; screen.classList.remove("drag-selecting"); document.querySelector(".selection-hint")?.classList.remove("hidden"); return;
    }
    pending = true;
    draw();
    screen.classList.add("capture-held");
    const selection = {
      x1: start.x,
      y1: start.y,
      x2: end.x,
      y2: end.y,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
    };
    void call("select_region", { selection }).catch((error) => {
      pending = false;
      start = null;
      box.hidden = true;
      screen.classList.remove("capture-held", "drag-selecting");
      document.querySelector(".selection-hint")?.classList.remove("hidden");
      document.querySelector("#selection-error")!.textContent = String(error);
    });
  });
  screen.addEventListener("pointercancel", () => {
    if (!pending) {
      start = null;
      box.hidden = true; screen.classList.remove("drag-selecting"); document.querySelector(".selection-hint")?.classList.remove("hidden");
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape")
      void safely(() => call("cancel_capture", {}));
  });
  await document.querySelector<HTMLImageElement>(".frozen-screen")!.decode();
  await prepareGlass();
  await call("window_ready", {});
}
async function boot() {
  if (!native) {
    root.innerHTML =
      '<div class="desktop-only"><img src="/glassnote.svg" alt=""><h1>Glassnote</h1><p>Open the desktop app to capture a screenshot and record a voice note.</p></div>';
    return;
  }
  if (view === "selector") {
    await selector();
    return;
  }
  if (view === "recorder") {
    const { bootOverlay } = await import("./overlay");
    await bootOverlay(root);
    return;
  }
  if (view !== "recorder") renderShell();
  await listen("library-changed", () => {
    void safely(refresh);
  });
  await listen<{ captureId: string }>("transcription-complete", () => {
    void safely(refresh);
  });
  await listen<string>("app-error", (event) => toast(event.payload, true));
  await listen("open-settings", () => {
    if (view === "library") openSettings();
  });
  await listen<{ captureId: string; percent: number }>(
    "transcription-progress",
    (event) => {
      if (event.payload.captureId === currentCapture()?.id) {
        transcriptionProgress = event.payload.percent;
        const fill = document.querySelector<HTMLElement>("#transcription-fill");
        if (fill) {
          fill.classList.remove("indeterminate");
          fill.style.width = `${transcriptionProgress}%`;
        }
        const label = document.querySelector("#transcription-label");
        if (label)
          label.textContent = `Transcribing on your computer… ${transcriptionProgress}%`;
        const pillLabel = document.querySelector("#pill-progress");
        if (pillLabel)
          pillLabel.textContent = `Transcribing ${transcriptionProgress}%`;
      }
    },
  );
  await listen<{ downloaded: number; total: number }>(
    "model-progress",
    (event) => {
      modelProgress = event.payload.downloaded / event.payload.total;
      updateModelProgress();
    },
  );
  await refresh();
  await document.fonts.ready;
  await document.querySelector<HTMLImageElement>(".screenshot img")?.decode().catch(() => {});
  document.body.classList.add("app-entering");
  await call("window_ready", {});
  await afterPaint();
  document.body.classList.remove("app-entering");
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && refreshAgain) { refreshAgain = false; void safely(refresh); }
  });
  getCurrentWindow()
    .onCloseRequested(async (event) => {
      if (edits.size) {
        event.preventDefault();
        await safely(async () => {
          await flushEdits();
          await getCurrentWindow().close();
        });
      }
    })
    .catch((error) => toast(error, true));
}
void boot().catch((error) => {
  root.innerHTML = `<div class="desktop-only"><h1>Glassnote could not open</h1><p>${esc(String(error))}</p>${view === "recorder" ? '<button id="recover-close">Close and recover from the library</button>' : ""}</div>`;
  void call(view === "recorder" ? "overlay_ready" : "window_ready", {}).catch(() => {});
  if (view === "recorder") {
    document.querySelector<HTMLButtonElement>("#recover-close")!.onclick = () => { void call("shelve_capture", {}).catch(error => toast(error, true)); };
    void call("overlay_ready", {}).catch(error => toast(error, true));
  }
});
