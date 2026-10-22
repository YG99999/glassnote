use crate::{
    audio,
    crop::{physical_rect, Selection},
    speech,
    storage::{io_error, Result, Store},
};
use base64::Engine;
use image::{
    codecs::png::{CompressionType, FilterType, PngEncoder},
    ImageEncoder, RgbaImage,
};
use serde::Serialize;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{
    Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

struct Frame {
    image: RgbaImage,
    path: PathBuf,
    x: i32,
    y: i32,
    ready: bool,
}
impl Drop for Frame {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}
#[derive(Default)]
struct Session {
    selecting: bool,
    frames: HashMap<String, Frame>,
    active_id: Option<String>,
    recording: Option<Arc<AtomicBool>>,
    recording_thread: Option<std::thread::JoinHandle<()>>,
    restore_main: bool,
    overlay: Option<OverlayInfo>,
    recorder_ready: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OverlayInfo {
    background_path: Option<String>,
    width: u32,
    height: u32,
    region: [f64; 4],
}
pub struct AppState {
    store: Mutex<Store>,
    session: Mutex<Session>,
    downloading: AtomicBool,
    download_cancel: AtomicBool,
    quitting: AtomicBool,
    shortcut_error: Mutex<Option<String>>,
    library_ready: AtomicBool,
    library_requested: AtomicBool,
}
fn ui(window: &WebviewWindow, allowed: &[&str]) -> Result<()> {
    if allowed.contains(&window.label()) {
        Ok(())
    } else {
        Err("This window cannot perform that action".into())
    }
}
fn changed(app: &tauri::AppHandle) {
    let _ = app.emit("library-changed", ());
}
fn error_event(app: &tauri::AppHandle, error: &str) {
    let _ = app.emit("app-error", error);
}
fn encode_screenshot(image: &RgbaImage) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    PngEncoder::new_with_quality(&mut bytes, CompressionType::Fast, FilterType::Adaptive)
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            image::ExtendedColorType::Rgba8,
        )
        .map_err(io_error)?;
    Ok(bytes)
}
fn transparency_enabled() -> bool {
    winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
        .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize")
        .and_then(|k| k.get_value::<u32, _>("EnableTransparency"))
        .map(|v| v != 0)
        .unwrap_or(true)
}
fn apply_glass(window: &WebviewWindow) {
    if transparency_enabled() {
        let _ = window.set_effects(tauri::utils::config::WindowEffectsConfig {
            effects: vec![tauri::utils::WindowEffect::Acrylic],
            ..Default::default()
        });
    }
}
fn disable_window_animation(window: &WebviewWindow) {
    if let Ok(hwnd) = window.hwnd() {
        let disabled: i32 = 1;
        // SAFETY: this is our own live window, and the attribute takes a BOOL.
        unsafe {
            windows_sys::Win32::Graphics::Dwm::DwmSetWindowAttribute(
                hwnd.0,
                windows_sys::Win32::Graphics::Dwm::DWMWA_TRANSITIONS_FORCEDISABLED as u32,
                (&disabled as *const i32).cast(),
                std::mem::size_of::<i32>() as u32,
            );
        }
    }
}
fn model_path(state: &AppState) -> Result<PathBuf> {
    Ok(state
        .store
        .lock()
        .map_err(io_error)?
        .root
        .join("models")
        .join(speech::MODEL_NAME))
}
fn show_library(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    state.library_requested.store(true, Ordering::Relaxed);
    if !state.library_ready.load(Ordering::Acquire) {
        return;
    }
    // An explicit library request must remain reachable above a held screenshot.
    for (label, overlay) in app.webview_windows() {
        if label.starts_with("selector-") || label == "recorder" {
            let _ = overlay.hide();
        }
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    changed(app);
}
fn focus_workflow(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("recorder").or_else(|| {
        app.webview_windows()
            .into_iter()
            .find(|(label, _)| label.starts_with("selector-"))
            .map(|(_, w)| w)
    }) {
        let state = app.state::<AppState>();
        let ready = state
            .session
            .lock()
            .map(|s| {
                if window.label() == "recorder" {
                    s.recorder_ready
                } else {
                    s.frames.get(window.label()).is_some_and(|f| f.ready)
                }
            })
            .unwrap_or(false);
        if !ready {
            return;
        }
        let _ = window.show();
        let _ = window.set_focus();
    }
}
fn destroy_selectors(app: &tauri::AppHandle) {
    for (label, window) in app.webview_windows() {
        if label.starts_with("selector-") {
            let _ = window.destroy();
        }
    }
}
fn cancel_selection(app: &tauri::AppHandle) -> Result<()> {
    let state = app.state::<AppState>();
    let restore = {
        let mut session = state.session.lock().map_err(io_error)?;
        session.selecting = false;
        session.frames.clear();
        session.restore_main
    };
    destroy_selectors(app);
    if restore {
        show_library(app);
    }
    Ok(())
}
fn begin_capture(app: &tauri::AppHandle) -> Result<()> {
    let state = app.state::<AppState>();
    {
        let mut session = state.session.lock().map_err(io_error)?;
        if session.selecting || session.active_id.is_some() {
            drop(session);
            focus_workflow(app);
            return Ok(());
        }
        session.selecting = true;
        session.restore_main = app
            .get_webview_window("main")
            .and_then(|w| w.is_visible().ok())
            .unwrap_or(false);
    }
    state.library_requested.store(false, Ordering::Relaxed);
    if let Some(main) = app.get_webview_window("main") {
        if let Err(e) = main.hide() {
            state.session.lock().map_err(io_error)?.selecting = false;
            return Err(io_error(e));
        }
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let result = (|| -> Result<()> {
            // SAFETY: DwmFlush takes no pointers and only waits for presentation.
            unsafe {
                windows_sys::Win32::Graphics::Dwm::DwmFlush();
            }
            let state = app.state::<AppState>();
            let root = state.store.lock().map_err(io_error)?.root.join("selection");
            std::fs::create_dir_all(&root).map_err(io_error)?;
            let mut frames = HashMap::new();
            let monitors = xcap::Monitor::all().map_err(|e| {
                format!("The screen could not be captured. Try again on your desktop. {e}")
            })?;
            if monitors.is_empty() {
                return Err("No screens were found".into());
            }
            for (i, monitor) in monitors.iter().enumerate() {
                let label = format!("selector-{i}");
                let image = monitor
                    .capture_image()
                    .map_err(|e| format!("This screen could not be captured. {e}"))?;
                let path = root.join(format!("{}.png", uuid::Uuid::new_v4()));
                std::fs::write(&path, encode_screenshot(&image)?).map_err(io_error)?;
                frames.insert(
                    label,
                    Frame {
                        image,
                        path,
                        x: monitor.x().map_err(io_error)?,
                        y: monitor.y().map_err(io_error)?,
                        ready: false,
                    },
                );
            }
            let descriptions: Vec<_> = frames
                .iter()
                .map(|(label, f)| (label.clone(), f.x, f.y, f.image.width(), f.image.height()))
                .collect();
            {
                let mut session = state.session.lock().map_err(io_error)?;
                if !session.selecting {
                    return Ok(());
                }
                session.frames = frames;
            }
            for (label, x, y, width, height) in descriptions {
                let window = WebviewWindowBuilder::new(
                    &app,
                    &label,
                    WebviewUrl::App("index.html?view=selector".into()),
                )
                .title("Glassnote selection")
                .decorations(false)
                .shadow(false)
                .resizable(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .visible(false)
                .focused(false)
                .background_color(tauri::window::Color(24, 33, 43, 255))
                .build()
                .map_err(io_error)?;
                disable_window_animation(&window);
                window
                    .set_position(PhysicalPosition::new(x, y))
                    .map_err(io_error)?;
                window
                    .set_size(PhysicalSize::new(width, height))
                    .map_err(io_error)?;
            }
            Ok(())
        })();
        if let Err(error) = result {
            let _ = cancel_selection(&app);
            show_library(&app);
            error_event(&app, &error);
        }
    });
    Ok(())
}
fn show_recorder(app: &tauri::AppHandle, position: Option<(i32, i32)>) -> Result<()> {
    if app.get_webview_window("recorder").is_some() {
        focus_workflow(app);
        changed(app);
        return Ok(());
    }
    let window = WebviewWindowBuilder::new(
        app,
        "recorder",
        WebviewUrl::App("index.html?view=recorder".into()),
    )
    .title("Glassnote recorder")
    .inner_size(300.0, 64.0)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .shadow(false)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(false)
    .focused(false)
    .background_color(tauri::window::Color(0, 0, 0, 0))
    .build()
    .map_err(io_error)?;
    disable_window_animation(&window);
    if let Some((x, y)) = position {
        window
            .set_position(PhysicalPosition::new(x, y))
            .map_err(io_error)?;
    }
    let state = app.state::<AppState>();
    let mut session = state.session.lock().map_err(io_error)?;
    session.recorder_ready = false;
    if let Some(info) = &session.overlay {
        window
            .set_size(PhysicalSize::new(info.width, info.height))
            .map_err(io_error)?;
    } else {
        let monitor = window
            .current_monitor()
            .map_err(io_error)?
            .or(window.primary_monitor().map_err(io_error)?)
            .ok_or("No display is available")?;
        window.set_position(*monitor.position()).map_err(io_error)?;
        window.set_size(*monitor.size()).map_err(io_error)?;
        let store = state.store.lock().map_err(io_error)?;
        let c = store.capture(session.active_id.as_deref().ok_or("No capture is open")?)?;
        let scale = (f64::from(monitor.size().width) * 0.8 / f64::from(c.width))
            .min(f64::from(monitor.size().height) * 0.72 / f64::from(c.height))
            .min(1.0);
        let w = f64::from(c.width) * scale / f64::from(monitor.size().width);
        let h = f64::from(c.height) * scale / f64::from(monitor.size().height);
        session.overlay = Some(OverlayInfo {
            background_path: None,
            width: monitor.size().width,
            height: monitor.size().height,
            region: [(1.0 - w) / 2.0, (1.0 - h) / 2.0, w, h],
        });
    }
    Ok(())
}
#[tauri::command]
fn overlay_info(window: WebviewWindow, state: State<'_, AppState>) -> Result<OverlayInfo> {
    ui(&window, &["recorder"])?;
    state
        .session
        .lock()
        .map_err(io_error)?
        .overlay
        .clone()
        .ok_or_else(|| "This capture is no longer open".into())
}
#[tauri::command]
fn overlay_ready(window: WebviewWindow, app: tauri::AppHandle) -> Result<()> {
    ui(&window, &["recorder"])?;
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.hide();
    }
    app.state::<AppState>()
        .session
        .lock()
        .map_err(io_error)?
        .recorder_ready = true;
    window.show().map_err(io_error)?;
    window.set_focus().map_err(io_error)?;
    Ok(())
}
#[tauri::command]
fn window_ready(window: WebviewWindow, app: tauri::AppHandle) -> Result<()> {
    let state = app.state::<AppState>();
    if window.label() == "main" {
        state.library_ready.store(true, Ordering::Release);
        if state.library_requested.load(Ordering::Relaxed) {
            show_library(&app);
        }
    } else if window.label().starts_with("selector-") {
        let mut session = state.session.lock().map_err(io_error)?;
        if !session.selecting || !session.frames.contains_key(window.label()) {
            return Err("This selection has expired".into());
        }
        session
            .frames
            .get_mut(window.label())
            .ok_or("This selection has expired")?
            .ready = true;
        drop(session);
        window.show().map_err(io_error)?;
        if window.label() == "selector-0" {
            window.set_focus().map_err(io_error)?;
        }
    } else {
        return Err("This window cannot perform that action".into());
    }
    Ok(())
}
#[tauri::command]
async fn overlay_presented(window: WebviewWindow, app: tauri::AppHandle, id: String) -> Result<()> {
    ui(&window, &["recorder"])?;
    authorize_capture(&window, &app.state::<AppState>(), &id)?;
    tauri::async_runtime::spawn_blocking(move || {
        // The frontend has painted the frozen image; wait for composition before
        // removing the old selection so the live desktop never flashes through.
        // SAFETY: DwmFlush takes no pointers and synchronizes this compositor.
        unsafe {
            windows_sys::Win32::Graphics::Dwm::DwmFlush();
        }
        let current = app
            .state::<AppState>()
            .session
            .lock()
            .map(|session| session.active_id.as_deref() == Some(id.as_str()))
            .unwrap_or(false);
        if current {
            destroy_selectors(&app);
        }
    })
    .await
    .map_err(io_error)?;
    Ok(())
}
#[tauri::command]
fn snapshot(window: WebviewWindow, state: State<'_, AppState>) -> Result<crate::storage::Snapshot> {
    ui(&window, &["main", "recorder"])?;
    let active = state.session.lock().map_err(io_error)?.active_id.clone();
    let store = state.store.lock().map_err(io_error)?;
    store.snapshot(
        speech::model_ready(&store.root.join("models").join(speech::MODEL_NAME)),
        state.downloading.load(Ordering::Relaxed),
        transparency_enabled(),
        active,
        state.shortcut_error.lock().map_err(io_error)?.clone(),
        window.label() == "recorder",
    )
}
#[tauri::command]
fn capture_screen(window: WebviewWindow, app: tauri::AppHandle) -> Result<()> {
    ui(&window, &["main"])?;
    begin_capture(&app)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SelectorInfo {
    screenshot_path: String,
    width: u32,
    height: u32,
}
#[tauri::command]
fn selector_info(window: WebviewWindow, state: State<'_, AppState>) -> Result<SelectorInfo> {
    let session = state.session.lock().map_err(io_error)?;
    let frame = session
        .frames
        .get(window.label())
        .ok_or("This selection has expired")?;
    Ok(SelectorInfo {
        screenshot_path: frame.path.to_string_lossy().into_owned(),
        width: frame.image.width(),
        height: frame.image.height(),
    })
}
#[tauri::command]
fn cancel_capture(window: WebviewWindow, app: tauri::AppHandle) -> Result<()> {
    if !window.label().starts_with("selector-") {
        return Err("Only a screen selection can be cancelled".into());
    }
    if app
        .state::<AppState>()
        .session
        .lock()
        .map_err(io_error)?
        .active_id
        .is_some()
    {
        let _ = app.emit_to("recorder", "recorder-close-requested", ());
        return Ok(());
    }
    cancel_selection(&app)
}
#[tauri::command]
async fn select_region(
    window: WebviewWindow,
    app: tauri::AppHandle,
    selection: Selection,
) -> Result<()> {
    let label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let (png, width, height, position, overlay) = {
            let mut session = state.session.lock().map_err(io_error)?;
            if !session.selecting {
                return Err("This selection has expired".into());
            }
            let frame = session
                .frames
                .get(&label)
                .ok_or("This screen selection is unavailable")?;
            let (x, y, w, h) =
                physical_rect(&selection, frame.image.width(), frame.image.height())?;
            let image = image::imageops::crop_imm(&frame.image, x, y, w, h).to_image();
            let png = encode_screenshot(&image)?;
            let result = (
                png,
                w,
                h,
                (frame.x, frame.y),
                OverlayInfo {
                    background_path: Some(frame.path.to_string_lossy().into_owned()),
                    width: frame.image.width(),
                    height: frame.image.height(),
                    region: [
                        f64::from(x) / f64::from(frame.image.width()),
                        f64::from(y) / f64::from(frame.image.height()),
                        f64::from(w) / f64::from(frame.image.width()),
                        f64::from(h) / f64::from(frame.image.height()),
                    ],
                },
            );
            session.selecting = false;
            result
        };
        let result = state
            .store
            .lock()
            .map_err(io_error)?
            .insert_capture(&png, width, height);
        let id = match result {
            Ok(id) => id,
            Err(error) => {
                state.session.lock().map_err(io_error)?.selecting = true;
                return Err(error);
            }
        };
        {
            let mut session = state.session.lock().map_err(io_error)?;
            session.selecting = false;
            session.active_id = Some(id);
            session.overlay = Some(overlay);
            session.frames.retain(|key, _| key == &label);
        }
        let _ = app.emit("capture-selected", ());
        // Keep the frozen desktop visible without allowing it to cover the pill.
        for (label, overlay) in app.webview_windows() {
            if label.starts_with("selector-") {
                let _ = overlay.set_focusable(false);
                let _ = overlay.set_enabled(false);
            }
        }
        if let Err(error) = show_recorder(&app, Some(position)) {
            let mut session = state.session.lock().map_err(io_error)?;
            session.active_id = None;
            session.frames.clear();
            session.overlay = None;
            drop(session);
            destroy_selectors(&app);
            show_library(&app);
            return Err(error);
        }
        changed(&app);
        Ok(())
    })
    .await
    .map_err(io_error)?
}
#[tauri::command]
fn create_project(
    window: WebviewWindow,
    app: tauri::AppHandle,
    name: String,
    parent_id: Option<String>,
) -> Result<crate::storage::Project> {
    ui(&window, &["main", "recorder"])?;
    let project = app
        .state::<AppState>()
        .store
        .lock()
        .map_err(io_error)?
        .create_subproject(&name, parent_id.as_deref())?;
    changed(&app);
    Ok(project)
}
#[tauri::command]
fn rename_project(
    window: WebviewWindow,
    app: tauri::AppHandle,
    id: String,
    name: String,
) -> Result<()> {
    ui(&window, &["main"])?;
    app.state::<AppState>()
        .store
        .lock()
        .map_err(io_error)?
        .rename_project(&id, &name)?;
    changed(&app);
    Ok(())
}
#[tauri::command]
fn delete_project(window: WebviewWindow, app: tauri::AppHandle, id: String) -> Result<()> {
    ui(&window, &["main"])?;
    let state = app.state::<AppState>();
    let session = state.session.lock().map_err(io_error)?;
    let mut store = state.store.lock().map_err(io_error)?;
    let ids = store.project_tree(&id)?;
    if session
        .active_id
        .as_deref()
        .and_then(|id| store.capture(id).ok())
        .is_some_and(|c| ids.contains(&c.project_id))
    {
        return Err("Save or close the open capture before deleting its project".into());
    }
    store.delete_project(&id)?;
    drop(store);
    drop(session);
    changed(&app);
    Ok(())
}
#[tauri::command]
fn choose_project(window: WebviewWindow, app: tauri::AppHandle, id: String) -> Result<()> {
    ui(&window, &["main", "recorder"])?;
    app.state::<AppState>()
        .store
        .lock()
        .map_err(io_error)?
        .set_project(&id)?;
    changed(&app);
    Ok(())
}
fn ensure_editable(store: &Store, id: &str) -> Result<()> {
    if matches!(
        store.capture(id)?.status.as_str(),
        "recording" | "transcribing"
    ) {
        Err("Finish recording and transcription before changing this capture".into())
    } else {
        Ok(())
    }
}
fn authorize_capture(window: &WebviewWindow, state: &AppState, id: &str) -> Result<()> {
    ui(window, &["main", "recorder"])?;
    if window.label() == "recorder"
        && state.session.lock().map_err(io_error)?.active_id.as_deref() != Some(id)
    {
        return Err("This capture is no longer open in the recorder".into());
    }
    Ok(())
}
#[tauri::command]
fn save_transcript(
    window: WebviewWindow,
    app: tauri::AppHandle,
    id: String,
    text: String,
) -> Result<()> {
    let state = app.state::<AppState>();
    authorize_capture(&window, &state, &id)?;
    {
        let store = state.store.lock().map_err(io_error)?;
        ensure_editable(&store, &id)?;
        store.write_transcript(&id, &text)?;
    }
    changed(&app);
    Ok(())
}
#[tauri::command]
async fn save_annotations(
    window: WebviewWindow,
    app: tauri::AppHandle,
    id: String,
    items: Vec<crate::annotations::Annotation>,
    image: String,
) -> Result<()> {
    let state = app.state::<AppState>();
    authorize_capture(&window, &state, &id)?;
    if image.len() > 54_000_000 {
        return Err("The annotated screenshot is too large".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let png = base64::engine::general_purpose::STANDARD
            .decode(image)
            .map_err(|_| "The annotated screenshot could not be read")?;
        app.state::<AppState>()
            .store
            .lock()
            .map_err(io_error)?
            .save_annotations(&id, items, &png)?;
        changed(&app);
        Ok(())
    })
    .await
    .map_err(io_error)?
}
#[tauri::command]
fn move_capture(
    window: WebviewWindow,
    app: tauri::AppHandle,
    id: String,
    project_id: String,
) -> Result<()> {
    ui(&window, &["main"])?;
    {
        let state = app.state::<AppState>();
        let mut store = state.store.lock().map_err(io_error)?;
        ensure_editable(&store, &id)?;
        store.move_capture(&id, &project_id)?;
    }
    changed(&app);
    Ok(())
}
#[tauri::command]
fn delete_capture(window: WebviewWindow, app: tauri::AppHandle, id: String) -> Result<()> {
    ui(&window, &["main"])?;
    let state = app.state::<AppState>();
    if state.session.lock().map_err(io_error)?.active_id.as_deref() == Some(&id) {
        return Err("Close this capture's recorder before deleting it".into());
    }
    {
        let mut store = state.store.lock().map_err(io_error)?;
        ensure_editable(&store, &id)?;
        store.delete_capture(&id)?;
    }
    changed(&app);
    Ok(())
}
#[tauri::command]
async fn resume_capture(window: WebviewWindow, app: tauri::AppHandle, id: String) -> Result<()> {
    ui(&window, &["main"])?;
    let state = app.state::<AppState>();
    {
        let mut session = state.session.lock().map_err(io_error)?;
        if session.active_id.is_some() || session.selecting {
            drop(session);
            focus_workflow(&app);
            return Ok(());
        }
        state.store.lock().map_err(io_error)?.capture(&id)?;
        session.active_id = Some(id);
        session.restore_main = true;
    }
    if let Err(error) = show_recorder(&app, None) {
        let mut session = state.session.lock().map_err(io_error)?;
        session.active_id = None;
        session.overlay = None;
        return Err(error);
    }
    changed(&app);
    Ok(())
}
#[tauri::command]
fn finish_capture(
    window: WebviewWindow,
    app: tauri::AppHandle,
    id: String,
    project_id: String,
    text: String,
    discard: bool,
) -> Result<()> {
    ui(&window, &["recorder"])?;
    let state = app.state::<AppState>();
    authorize_capture(&window, &state, &id)?;
    {
        let mut store = state.store.lock().map_err(io_error)?;
        ensure_editable(&store, &id)?;
        if discard {
            store.delete_capture(&id)?;
        } else {
            store.project(&project_id)?;
            store.write_transcript(&id, &text)?;
            store.move_capture(&id, &project_id)?;
            store.update_capture(&id, |c| c.draft = false)?;
            store.set_project(&project_id)?;
        }
    }
    if discard {
        let mut session = state.session.lock().map_err(io_error)?;
        session.active_id = None;
        session.frames.clear();
        session.overlay = None;
        drop(session);
        destroy_selectors(&app);
        window.destroy().map_err(io_error)?;
    }
    // Keep a saved pill alive briefly for its destination confirmation. The frontend then shelves it.
    changed(&app);
    Ok(())
}
#[tauri::command]
fn shelve_capture(window: WebviewWindow, app: tauri::AppHandle) -> Result<()> {
    ui(&window, &["recorder"])?;
    let state = app.state::<AppState>();
    {
        let mut session = state.session.lock().map_err(io_error)?;
        if let Some(id) = &session.active_id {
            let store = state.store.lock().map_err(io_error)?;
            if store.capture(id)?.status == "recording" {
                return Err("Stop the recording before closing this capture".into());
            }
        }
        session.active_id = None;
        session.frames.clear();
        session.overlay = None;
    }
    destroy_selectors(&app);
    window.destroy().map_err(io_error)?;
    changed(&app);
    Ok(())
}
#[tauri::command]
fn open_library(window: WebviewWindow, app: tauri::AppHandle) -> Result<()> {
    ui(&window, &["main", "recorder"])?;
    show_library(&app);
    Ok(())
}
fn transcribe_capture(app: tauri::AppHandle, id: String) {
    let result = (|| -> Result<()> {
        let state = app.state::<AppState>();
        if state.quitting.load(Ordering::Relaxed) {
            return Err("Transcription was interrupted. Retry to finish this note.".into());
        }
        let model = model_path(&state)?;
        let (audio, base) = {
            let mut store = state.store.lock().map_err(io_error)?;
            store.update_capture(&id, |c| {
                c.status = "transcribing".into();
                c.error = None;
            })?;
            let segment = store.asset(&id, "segment.wav")?;
            if segment.exists() {
                (segment, store.recording_base(&id)?)
            } else {
                (store.asset(&id, "audio.wav")?, String::new())
            }
        };
        changed(&app);
        let cancel_app = app.clone();
        let progress_app = app.clone();
        let progress_id = id.clone();
        let text = speech::transcribe(
            &model,
            &audio,
            move || {
                cancel_app
                    .state::<AppState>()
                    .quitting
                    .load(Ordering::Relaxed)
            },
            move |percent| {
                let _ = progress_app.emit(
                    "transcription-progress",
                    serde_json::json!({"captureId":progress_id,"percent":percent}),
                );
            },
        )?;
        let mut store = state.store.lock().map_err(io_error)?;
        store.write_recording_text(&id, &append_text(&base, &text))?;
        store.update_capture(&id, |c| {
            c.status = "ready".into();
            c.error = None;
        })
    })();
    if let Err(error) = result {
        if let Ok(mut store) = app.state::<AppState>().store.lock() {
            let _ = store.update_capture(&id, |c| {
                c.status = "failed".into();
                c.error = Some(error);
            });
        }
    }
    let _ = app.emit(
        "transcription-complete",
        serde_json::json!({"captureId": id}),
    );
}
fn append_text(base: &str, text: &str) -> String {
    [base.trim(), text.trim()]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}
