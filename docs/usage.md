# Using Glassnote

1. Run the Windows installer in `src-tauri/target/release/bundle/nsis/`.
2. Open **Glassnote** from the Start menu. In **Settings**, download the 32 MB English speech model once.
3. Click **Glassnote Capture** on the desktop, press **Ctrl+Alt+S**, or choose **Capture** from the tray menu.
4. **Click for the whole screen, or drag across a region.** Press **Esc** to cancel. A selection stays within one monitor.
5. The screen stays frozen with the selected area highlighted. A compact recorder appears at the top or bottom, choosing the clearer edge. Click **Record**, speak, then **Stop** to review. Live text appears while you talk and is refined after Stop. **Continue** adds another take to the existing audio and text. Click **Save** to confirm the destination briefly and return to your desktop. The library stays closed.

The small project pill on the opposite edge is the destination control. Click its project name to switch projects or create a **New project**. The last-used project is selected automatically. The text button shows or hides the editable transcript beneath the recorder. The **More** menu contains Open library, Discard, and the Liquid glass switch. Add text, a recording, or a drawing before saving; a bare screenshot (including an empty numbered note) is discarded. **Ctrl+Enter** finishes and saves; **×** or **Esc** stops recording, waits for processing, and permanently discards the capture, including autosaved edits. If transcription fails, its inline message offers Retry; Save keeps the audio and existing text.

Use the floating drawing tools for pen strokes, arrows, rectangles, circles, colors, and undo. **Numbered note** places a point on the screenshot and opens a small text editor beside it. Save note tucks the editor away; click the point to reopen it. Only the number appears on the saved screenshot; the note text stays linked separately. Transcript and annotation edits autosave; **Ctrl+S** retries a failed save. **Ctrl+Z** undoes a drawing when you are outside a text field.

Controls choose a clearer side of the screenshot automatically. Each small double-arrow button switches its recorder, drawing dock, or project pill to the opposite edge. The recorder stays horizontally centered. Moving controls never shifts the screenshot. The capture overlay has no sidebar.

Screenshot windows stay hidden until their images and glass are prepared. The selection stays frozen until the recorder has painted, then its controls appear. Save and Close fade the overlay back to the desktop. Reduced motion skips those animations. Opening a capture loads its own text rather than rereading the whole library; clean startup leaves unchanged metadata alone.

The main app shows projects with indented subfolders, a screenshot list, and the selected screenshot with its editable transcript and numbered notes. Projects allow **one level of subfolders**; subfolders cannot contain other folders. Use the chevron beside a project to collapse or expand its children in the sidebar and destination pickers. Collapsed projects are remembered. Transcript edits save automatically; **Ctrl+S** also saves them. An unfinished capture can be reopened with **Continue capture**.

The project **…** menu creates subfolders, renames or deletes projects, copies a folder path, and exports a ZIP. Deleting a project permanently removes its captures and all nested subfolders after a confirmation showing the counts. Inbox cannot be deleted. **Copy folder as path** prepares a fresh snapshot under local app data and copies its quoted Windows path; copy again after edits to share an updated snapshot. **Export as ZIP** saves a fresh archive in your chosen folder. Both actions include the selected folder and its descendants. Selecting a subfolder shares only that branch. Existing exports are never overwritten.

The capture pill's destination menu lets you switch between projects and subfolders, create a **New project**, or create a **New subfolder here**. Subfolders are created immediately and numbered **0, 1, 2, …** within their parent; there is no name field or rename action for them. Numbers reflect the current order: deleting a subfolder closes the gap, so the remaining folders are always **0, 1, 2, …**. Their contents, IDs, and selected destination stay linked when a number changes. Existing gaps and older named subfolders are normalized when the library opens. Nested destinations display their full path. Inside a numbered note, **Dictate** appends speech directly to that note, with live text and microphone activity. Stop finishes its text; the general transcript stays separate.

