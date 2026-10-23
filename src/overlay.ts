import "./overlay.css";
import template from "./overlay.html?raw";
import { listen } from "@tauri-apps/api/event";
import { call, media, type Annotation, type Capture, type Snapshot, type OverlayInfo } from "./api";
import { projectRows, projectTreeHtml, expandProjectBranch, escapeHtml } from "./projects";
import { annotationElements, loadImage, persistAnnotations } from "./annotations";
import { afterPaint, leaveOverlay, prepareGlass } from "./presentation";

export async function bootOverlay(root: HTMLElement) {
  document.body.classList.add("overlay-preparing");
  root.innerHTML = template;
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const input = (id: string) => $<HTMLTextAreaElement>(id);
  const svg = document.querySelector<SVGSVGElement>("#annotations")!;
  const icon = (name: string) => `<svg class="icon" aria-hidden="true"><use href="#${name}"/></svg>`;
  const clamp = (n: number, min: number, max: number) => Math.min(Math.max(n, min), Math.max(min, max));
  const time = (n: number) => `${Math.floor(n / 60)}:${String(Math.floor(n) % 60).padStart(2, "0")}`;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  let [snapshot, context]: [Snapshot, OverlayInfo] = await Promise.all([call("snapshot", {}), call("overlay_info", {})]);
  let capture = snapshot.captures.find(c => c.id === snapshot.activeCaptureId);
  if (!capture) throw new Error("This capture could not be found. Open the library to recover it.");
  const id = capture.id;
  let current: Capture = capture;
  const [x, y, width, height] = context.region;
  let annotations = structuredClone(current.annotations);
  let transcript = current.transcript, baseText = transcript, priorSeconds = current.audioSeconds;
  let nextId = Math.max(0, ...annotations.map(a => a.id)) + 1;
  let projectId = current.projectId, tool: Annotation["type"] | null = null, color = "#3b73e0";
  let projectOptionsKey = "";
  let dictationTarget: number | null = current.recordingTarget ?? null;
  let selected: number | null = null, stroke: Annotation | null = null;
  let captionOpen = false, working = false, saved = false;
  let opaque = false;
  try { opaque = localStorage.getItem("glassnote.opaqueCapture") === "true"; } catch { /* Storage may be unavailable; the material still works. */ }
  let transcriptDirty = false, annotationDirty = false, revision = 0, textRevision = 0;
  let pendingIntent: "save" | "close" | "discard" | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  let saveChain: Promise<void> = Promise.resolve();
  let refreshChain: Promise<void> = Promise.resolve();
  const docking = { recorder: "top", tools: "right", footer: "right" };
  const busy = () => current.status === "recording" || current.status === "transcribing";
  const place = (element: HTMLElement, property: "left" | "top", value: number) => {
    const pixels = `${value}px`;
    if (element.style[property] !== pixels) element.style[property] = pixels;
  };

  function error(message: unknown) {
    $("errorText").textContent = String(message); $("overlayError").hidden = false;
    placeTools();
  }
  const safely = (fn: () => Promise<unknown>) => { void fn().catch(error); };
  function notify(message: string) {
    clearTimeout(statusTimer); $("status").textContent = message; $("status").hidden = false;
    statusTimer = setTimeout(() => $("status").hidden = true, 2800);
  }
  const textMeasure = document.createElement("div");
  textMeasure.className = "caption-measure"; textMeasure.setAttribute("aria-hidden", "true");
  document.body.append(textMeasure);
  let measuredText = "", measuredWidth = 0;
  function grow(element: HTMLTextAreaElement, min: number, max: number) {
    const width = element.clientWidth;
    if (!width || (measuredText === element.value && measuredWidth === width)) return;
    measuredText = element.value; measuredWidth = width;
    textMeasure.style.width = `${width}px`;
    textMeasure.textContent = (element.value || element.placeholder) + "\u200b";
    const height = `${clamp(textMeasure.offsetHeight, min, max)}px`;
    if (element.style.height !== height) element.style.height = height;
  }
  function morph(change: () => void) {
    const element = $("recorder"), before = element.getBoundingClientRect();
    element.getAnimations().forEach(a => a.cancel()); change();
    const after = element.getBoundingClientRect();
    if (!reducedMotion.matches && (before.width !== after.width || before.height !== after.height))
      element.animate([{ width: `${before.width}px`, height: `${before.height}px` }, { width: `${after.width}px`, height: `${after.height}px` }], { duration: 260, easing: "cubic-bezier(.22,1,.36,1)" });
    placeTools();
  }
  function closeProject() {
    if ($("projectMenu").hidden) return;
    if ($("projectMenu").contains(document.activeElement)) $("projectToggle").focus({ preventScroll: true });
    $("projectMenu").hidden = true; $("projectToggle").setAttribute("aria-expanded", "false");
    $<HTMLFormElement>("newProjectForm").reset(); $("newProjectForm").hidden = true;
    $("newProject").hidden = false; $("newSubproject").hidden = !!snapshot.projects.find(p => p.id === projectId)?.parentId; $("projectError").hidden = true;
  }
  function closeActions() {
    if ($("captureMenu").hidden) return;
    if ($("captureMenu").contains(document.activeElement)) $("moreToggle").focus({ preventScroll: true });
    $("captureMenu").hidden = true; $("moreToggle").setAttribute("aria-expanded", "false");
    $("discardConfirm").hidden = true; $("discardCapture").hidden = false;
  }
  function setCaption(open: boolean) {
    if (captionOpen === open) return;
    captionOpen = open;
    if (!open && $("caption").contains(document.activeElement)) $("toggleCaption").focus({ preventScroll: true });
    morph(() => {
      $("caption").classList.toggle("empty", !open); $("caption").inert = !open;
      $("caption").setAttribute("aria-hidden", String(!open)); $("toggleCaption").setAttribute("aria-expanded", String(open));
      grow(input("captionText"), 39, 220);
    });
  }
  function syncText() {
    if (input("captionText").value !== transcript) input("captionText").value = transcript;
    grow(input("captionText"), 39, 220);
  }
  function queueSave(kind: "text" | "annotation") {
    if (kind === "text") { transcriptDirty = true; textRevision++; }
    else { annotationDirty = true; revision++; }
    $("editStatus").textContent = "Saving…"; clearTimeout(saveTimer);
    saveTimer = setTimeout(() => safely(flush), 700);
  }
  function flush(): Promise<void> {
    clearTimeout(saveTimer);
    const task = saveChain.catch(() => {}).then(async () => {
      if (transcriptDirty && !busy()) {
        const version = textRevision, text = transcript;
        await call("save_transcript", { id, text });
        if (version === textRevision) transcriptDirty = false;
      }
      if (annotationDirty && !busy()) {
        const version = revision, items = structuredClone(annotations);
        await persistAnnotations(current, items);
        if (version === revision) annotationDirty = false;
      }
      $("editStatus").textContent = transcriptDirty || annotationDirty ? "Saving…" : "Saved";
    });
    saveChain = task;
    return task.catch(cause => { $("editStatus").textContent = "Not saved · press Ctrl+S to retry"; throw cause; });
  }
  function renderProjects() {
    if (!snapshot.projects.some(p => p.id === projectId)) projectId = snapshot.settings.activeProjectId;
    const rows = projectRows(snapshot.projects);
    const project = rows.find(row => row.project.id === projectId);
    $("projectName").textContent = project?.path || "Inbox";
    $("saveButton").title = `Save to ${project?.path || "Inbox"}`;
    $("newSubproject").hidden = !$("newProjectForm").hidden || !!project?.project.parentId;
    const key = JSON.stringify(snapshot.projects);
    if (key !== projectOptionsKey) {
    projectOptionsKey = key;
    $("projectOptions").innerHTML = projectTreeHtml(snapshot.projects, ({project: p, depth, path}) =>
      `<button type="button" class="${depth ? "subfolder" : ""}" data-overlay-project="${p.id}" style="--depth:${depth}" title="${escapeHtml(path)}">${icon("folder")}<span>${escapeHtml(p.name)}</span>${icon("check")}</button>`, "overlay-children");
    }
    $("projectOptions").querySelectorAll<HTMLButtonElement>("[data-overlay-project]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.overlayProject === projectId)));
  }
  function updateState() {
    document.body.classList.toggle("opaque", opaque);
    $("glassToggle").setAttribute("aria-pressed", String(!opaque));
    document.body.classList.toggle("recording", current.status === "recording");
    input("captionText").readOnly = busy();
    input("pinEditorInput").readOnly = busy();
    const pinRecording = busy() && dictationTarget !== null;
    const here = dictationTarget === selected;
    $("pinVoiceStatus").hidden = !pinRecording || !here;
    $("pinVoiceLabel").textContent = current.status === "recording" ? "Listening…" : "Finishing note…";
    $("recordPinNote").setAttribute("aria-pressed", String(current.status === "recording" && here));
    const pinLabel = current.status === "recording" && here ? "Stop" : current.status === "transcribing" && here ? "Finishing…" : "Dictate";
    if ($("recordPinNote").querySelector("span")?.textContent !== pinLabel)
      $("recordPinNote").innerHTML = icon(current.status === "recording" && here ? "stop" : "mic") + `<span>${pinLabel}</span>`;
    $<HTMLButtonElement>("recordPinNote").disabled = working || saved || current.status === "transcribing" || (busy() && !here);
    $<HTMLButtonElement>("savePinNote").disabled = busy();
    $<HTMLButtonElement>("undoButton").disabled = busy() || !annotations.length;
    root.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach(button => button.disabled = busy());
    const label = current.status === "recording" ? "Stop" : current.status === "transcribing" ? "Transcribing…" : current.audioPath ? "Continue" : "Record";
    if ($("recordButton").querySelector("span")?.textContent !== label) {
      morph(() => {
        $("recordButton").innerHTML = icon(current.status === "recording" ? "stop" : "mic") + `<span class="record-label">${label}</span>`;
        $("recordButton").setAttribute("aria-label", label === "Continue" ? "Continue recording" : label);
      });
    }
    $<HTMLButtonElement>("recordButton").disabled = working || current.status === "transcribing" || saved;
    $<HTMLButtonElement>("saveButton").disabled = working || saved || current.status === "transcribing";
    $("saveButton").querySelector("svg")?.setAttribute("aria-hidden", "true");
    $("elapsed").textContent = time(current.audioSeconds);
    $("downloadModel").hidden = snapshot.modelReady || snapshot.modelDownloading;
    $("cancelDownload").hidden = !snapshot.modelDownloading;
    $("retryTranscription").hidden = current.status !== "failed" || !current.audioPath;
    if (current.error) $("errorText").textContent = current.error;
    else if (!snapshot.modelReady) $("errorText").textContent = snapshot.modelDownloading ? "Downloading the local voice model…" : "Download the lightweight English voice model to record. Screenshots and typed notes are ready now.";
    else if (current.status === "transcribing") $("errorText").textContent = "Finishing the transcript on this laptop…";
    else $("errorText").textContent = "";
    $("overlayError").hidden = !$("errorText").textContent;
  }
  async function refresh() {
    snapshot = await call("snapshot", {});
    capture = snapshot.captures.find(c => c.id === id);
    if (!capture || saved) return;
    const wasBusy = busy(); current = capture;
    dictationTarget = current.recordingTarget ?? null;
    if (!annotationDirty && !busy()) {
      annotations = structuredClone(current.annotations); renderAnnotations();
      const item = annotations.find(a => a.id === selected);
      if (item && input("pinEditorInput").value !== item.text) input("pinEditorInput").value = item.text;
    }
    if (!transcriptDirty && !busy()) { transcript = current.transcript; syncText(); }
    if (wasBusy && !busy()) priorSeconds = current.audioSeconds;
    updateState(); renderProjects();
    if (pendingIntent && current.status !== "recording" && current.status !== "transcribing") {
      const intent = pendingIntent; pendingIntent = null;
      if (current.status === "failed" && intent === "save") { error(`${current.error || "Transcription failed."} Your recording is kept. Retry, edit the text, or click Save to keep it as it is.`); return; }
      await finish(intent);
    }
  }
  const requestRefresh = () => { refreshChain = refreshChain.catch(() => {}).then(refresh); void refreshChain.catch(error); };
  async function finish(intent: "save" | "close" | "discard") {
    if (working || saved) return;
    if (busy()) {
      pendingIntent = intent;
      if (current.status === "recording") { if (intent === "save") await flush(); await call("stop_recording", { id }); current.status = "transcribing"; updateState(); notify(intent === "save" ? "Finishing your voice note…" : "Stopping before discarding…"); }
      return;
    }
    working = true; updateState();
    try {
      const discard = intent !== "save";
      if (discard) { clearTimeout(saveTimer); await saveChain.catch(() => {}); await leaveOverlay(); }
      else {
        await flush();
        if (!transcript.trim() && !annotations.some(a => a.type !== "pin" || a.text.trim()) && !current.audioPath) await leaveOverlay();
      }
      const kept = await call("finish_capture", { id, projectId, text: transcript, discard });
      if (!kept) { saved = true; return; }
      saved = true;
      const name = snapshot.projects.find(p => p.id === projectId)?.name || "Inbox";
      morph(() => { $("recorderControls").hidden = true; $("savedConfirmation").hidden = false; $("savedText").textContent = `Saved to ${name}`; });
      closeProject(); closeActions(); $("pinEditor").hidden = true; document.body.classList.add("capture-saved");
      setTimeout(() => safely(async () => {
        try { await leaveOverlay(); await call("shelve_capture", {}); }
        catch (cause) {
          saved = false;
          document.body.classList.remove("overlay-leaving", "capture-saved");
          morph(() => { $("recorderControls").hidden = false; $("savedConfirmation").hidden = true; });
          updateState(); throw cause;
        }
      }), 650);
    } catch (cause) {
      document.body.classList.remove("overlay-leaving");
      throw cause;
    } finally { working = false; if (!saved) updateState(); }
  }
  async function record(target: number | null = null) {
    if (working || saved) return;
    if (current.status === "recording") { await call("stop_recording", { id }); current.status = "transcribing"; updateState(); return; }
    if (current.status === "transcribing") return;
    if (!snapshot.modelReady) { error("Download the local English voice model first. Add a typed note or drawing to save without voice."); return; }
    working = true; updateState();
    try {
      await flush();
      baseText = target === null ? transcript : annotations.find(a => a.id === target)?.text || "";
      priorSeconds = current.audioSeconds;
      await call("start_recording", { id, annotationId: target });
      dictationTarget = target;
      if (target === null) setCaption(true);
      await refresh();
    } finally { working = false; updateState(); }
  }
  $("recordButton").onclick = () => safely(() => record());
  $("recordPinNote").onclick = () => { if (selected !== null) safely(() => record(selected)); };
  $("saveButton").onclick = () => safely(() => finish("save"));
  $("dismissButton").onclick = () => safely(() => finish("close"));
  $("toggleCaption").onclick = () => setCaption(!captionOpen); $("hideCaption").onclick = () => setCaption(false);
  for (const field of [input("captionText")]) {
    field.maxLength = 64000;
    field.oninput = () => { if (!busy()) { transcript = field.value; syncText(); queueSave("text"); } };
  }
  $("retryTranscription").onclick = () => safely(async () => { await flush(); await call("retry_transcription", { id }); await refresh(); });
  $("downloadModel").onclick = () => safely(async () => { await call("download_model", {}); await refresh(); });
  $("cancelDownload").onclick = () => safely(() => call("cancel_model_download", {}));
  $("discardCapture").onclick = () => { $("discardConfirm").hidden = false; $("discardCapture").hidden = true; };
  $("cancelDiscard").onclick = () => { $("discardConfirm").hidden = true; $("discardCapture").hidden = false; };
  $("confirmDiscard").onclick = () => safely(() => finish("discard"));
  $("openLibrary").onclick = () => safely(async () => { await flush(); await call("open_library", {}); });
  $("moreToggle").onclick = () => {
    const open = $("captureMenu").hidden; closeProject(); closeActions();
    $("captureMenu").hidden = !open; $("moreToggle").setAttribute("aria-expanded", String(open)); placeTools();
  };
  $("glassToggle").onclick = () => {
    opaque = !opaque;
    try { localStorage.setItem("glassnote.opaqueCapture", String(opaque)); } catch { /* Keep the preference for this capture. */ }
    updateState(); document.dispatchEvent(new Event("glass-material-change"));
  };
  $("projectToggle").onclick = () => {
    if (!$("projectMenu").hidden) return closeProject();
    closeActions();
    $("projectMenu").hidden = false; $("projectToggle").setAttribute("aria-expanded", "true");
    placeTools(); $("projectOptions").querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.focus({ preventScroll: true });
  };
  $("projectOptions").onclick = event => {
    const button = (event.target as Element).closest<HTMLElement>("[data-overlay-project]");
    if (button?.dataset.overlayProject) { projectId = button.dataset.overlayProject; renderProjects(); closeProject(); }
  };
  function openProjectForm() {
    $("newProject").hidden = true; $("newSubproject").hidden = true; $("newProjectForm").hidden = false;
    placeTools(); $("newProjectName").focus();
  }
  $("newProject").onclick = openProjectForm;
  $("newSubproject").onclick = () => safely(async () => {
    const button = $<HTMLButtonElement>("newSubproject"); button.disabled = true;
    try {
      const project = await call("create_project", { name: "", parentId: projectId });
      expandProjectBranch(projectId);
      projectId = project.id; await refresh(); closeProject();
    } finally { button.disabled = false; }
  });
  $("cancelProject").onclick = closeProject;
  $("newProjectForm").onsubmit = event => {
    event.preventDefault();
    const submit = $("newProjectForm").querySelector<HTMLButtonElement>('button[type="submit"]')!; submit.disabled = true;
    void call("create_project", { name: $<HTMLInputElement>("newProjectName").value, parentId: null }).then(async project => {
      projectId = project.id; await refresh(); closeProject();
    }).catch(cause => { $("projectError").textContent = String(cause); $("projectError").hidden = false; $("newProjectName").focus(); }).finally(() => submit.disabled = false);
  };
  $("newProjectForm").onkeydown = event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeProject(); } };

  function noteNumber(id: number) { return annotations.filter(a => a.type === "pin").findIndex(a => a.id === id) + 1; }
  function renderAnnotations() {
    const rect = svg.getBoundingClientRect();
    svg.replaceChildren(...annotationElements(stroke ? [...annotations, stroke] : annotations, rect.width, rect.height, selected));
    $<HTMLButtonElement>("undoButton").disabled = busy() || !annotations.length;
  }
  function positionPin() {
    if ($("pinEditor").hidden) return;
    const item = annotations.find(a => a.id === selected); if (!item) return closePin();
    const rect = svg.getBoundingClientRect(), px = rect.left + item.x / 1000 * rect.width, py = rect.top + item.y / 680 * rect.height;
    const w = $("pinEditor").offsetWidth, h = $("pinEditor").offsetHeight;
    place($("pinEditor"), "left", clamp(px + w + 35 > innerWidth ? px - w - 21 : px + 21, 12, innerWidth - w - 12));
    place($("pinEditor"), "top", clamp(py - 19, 12, innerHeight - h - 12));
  }
  function openPin(value: number) {
    const item = annotations.find(a => a.id === value); if (!item) return;
    selected = value; input("pinEditorInput").value = item.text;
    $("inlineNoteNumber").textContent = String(noteNumber(value)); $("inlineNoteTitle").textContent = `Note ${noteNumber(value)}`;
    $("pinEditor").hidden = false; updateState(); renderAnnotations(); positionPin(); input("pinEditorInput").focus({ preventScroll: true });
  }
  function closePin(focus = false) {
    const previous = selected; $("pinEditor").hidden = true; selected = null; renderAnnotations();
    if (focus && previous) svg.querySelector<SVGElement>(`[data-pin="${previous}"]`)?.focus({ preventScroll: true });
  }
  input("pinEditorInput").oninput = () => {
    if (busy()) return;
    const item = annotations.find(a => a.id === selected); if (!item) return;
    item.text = input("pinEditorInput").value;
    queueSave("annotation");
  };
  $("pinEditor").onsubmit = event => { event.preventDefault(); if (busy()) return; closePin(true); safely(flush); };
  $("closePinEditor").onclick = () => closePin(true);
  input("pinEditorInput").onkeydown = event => {
    if (event.key === "Escape" || ((event.ctrlKey || event.metaKey) && event.key === "Enter")) { event.preventDefault(); event.stopPropagation(); closePin(true); safely(flush); }
  };
  function selectTool(value: Annotation["type"] | null) {
    tool = value; svg.classList.toggle("select-mode", !tool);
    root.querySelectorAll<HTMLElement>("[data-tool]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.tool === tool)));
  }
  root.querySelectorAll<HTMLElement>("[data-tool]").forEach(button => button.onclick = () => selectTool(tool === button.dataset.tool ? null : button.dataset.tool as Annotation["type"]));
  $("colorToggle").onclick = () => { $("colorMenu").hidden = !$("colorMenu").hidden; $("colorToggle").setAttribute("aria-expanded", String(!$("colorMenu").hidden)); };
  root.querySelectorAll<HTMLElement>("[data-color]").forEach(button => button.onclick = () => {
    color = button.dataset.color!; $("colorDot").style.background = color; $("colorMenu").hidden = true;
    $("colorToggle").setAttribute("aria-expanded", "false");
    root.querySelectorAll<HTMLElement>("[data-color]").forEach(b => b.setAttribute("aria-pressed", String(b === button)));
  });
  function undo() { if (busy() || !annotations.length) return; annotations.pop(); closePin(); queueSave("annotation"); }
  $("undoButton").onclick = undo;
  const point = (event: PointerEvent): [number, number] => {
    const rect = svg.getBoundingClientRect(); return [clamp((event.clientX - rect.left) / rect.width * 1000, 0, 1000), clamp((event.clientY - rect.top) / rect.height * 680, 0, 680)];
  };
  svg.onpointerdown = event => {
    if (saved || event.button !== 0) return;
    const pin = (event.target as Element).closest<SVGElement>("[data-pin]");
    if (pin) { event.preventDefault(); openPin(Number(pin.dataset.pin)); return; }
    if (!tool) { closePin(); return; }
    if (busy()) return;
    event.preventDefault();
    if (annotations.length >= 500) return notify("This screenshot has reached 500 annotations.");
    const [px, py] = point(event);
    const item: Annotation = { id: nextId++, type: tool, color, x: px, y: py, x2: px, y2: py, points: [], text: "" };
    closePin();
    if (tool === "pin") { annotations.push(item); renderAnnotations(); queueSave("annotation"); openPin(item.id); selectTool(null); return; }
    if (tool === "pen") item.points.push([px, py]);
    stroke = item; svg.setPointerCapture(event.pointerId); renderAnnotations();
  };
  let drawingFrame = 0;
  svg.onpointermove = event => {
    if (!stroke) return; const [px, py] = point(event); stroke.x2 = px; stroke.y2 = py;
    if (stroke.type === "pen" && annotations.reduce((sum, a) => sum + a.points.length, 0) + stroke.points.length < 25000) {
      const last = stroke.points.at(-1)!; if (Math.hypot(px - last[0], py - last[1]) > 1) stroke.points.push([px, py]);
    }
    if (!drawingFrame) drawingFrame = requestAnimationFrame(() => { drawingFrame = 0; renderAnnotations(); });
  };
  svg.onpointerup = event => {
    if (!stroke) return;
    if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
    if (stroke.type === "pen" ? stroke.points.length > 1 : Math.hypot(stroke.x2 - stroke.x, stroke.y2 - stroke.y) > 2) { annotations.push(stroke); queueSave("annotation"); }
    stroke = null; renderAnnotations();
  };
  svg.onpointercancel = () => { stroke = null; renderAnnotations(); };
  svg.onkeydown = event => { const pin = (event.target as Element).closest<SVGElement>("[data-pin]"); if (pin && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); openPin(Number(pin.dataset.pin)); } };

  function chooseDocking() {
    const rect = $("capture").getBoundingClientRect();
    const side = rect.left > innerWidth - rect.right ? "left" : "right";
    docking.tools = docking.footer = side;
    const pill = $("recorder").getBoundingClientRect();
    const overlap = (top: number) => Math.max(0, Math.min(rect.right, (innerWidth + pill.width) / 2) - Math.max(rect.left, (innerWidth - pill.width) / 2)) * Math.max(0, Math.min(rect.bottom, top + pill.height) - Math.max(rect.top, top));
    docking.recorder = overlap(24) > overlap(innerHeight - pill.height - 24) ? "bottom" : "top";
  }
  function placeTools() {
    const rect = $("capture").getBoundingClientRect();
    const recorderHeight = $("recorder").offsetHeight;
    const top = docking.recorder === "top", safeTop = top ? recorderHeight + 48 : 88, safeBottom = top ? 88 : recorderHeight + 48;
    document.body.dataset.toolsSide = docking.tools; document.body.dataset.recorderSide = docking.recorder;
    place(root.querySelector<HTMLElement>(".recorder-anchor")!, "top", top ? 24 : innerHeight - recorderHeight - 24);
    const tools = root.querySelector<HTMLElement>(".tool-column")!;
    let left = docking.tools === "right" ? (innerWidth - rect.right >= 76 ? rect.right + 16 : rect.right - 60) : (rect.left >= 76 ? rect.left - 64 : rect.left + 12);
    place(tools, "left", clamp(left, 16, innerWidth - 64));
    place(tools, "top", clamp(rect.top, safeTop, innerHeight - tools.offsetHeight - safeBottom));
    const footer = root.querySelector<HTMLElement>(".preview-footer")!;
    place(footer, "left", docking.footer === "left" ? 24 : Math.max(24, innerWidth - footer.offsetWidth - 24));
    place(footer, "top", top ? innerHeight - footer.offsetHeight - 24 : 24);
    for (const [button, label] of [["moveRecorder", `Move recorder to ${top ? "bottom" : "top"}`], ["moveTools", `Move drawing tools to ${docking.tools === "right" ? "left" : "right"}`], ["moveFooter", `Move capture bar to ${docking.footer === "right" ? "left" : "right"}`]]) {
      $(button).setAttribute("aria-label", label); $(button).title = label;
    }
    document.body.dataset.footerSide = docking.footer;
    document.body.dataset.footerEdge = top ? "bottom" : "top";
    positionPin();
  }
  for (const [button, key] of [["moveRecorder", "recorder"], ["moveTools", "tools"], ["moveFooter", "footer"]] as const) $(button).onclick = () => {
    docking[key] = key === "recorder" ? (docking[key] === "top" ? "bottom" : "top") : (docking[key] === "right" ? "left" : "right");
    closeProject(); closeActions(); $("colorMenu").hidden = true; placeTools();
  };
  function layout() {
    Object.assign($("capture").style, { left: `${x * 100}%`, top: `${y * 100}%`, width: `${width * 100}%`, height: `${height * 100}%` });
    renderAnnotations(); placeTools();
  }
  const sizes = [5, 9, 15, 10, 20, 13, 24, 18, 11, 21, 16, 10, 15, 7, 11, 5];
  for (const [index, value] of sizes.entries()) { const bar = document.createElement("i"); bar.style.setProperty("--level", String(value)); bar.style.setProperty("--i", String(index)); $("meter").append(bar); }

  document.addEventListener("keydown", event => {
    if (saved) return;
    if (!$("projectMenu").hidden && $("newProjectForm").hidden && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      const buttons = [...$("projectMenu").querySelectorAll<HTMLButtonElement>("button:not(:disabled)")].filter(button => !button.closest("[inert]") && button.checkVisibility());
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
      buttons[next]?.focus(); event.preventDefault(); return;
    }
    const editing = (event.target as Element).matches("textarea,input");
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); safely(flush); }
    else if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && $("projectMenu").hidden) { event.preventDefault(); safely(() => finish("save")); }
    else if (event.key === "Escape") { event.preventDefault(); if (!$("pinEditor").hidden) closePin(); else if (!$("projectMenu").hidden) closeProject(); else if (!$("captureMenu").hidden) closeActions(); else safely(() => finish("close")); }
    else if (!editing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); undo(); }
  });
  await listen("library-changed", requestRefresh);
  await listen("transcription-complete", requestRefresh);
  await listen("recorder-close-requested", () => safely(() => finish("close")));
  await listen<string>("app-error", event => error(event.payload));
  await listen<{ captureId: string; annotationId?: number | null; text: string }>("transcript-partial", event => {
    if (event.payload.captureId !== id || !busy()) return;
    if ((event.payload.annotationId ?? null) !== dictationTarget) return;
    const text = [baseText.trim(), event.payload.text.trim()].filter(Boolean).join("\n\n");
    if (dictationTarget !== null) {
      const item = annotations.find(a => a.id === dictationTarget);
      if (item) item.text = text;
      if (selected === dictationTarget) input("pinEditorInput").value = text;
    } else { transcript = text; syncText(); }
    placeTools();
  });
  await listen<{ captureId: string; level: number; elapsed: number }>("audio-level", event => {
    if (event.payload.captureId !== id) return;
    $("elapsed").textContent = time(priorSeconds + event.payload.elapsed);
    $("pinVoiceTime").textContent = time(event.payload.elapsed);
    $("pinVoiceStatus").style.setProperty("--voice-level", String(0.7 + clamp(event.payload.level * 3, 0, 1) * 0.8));
    $("meter").querySelectorAll("i").forEach((bar, index) => bar.style.setProperty("--level", String(3 + clamp(event.payload.level * 3, 0, 1) * sizes[index])));
  });
  await listen<{ captureId: string; percent: number }>("transcription-progress", event => {
    if (event.payload.captureId === id && current.status === "transcribing") $("recordButton").querySelector("span")!.textContent = `${event.payload.percent}%`;
  });
  await listen<{ downloaded: number; total: number }>("model-progress", event => {
    $("errorText").textContent = `Downloading voice model… ${Math.floor(event.payload.downloaded / event.payload.total * 100)}%`;
  });
  document.addEventListener("pointerdown", event => { if (!(event.target as Element).closest(".preview-footer")) { closeProject(); closeActions(); } });
  window.addEventListener("resize", layout);
  const observer = new ResizeObserver(() => { grow(input("captionText"), 39, 220); placeTools(); }); observer.observe($("recorder")); observer.observe(root.querySelector(".preview-footer")!);
  syncText(); renderProjects(); updateState(); layout(); chooseDocking(); placeTools();
  $<HTMLImageElement>("captureImage").src = media(current.originalPath);
  if (context.backgroundPath) $("frozenDesktop").setAttribute("src", media(context.backgroundPath));
  else {
    const canvas = document.createElement("canvas"); canvas.width = context.width; canvas.height = context.height;
    const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("Could not restore the screenshot preview.");
    ctx.fillStyle = "#18212b"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(await loadImage(media(current.originalPath)), x * canvas.width, y * canvas.height, width * canvas.width, height * canvas.height);
    $("frozenDesktop").setAttribute("src", canvas.toDataURL("image/png"));
  }
  await Promise.all([$<HTMLImageElement>("captureImage").decode(), $<HTMLImageElement>("frozenDesktop").decode(), document.fonts.ready]);
  await prepareGlass();
  document.body.classList.add("overlay-entering");
  await call("overlay_ready", {});
  await afterPaint();
  await call("overlay_presented", { id });
  document.body.classList.remove("overlay-preparing");
  document.body.classList.remove("overlay-entering");
}
