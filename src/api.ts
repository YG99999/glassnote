import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
export interface Project {
  id: string;
  name: string;
  createdAt: string;
  parentId?: string | null;
}
export interface Capture {
  id: string;
  projectId: string;
  createdAt: string;
  width: number;
  height: number;
  draft: boolean;
  status: "ready" | "recording" | "transcribing" | "failed";
  error: string | null;
  transcript: string;
  screenshotPath: string;
  audioPath: string | null;
  originalPath: string;
  audioSeconds: number;
  annotations: Annotation[];
  recordingTarget?: number | null;
}
export interface Annotation {
  id: number; type: "pen" | "arrow" | "rectangle" | "ellipse" | "pin";
  color: string; x: number; y: number; x2: number; y2: number;
  points: [number, number][]; text: string;
}
export interface OverlayInfo {
  backgroundPath: string | null; width: number; height: number; region: [number, number, number, number];
}
export interface Snapshot {
  projects: Project[];
  captures: Capture[];
  settings: { activeProjectId: string; shortcut: string };
  modelReady: boolean;
  modelDownloading: boolean;
  transparency: boolean;
  activeCaptureId: string | null;
  warnings: string[];
  shortcutError: string | null;
}
interface Commands {
  snapshot: [{}, Snapshot];
  capture_screen: [{}, void];
  overlay_info: [{}, OverlayInfo];
  overlay_ready: [{}, void];
  overlay_presented: [{ id: string }, void];
  window_ready: [{}, void];
  selector_info: [
    {},
    { screenshotPath: string; width: number; height: number },
  ];
  cancel_capture: [{}, void];
  select_region: [
    {
      selection: {
        x1: number;
        y1: number;
        x2: number;
        y2: number;
        viewportWidth: number;
        viewportHeight: number;
      };
    },
    void,
  ];
  create_project: [{ name: string; parentId?: string | null }, Project];
  rename_project: [{ id: string; name: string }, void];
  delete_project: [{ id: string }, void];
  choose_project: [{ id: string }, void];
  save_transcript: [{ id: string; text: string }, void];
  save_annotations: [{ id: string; items: Annotation[]; image: string }, void];
  move_capture: [{ id: string; projectId: string }, void];
  delete_capture: [{ id: string }, void];
  resume_capture: [{ id: string }, void];
  finish_capture: [
    { id: string; projectId: string; text: string; discard: boolean },
    void,
  ];
  shelve_capture: [{}, void];
  open_library: [{}, void];
  start_recording: [{ id: string; annotationId?: number | null }, void];
  stop_recording: [{ id: string }, void];
  retry_transcription: [{ id: string }, void];
  download_model: [{}, void];
  cancel_model_download: [{}, void];
  set_shortcut: [{ value: string }, void];
  copy_project_path: [{ projectId: string }, string];
  export_project_zip: [{ projectId: string }, string | null];
  export_project: [{ projectId: string }, string | null];
}
export function call<K extends keyof Commands>(
  command: K,
  args: Commands[K][0],
): Promise<Commands[K][1]> {
  return invoke(command, args);
}
export const native = isTauri();
export const media = (path: string) => convertFileSrc(path);