Closing the library leaves Glassnote in the system tray. Use the tray's **Exit** action to stop the app. It does not start automatically with Windows. The keyboard shortcut works while the app is running; the desktop capture shortcut can start it.

## Files and privacy

The interface has no audio playback controls. Recordings stay linked for transcription retry and export.

Data is stored in `%LOCALAPPDATA%\com.glassnote.desktop`:

```text
library.json
captures/<capture-id>/capture.json
captures/<capture-id>/screenshot.png
captures/<capture-id>/transcript.txt
captures/<capture-id>/audio.wav       # when recorded
captures/<capture-id>/annotated-<id>.png # flattened drawing and numbered markers
models/ggml-tiny.en-q5_1.bin
```

Transcription runs on the CPU through whisper.cpp using Whisper tiny.en q5_1. The model loads when recording starts, produces revisable interim text roughly every 1.5 seconds after the first two seconds of audio, and runs a final pass on Stop. Processing time depends on the laptop. The model is released after processing. The app makes no cloud transcription requests and has no telemetry. Internet access is used for the model download; the model's size and SHA-256 checksum are verified before use. Downloading it again does not remove your captures.

Recordings are flushed to disk during recording. After an interrupted session, Glassnote retains the unfinished capture and offers transcription retry. Full-screen snapshots remain frozen behind the pill until Save, Close, or Discard; temporary snapshots are then removed. Any leftovers are cleaned on startup.

Shared folders and ZIP exports start with `README.md`, a compact index linking to capture notes and nested folders. Each `001/capture.md` combines the general transcript and numbered notes once, with marker coordinates in screenshot pixels and a relative link to the actual `screenshot.png`. An agent should open that PNG with an image tool to inspect it. `objects.json` supplies compact drawing bounds when needed; full stroke points stay in `annotations.json`. Read only relevant captures instead of loading the whole project.

Exports also contain `project.json` (format version 2) plus chronologically numbered folders with `screenshot.png`, `transcript.txt`, and `audio.wav` when present. An annotated capture includes its untouched `original.png`, editable `annotations.json`, and numbered `notes.txt`. The exported screenshot includes drawings and numbered markers. The manifest preserves capture IDs and relative links. Files can be read without Glassnote.

The library follows the Windows theme; the capture overlay uses translucent graphite glass with silver edges. The selection hint, recorder, drawing dock, color picker, project/actions menus, note editor, and status messages share the MIT-licensed **egui-glass** shader adapted to WebGL2 inside the existing Tauri WebView2 interface. Glass samples the original frozen screen independently of the selection's dark veil, with a brightness bound that keeps text readable on light backgrounds and reflected ambient light that keeps the material visible on dark ones. It uploads a downsampled frozen backdrop once and redraws controls only as they change or animate. No egui/wgpu runtime, Node.js, or Python is shipped. The library uses brighter reflective chrome and dialogs, with Windows acrylic supplying desktop blur where enabled; its screenshot and reading surfaces stay calm. Reduced motion is respected. Capture glass works independently of the Windows transparency setting. Turn Liquid glass off in the capture menu for opaque surfaces. Windows high contrast uses system colors. Unsupported WebGL falls back to CSS glass.

## Troubleshooting

- **Shortcut unavailable:** choose another combination in Settings. The Capture button and desktop shortcut still work.
- **No microphone:** connect a microphone and select it as the default Windows input device. Check Windows microphone access for desktop apps.
- **No speech detected:** check microphone levels and record again. Silent recordings do not produce invented text.
- **Transcription failed:** the recording stays with the screenshot. Download the model if needed and click Retry transcription.
- **Save/export failed:** check free disk space and folder permissions. Unsaved text stays visible; failed exports do not replace existing folders.
- **Capture folder is outside the library:** a packaged launcher can redirect Windows app-data files. Exit Glassnote from its tray menu, then open it through Windows Start or the desktop shortcut. Opening another instance before exiting forwards to the same redirected process.
- **App cannot start:** details are written to `%TEMP%\glassnote-startup-error.log`.

See [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) for the speech model and native dependency licenses.