#[tauri::command]
fn start_recording(
    window: WebviewWindow,
    app: tauri::AppHandle,
    id: String,
    annotation_id: Option<u32>,
) -> Result<()> {
    ui(&window, &["recorder"])?;
    let state = app.state::<AppState>();
    authorize_capture(&window, &state, &id)?;
    if !speech::model_ready(&model_path(&state)?) {
        return Err("Download the speech model in Settings before recording. You can still save a screenshot without audio.".into());
    }
    let stop = Arc::new(AtomicBool::new(false));
    let path;
    {
        let mut session = state.session.lock().map_err(io_error)?;
        if session.recording.is_some() {
            return Err("A recording is already in progress".into());
        }
        let mut store = state.store.lock().map_err(io_error)?;
        ensure_editable(&store, &id)?;
        if store
            .captures
            .iter()
            .any(|c| c.id != id && matches!(c.status.as_str(), "recording" | "transcribing"))
        {
            return Err(
                "Another voice note is still processing. Wait for it to finish before recording."
                    .into(),
            );
        }
        path = store.capture_dir(&id)?.join("recording.wav");
        if let Some(target) = annotation_id {
            if !store
                .capture(&id)?
                .annotations
                .iter()
                .any(|a| a.id == target && a.kind == "pin")
            {
                return Err("Choose an existing numbered note before recording".into());
            }
        }
        store.update_capture(&id, |c| c.recording_target = annotation_id)?;
        store.prepare_recording(&id)?;
        store.update_capture(&id, |c| {
            c.status = "recording".into();
            c.error = None;
        })?;
        session.recording = Some(stop.clone());
    }
    changed(&app);
    let worker_app = app.clone();
    let join = std::thread::spawn(move || {
        let meter_app = worker_app.clone();
        let meter_id = id.clone();
        let live_audio = Arc::new(Mutex::new(speech::LiveAudio::default()));
        let live_done = Arc::new(AtomicBool::new(false));
        let live_app = worker_app.clone();
        let live_id = id.clone();
        let live_history = live_audio.clone();
        let live_finished = live_done.clone();
        let live_model = model_path(&worker_app.state::<AppState>());
        let live_thread = std::thread::spawn(move || {
            speech::live_decode(&live_model?, live_history, live_finished, |text| {
                let _ = live_app.emit(
                    "transcript-partial",
                    serde_json::json!({"captureId":live_id,"annotationId":annotation_id,"text":text}),
                );
            })
        });
        let mut result = audio::record(
            &path,
            &stop,
            move |level, elapsed| {
                let _ = meter_app.emit(
                    "audio-level",
                    serde_json::json!({"captureId":meter_id,"level":level,"elapsed":elapsed}),
                );
            },
            |samples, rate| {
                if let Ok(mut audio) = live_audio.lock() {
                    audio.push(samples, rate);
                }
            },
        );
        // Publish a complete WAV atomically. Failed microphone startup leaves the previous note intact.
        if hound::WavReader::open(&path)
            .map(|r| r.duration() > 0)
            .unwrap_or(false)
        {
            let published = (|| -> Result<()> {
                let state = worker_app.state::<AppState>();
                let store = state.store.lock().map_err(io_error)?;
                store.publish_recording(&id, &path)?;
                std::fs::remove_file(&path).map_err(io_error)?;
                Ok(())
            })();
            if let Err(error) = published {
                result = Err(error);
            }
        } else if result.is_ok() {
            result = Err("No microphone audio was captured. Check your microphone and try again. Your earlier recording is kept.".into());
        }
        if let Ok(mut session) = worker_app.state::<AppState>().session.lock() {
            session.recording = None;
        }
        if result.is_ok() {
            if let Ok(mut store) = worker_app.state::<AppState>().store.lock() {
                let _ = store.update_capture(&id, |c| c.status = "transcribing".into());
            }
            changed(&worker_app);
        }
        live_done.store(true, Ordering::Relaxed);
        let decoder = live_thread
            .join()
            .map_err(|_| "Live transcription stopped. Your audio is kept.".to_string())
            .and_then(|d| d);
        match result {
            Ok(()) => {
                let final_result = (|| -> Result<()> {
                    let mut decoder = decoder?;
                    let state = worker_app.state::<AppState>();
                    if state.quitting.load(Ordering::Relaxed) {
                        return Err(
                            "Transcription interrupted. Your audio is kept; retry when ready."
                                .into(),
                        );
                    }
                    let (audio_path, base) = {
                        let store = state.store.lock().map_err(io_error)?;
                        (store.asset(&id, "segment.wav")?, store.recording_base(&id)?)
                    };
                    let samples = speech::read_audio(&audio_path)?;
                    let progress_app = worker_app.clone();
                    let progress_id = id.clone();
                    let text = decoder.decode(&samples, false, move |percent| {
                        let _ = progress_app.emit(
                            "transcription-progress",
                            serde_json::json!({"captureId":progress_id,"percent":percent}),
                        );
                    })?;
                    if state.quitting.load(Ordering::Relaxed) {
                        return Err(
                            "Transcription interrupted. Your audio is kept; retry when ready."
                                .into(),
                        );
                    }
                    let mut store = state.store.lock().map_err(io_error)?;
                    store.write_recording_text(&id, &append_text(&base, &text))?;
                    store.update_capture(&id, |c| {
                        c.status = "ready".into();
                        c.error = None;
                    })
                })();
                if let Err(error) = final_result {
                    if let Ok(mut store) = worker_app.state::<AppState>().store.lock() {
                        let _ = store.update_capture(&id, |c| {
                            c.status = "failed".into();
                            c.error = Some(error);
                        });
                    }
                }
                let _ = worker_app.emit(
                    "transcription-complete",
                    serde_json::json!({"captureId":id}),
                );
            }
            Err(error) => {
                if let Ok(mut store) = worker_app.state::<AppState>().store.lock() {
                    let _ = store.update_capture(&id, |c| {
                        c.status = "failed".into();
                        c.error = Some(error);
                    });
                }
                changed(&worker_app);
            }
        }
    });
    state.session.lock().map_err(io_error)?.recording_thread = Some(join);
    Ok(())
}
#[tauri::command]
fn stop_recording(window: WebviewWindow, app: tauri::AppHandle, id: String) -> Result<()> {
    ui(&window, &["recorder"])?;
    let state = app.state::<AppState>();
    authorize_capture(&window, &state, &id)?;
    let session = state.session.lock().map_err(io_error)?;
    session
        .recording
        .as_ref()
        .ok_or("No recording is in progress")?
        .store(true, Ordering::Relaxed);
    Ok(())
}
#[tauri::command]
fn retry_transcription(window: WebviewWindow, app: tauri::AppHandle, id: String) -> Result<()> {
    let state = app.state::<AppState>();
    authorize_capture(&window, &state, &id)?;
    {
        let mut store = state.store.lock().map_err(io_error)?;
        ensure_editable(&store, &id)?;
        if store
            .captures
            .iter()
            .any(|c| c.id != id && matches!(c.status.as_str(), "recording" | "transcribing"))
        {
            return Err(
                "Another voice note is still processing. Wait for it to finish before retrying."
                    .into(),
            );
        }
        if !store.asset(&id, "audio.wav")?.exists() {
            return Err("There is no recording to transcribe. Record a voice note first.".into());
        }
        if store.asset(&id, "recording-base.txt")?.exists()
            && !store.asset(&id, "segment.wav")?.exists()
        {
            return Err("This take did not capture any audio. Continue recording to try your microphone again. Your earlier audio and text are kept.".into());
        }
        store.update_capture(&id, |c| {
            c.status = "transcribing".into();
            c.error = None;
        })?;
    }
    changed(&app);
    std::thread::spawn(move || transcribe_capture(app, id));
    Ok(())
}
#[tauri::command]
fn download_model(window: WebviewWindow, app: tauri::AppHandle) -> Result<()> {
    ui(&window, &["main", "recorder"])?;
    let state = app.state::<AppState>();
    if state
        .store
        .lock()
        .map_err(io_error)?
        .captures
        .iter()
        .any(|c| c.status == "transcribing" || c.status == "recording")
    {
        return Err("Finish your current recording before downloading the model".into());
    }
    if state.downloading.swap(true, Ordering::SeqCst) {
        return Err("The speech model is already downloading".into());
    }
    state.download_cancel.store(false, Ordering::Relaxed);
    let path = model_path(&state)?;
    changed(&app);
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        let progress_app = app.clone();
        let result = speech::download_model(&path, &state.download_cancel, |bytes| {
            let _ = progress_app.emit(
                "model-progress",
                serde_json::json!({"downloaded":bytes,"total":speech::MODEL_SIZE}),
            );
        });
        state.downloading.store(false, Ordering::SeqCst);
        if let Err(error) = result {
            error_event(&app, &error);
        }
        changed(&app);
    });
    Ok(())
}
#[tauri::command]
fn cancel_model_download(window: WebviewWindow, state: State<'_, AppState>) -> Result<()> {
    ui(&window, &["main", "recorder"])?;
    state.download_cancel.store(true, Ordering::Relaxed);
    Ok(())
}
#[tauri::command]
fn set_shortcut(window: WebviewWindow, app: tauri::AppHandle, value: String) -> Result<()> {
    ui(&window, &["main"])?;
    let shortcut = value
        .parse::<Shortcut>()
        .map_err(|_| "Use a shortcut such as Ctrl+Alt+S")?;
    if !value.contains('+') || value.len() > 80 {
        return Err("Use a shortcut with Ctrl, Alt, or Shift and a key".into());
    }
    let state = app.state::<AppState>();
    let previous = state
        .store
        .lock()
        .map_err(io_error)?
        .settings()
        .shortcut
        .clone();
    if previous.parse::<Shortcut>().ok() == Some(shortcut)
        && app.global_shortcut().is_registered(shortcut)
    {
        state.store.lock().map_err(io_error)?.set_shortcut(value)?;
        *state.shortcut_error.lock().map_err(io_error)? = None;
        changed(&app);
        return Ok(());
    }
    app.global_shortcut().register(shortcut).map_err(|e|format!("This shortcut could not be registered. Another app may be using it. Choose another combination. {e}"))?;
    if let Err(error) = state.store.lock().map_err(io_error)?.set_shortcut(value) {
        let _ = app.global_shortcut().unregister(shortcut);
        return Err(error);
    }
    if let Ok(old) = previous.parse::<Shortcut>() {
        if old != shortcut {
            let _ = app.global_shortcut().unregister(old);
        }
    }
    *state.shortcut_error.lock().map_err(io_error)? = None;
    changed(&app);
    Ok(())
}
#[tauri::command]
async fn export_project(
    window: WebviewWindow,
    app: tauri::AppHandle,
    project_id: String,
) -> Result<Option<String>> {
    ui(&window, &["main"])?;
    tauri::async_runtime::spawn_blocking(move || {
        let folder = app
            .dialog()
            .file()
            .set_title("Choose where to export this project")
            .blocking_pick_folder();
        let Some(folder) = folder else {
            return Ok(None);
        };
        let folder = folder.into_path().map_err(io_error)?;
        let path = app
            .state::<AppState>()
            .store
            .lock()
            .map_err(io_error)?
            .export(&project_id, &folder)?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(io_error)?
}
#[tauri::command]
async fn copy_project_path(
    window: WebviewWindow,
    app: tauri::AppHandle,
    project_id: String,
) -> Result<String> {
    ui(&window, &["main"])?;
    let path = tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>()
            .store
            .lock()
            .map_err(io_error)?
            .share_project(&project_id)
    })
    .await
    .map_err(io_error)??;
    let text = format!("\"{}\"", path.display());
    copy_text(&window, &text)?;
    Ok(path.to_string_lossy().into_owned())
}
fn copy_text(window: &WebviewWindow, text: &str) -> Result<()> {
    use windows_sys::Win32::{
        Foundation::GlobalFree,
        System::{DataExchange::*, Memory::*, Ole::CF_UNICODETEXT},
    };
    let wide: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
    let owner = window.hwnd().map_err(io_error)?.0;
    // SAFETY: allocate and lock the exact UTF-16 buffer size; clipboard owns memory only after SetClipboardData succeeds.
    unsafe {
        let memory = GlobalAlloc(GMEM_MOVEABLE, wide.len() * std::mem::size_of::<u16>());
        if memory.is_null() {
            return Err("Not enough memory to copy the folder path".into());
        }
        let target = GlobalLock(memory).cast::<u16>();
        if target.is_null() {
            GlobalFree(memory);
            return Err("Could not prepare the clipboard. Try again.".into());
        }
        std::ptr::copy_nonoverlapping(wide.as_ptr(), target, wide.len());
        GlobalUnlock(memory);
        if OpenClipboard(owner) == 0 {
            GlobalFree(memory);
            return Err(
                "Another app is using the clipboard. Click Copy folder as path again.".into(),
            );
        }
        let copied =
            EmptyClipboard() != 0 && !SetClipboardData(u32::from(CF_UNICODETEXT), memory).is_null();
        CloseClipboard();
        if !copied {
            GlobalFree(memory);
            return Err("The folder path could not be copied. Try again.".into());
        }
    }
    Ok(())
}
#[tauri::command]
async fn export_project_zip(
    window: WebviewWindow,
    app: tauri::AppHandle,
    project_id: String,
) -> Result<Option<String>> {
    ui(&window, &["main"])?;
    tauri::async_runtime::spawn_blocking(move || {
        let folder = app
            .dialog()
            .file()
            .set_title("Choose where to save the ZIP")
            .blocking_pick_folder();
        let Some(folder) = folder else {
            return Ok(None);
        };
        let folder = folder.into_path().map_err(io_error)?;
        let path = app
            .state::<AppState>()
            .store
            .lock()
            .map_err(io_error)?
            .export_zip(&project_id, &folder)?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(io_error)?
}
fn quit(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    state.quitting.store(true, Ordering::Relaxed);
    state.download_cancel.store(true, Ordering::Relaxed);
    let join = if let Ok(mut session) = state.session.lock() {
        if let Some(stop) = &session.recording {
            stop.store(true, Ordering::Relaxed);
        }
        session.recording_thread.take()
    } else {
        None
    };
    let app = app.clone();
    std::thread::spawn(move || {
        if let Some(join) = join {
            let _ = join.join();
        }
        app.exit(0);
    });
}
pub fn run() {
    let builder=tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app,args,_|{if args.iter().any(|a|a=="--capture"){if let Err(e)=begin_capture(app){error_event(app,&e);}}else{show_library(app);}}))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(|app,_,event|{if event.state()==ShortcutState::Pressed{if let Err(e)=begin_capture(app){error_event(app,&e);}}}).build())
        .invoke_handler(tauri::generate_handler![snapshot,capture_screen,selector_info,cancel_capture,select_region,overlay_info,overlay_ready,window_ready,overlay_presented,create_project,rename_project,delete_project,choose_project,save_transcript,save_annotations,move_capture,delete_capture,resume_capture,finish_capture,shelve_capture,open_library,start_recording,stop_recording,retry_transcription,download_model,cancel_model_download,set_shortcut,export_project,copy_project_path,export_project_zip])
        .setup(|app|{
            let root=std::env::var_os("GLASSNOTE_DATA_DIR").map(PathBuf::from).unwrap_or(app.path().app_local_data_dir()?);
            let store=Store::open(root.clone()).map_err(std::io::Error::other)?;
            let selection=root.join("selection");std::fs::create_dir_all(&selection)?;
            for entry in std::fs::read_dir(&selection)?.flatten(){if entry.file_type().map(|t|t.is_file()).unwrap_or(false)&&entry.path().extension().is_some_and(|s|s=="png")&&entry.path().file_stem().is_some_and(|s|uuid::Uuid::parse_str(&s.to_string_lossy()).is_ok()){let _=std::fs::remove_file(entry.path());}}
            app.asset_protocol_scope().allow_directory(root.join("captures"),true)?;app.asset_protocol_scope().allow_directory(&selection,true)?;
            app.manage(AppState{store:Mutex::new(store),session:Mutex::new(Session::default()),downloading:AtomicBool::new(false),download_cancel:AtomicBool::new(false),quitting:AtomicBool::new(false),shortcut_error:Mutex::new(None),library_ready:AtomicBool::new(false),library_requested:AtomicBool::new(false)});
            if let Some(main)=app.get_webview_window("main"){disable_window_animation(&main);main.set_background_color(Some(tauri::window::Color(0,0,0,0)))?;apply_glass(&main);}
            let shortcut=app.state::<AppState>().store.lock().map_err(|_|"Library lock failed")?.settings().shortcut.clone();
            if let Err(error)=app.global_shortcut().register(shortcut.as_str()){*app.state::<AppState>().shortcut_error.lock().map_err(|_|"Shortcut lock failed")?=Some(format!("The capture shortcut is unavailable. Choose another combination in Settings. {error}"));}
            let capture=tauri::menu::MenuItem::with_id(app,"capture","Capture",true,None::<&str>)?;
            let open=tauri::menu::MenuItem::with_id(app,"open","Open library",true,None::<&str>)?;
            let exit=tauri::menu::MenuItem::with_id(app,"exit","Exit",true,None::<&str>)?;
            let menu=tauri::menu::Menu::with_items(app,&[&capture,&open,&exit])?;
            let mut tray=tauri::tray::TrayIconBuilder::new().tooltip("Glassnote").menu(&menu).show_menu_on_left_click(true).on_menu_event(|app,event|match event.id().as_ref(){"capture"=>{if let Err(e)=begin_capture(app){error_event(app,&e);}},"open"=>show_library(app),"exit"=>quit(app),_=>()});
            if let Some(icon)=app.default_window_icon(){tray=tray.icon(icon.clone());}tray.build(app)?;
            if std::env::args().any(|a|a=="--capture"){begin_capture(app.handle()).map_err(std::io::Error::other)?;}else{show_library(app.handle());} Ok(())
        })
        .on_window_event(|window,event|{
            if let tauri::WindowEvent::CloseRequested{api,..}=event {
                api.prevent_close();
                if window.label()=="main"{let _=window.hide();}
                else if window.label().starts_with("selector-"){if window.app_handle().state::<AppState>().session.lock().map(|s|s.active_id.is_some()).unwrap_or(false){let _=window.app_handle().emit_to("recorder","recorder-close-requested",());}else{let _=cancel_selection(window.app_handle());}}
                else if window.label()=="recorder"{let _=window.emit("recorder-close-requested",());}
            }
        });
    match builder.build(tauri::generate_context!()) {
        Ok(app) => app.run(|_, _| {}),
        Err(error) => {
            let message = format!("Glassnote could not start: {error}");
            eprintln!("{message}");
            let _ = std::fs::write(
                std::env::temp_dir().join("glassnote-startup-error.log"),
                &message,
            );
            let wide: Vec<u16> = message.encode_utf16().chain(Some(0)).collect();
            let title: Vec<u16> = "Glassnote".encode_utf16().chain(Some(0)).collect();
            // SAFETY: both strings are valid, NUL-terminated UTF-16 for the duration of this call.
            unsafe {
                windows_sys::Win32::UI::WindowsAndMessaging::MessageBoxW(
                    std::ptr::null_mut(),
                    wide.as_ptr(),
                    title.as_ptr(),
                    windows_sys::Win32::UI::WindowsAndMessaging::MB_OK
                        | windows_sys::Win32::UI::WindowsAndMessaging::MB_ICONERROR,
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn fast_screenshot_encoding_preserves_every_pixel() {
        let image = image::RgbaImage::from_fn(17, 11, |x, y| {
            image::Rgba([(x * 13) as u8, (y * 21) as u8, (x * y) as u8, 255])
        });
        let png = super::encode_screenshot(&image).unwrap();
        assert_eq!(image::load_from_memory(&png).unwrap().to_rgba8(), image);
    }
}
