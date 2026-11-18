//! Display enumeration, the display the agent works on, and the identify overlay
//! that shows each display's number on its own screen.

use crate::screenshot::ScreenshotError;
use serde::Serialize;
use std::{
    sync::atomic::{AtomicU32, Ordering},
    time::Duration,
};
use tauri::{Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};
use xcap::Monitor;

/// How long the identify overlay stays up.
const IDENTIFY_SECONDS: u64 = 3;
const IDENTIFY_PREFIX: &str = "identify-";
/// Each identify run gets its own window labels, so a run can start before the
/// previous run's windows have finished closing.
static IDENTIFY_GENERATION: AtomicU32 = AtomicU32::new(0);

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct DisplayInfo {
    /// Windows device name, such as `\\.\DISPLAY2`. Settings store this name.
    pub name: String,
    /// The monitor's own name (for example "Dell U2720Q"), or the device name
    /// when Windows does not provide one.
    pub friendly_name: String,
    /// Number shown in Settings and on the identify overlay: left to right, then
    /// top to bottom, starting at 1.
    pub number: u32,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub primary: bool,
}

/// Number displays left to right, then top to bottom, starting at 1.
fn number_displays<T>(displays: &mut [(T, DisplayInfo)]) {
    displays.sort_by_key(|(_, info)| (info.x, info.y));
    for (index, (_, info)) in displays.iter_mut().enumerate() {
        info.number = index as u32 + 1;
    }
}

fn capture_error(e: xcap::XCapError) -> ScreenshotError {
    ScreenshotError::CaptureError(e.to_string())
}

/// Every connected display with its monitor handle, in numbering order.
fn entries() -> Result<Vec<(Monitor, DisplayInfo)>, ScreenshotError> {
    let mut found = Vec::new();
    for monitor in Monitor::all().map_err(capture_error)? {
        let name = monitor.name().map_err(capture_error)?;
        let friendly_name = monitor
            .friendly_name()
            .ok()
            .filter(|label| !label.trim().is_empty())
            .unwrap_or_else(|| name.clone());
        let info = DisplayInfo {
            name,
            friendly_name,
            number: 0,
            x: monitor.x().map_err(capture_error)?,
            y: monitor.y().map_err(capture_error)?,
            width: monitor.width().map_err(capture_error)?,
            height: monitor.height().map_err(capture_error)?,
            primary: monitor.is_primary().unwrap_or(false),
        };
        found.push((monitor, info));
    }
    number_displays(&mut found);
    Ok(found)
}

/// Every connected display, numbered, with the primary display flagged.
pub fn list() -> Result<Vec<DisplayInfo>, ScreenshotError> {
    Ok(entries()?.into_iter().map(|(_, info)| info).collect())
}

/// The monitor the agent works on. An empty `name` means the primary display,
/// the default. A named display that is no longer connected is an error, never a
/// silent switch to another screen.
pub fn select(name: &str) -> Result<Monitor, ScreenshotError> {
    let mut found = entries()?;
    if name.is_empty() {
        let index = found
            .iter()
            .position(|(_, info)| info.primary)
            .ok_or(ScreenshotError::NoScreens)?;
        return Ok(found.swap_remove(index).0);
    }
    let index = found
        .iter()
        .position(|(_, info)| info.name == name)
        .ok_or(ScreenshotError::DisplayNotConnected)?;
    Ok(found.swap_remove(index).0)
}

#[tauri::command]
pub fn list_displays() -> Result<Vec<DisplayInfo>, String> {
    list().map_err(|e| e.to_string())
}

/// Show each display's number on its own screen for a few seconds. The overlays
/// are click-through and never take focus, so they do not disturb the target
/// application.
#[tauri::command]
pub async fn identify_displays(app: tauri::AppHandle) -> Result<(), String> {
    let displays = list().map_err(|e| e.to_string())?;
    close_identify_windows(&app);
    let generation = IDENTIFY_GENERATION.fetch_add(1, Ordering::Relaxed);
    for display in &displays {
        let label = format!("{IDENTIFY_PREFIX}{generation}-{}", display.number);
        // The page reads these to draw the number; it uses no Tauri commands.
        let url = format!(
            "index.html?identify={}&primary={}&size={}x{}",
            display.number,
            u8::from(display.primary),
            display.width,
            display.height
        );
        let window = WebviewWindowBuilder::new(&app, label, WebviewUrl::App(url.into()))
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .focusable(false)
            .visible(false)
            .build()
            .map_err(|e| e.to_string())?;
        // Physical pixels, so each overlay covers its whole display at any scale.
        window
            .set_position(PhysicalPosition::new(display.x, display.y))
            .map_err(|e| e.to_string())?;
        window
            .set_size(PhysicalSize::new(display.width, display.height))
            .map_err(|e| e.to_string())?;
        window
            .set_ignore_cursor_events(true)
            .map_err(|e| e.to_string())?;
        window.show().map_err(|e| e.to_string())?;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(IDENTIFY_SECONDS)).await;
        close_identify_windows(&app);
    });
    Ok(())
}

fn close_identify_windows(app: &tauri::AppHandle) {
    for (label, window) in app.webview_windows() {
        if label.starts_with(IDENTIFY_PREFIX) {
            let _ = window.close();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn display(x: i32, y: i32) -> DisplayInfo {
        DisplayInfo {
            name: format!(r"\\.\DISPLAY{x}{y}"),
            friendly_name: String::new(),
            number: 0,
            x,
            y,
            width: 1920,
            height: 1080,
            primary: false,
        }
    }

    #[test]
    fn displays_are_numbered_left_to_right_then_top_to_bottom() {
        // Primary at the origin, one to its right, one stacked above it, and one
        // far to the left at negative x.
        let mut displays = vec![
            ("right", display(1920, 0)),
            ("above", display(0, -1080)),
            ("left", display(-2560, 0)),
            ("origin", display(0, 0)),
        ];
        number_displays(&mut displays);
        let order: Vec<(&str, u32)> = displays
            .iter()
            .map(|(label, info)| (*label, info.number))
            .collect();
        assert_eq!(
            order,
            vec![("left", 1), ("above", 2), ("origin", 3), ("right", 4)]
        );
    }

    #[test]
    #[ignore = "Requires an interactive Windows desktop; captures only, never sends input"]
    fn every_connected_display_is_found_and_captured() {
        let displays = list().unwrap();
        assert_eq!(displays.iter().filter(|d| d.primary).count(), 1);
        for display in &displays {
            let shot =
                crate::screenshot::capture_screen_with_metadata(Some(1280), &display.name).unwrap();
            assert_eq!(
                (
                    shot.geometry.x,
                    shot.geometry.y,
                    shot.geometry.width,
                    shot.geometry.height
                ),
                (display.x, display.y, display.width, display.height)
            );
        }
        let primary = list().unwrap().into_iter().find(|d| d.primary).unwrap();
        let shot = crate::screenshot::capture_screen_with_metadata(Some(1280), "").unwrap();
        assert_eq!((shot.geometry.x, shot.geometry.y), (primary.x, primary.y));
        assert!(matches!(
            select(r"\\.\DISPLAY99"),
            Err(ScreenshotError::DisplayNotConnected)
        ));
    }
}
