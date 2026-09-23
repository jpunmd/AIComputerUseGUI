use crate::{
    screenshot::ScreenGeometry,
    types::ActionResult,
    validation,
    window_guard::{self, WindowTarget},
};
use enigo::{Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use std::{thread, time::Duration};
use thiserror::Error;
use tokio_util::sync::CancellationToken;

#[derive(Error, Debug)]
pub enum ActionError {
    #[error("Failed to execute action: {0}")]
    ExecutionError(String),
    #[error("Invalid action: {0}")]
    InvalidAction(String),
    #[error("Run stopped")]
    Cancelled,
}

fn check(cancel: &CancellationToken) -> Result<(), ActionError> {
    if cancel.is_cancelled() || window_guard::emergency_pressed() {
        cancel.cancel();
        return Err(ActionError::Cancelled);
    }
    Ok(())
}

fn wait(ms: u64, cancel: &CancellationToken) -> Result<(), ActionError> {
    for _ in 0..ms.div_ceil(20) {
        check(cancel)?;
        thread::sleep(Duration::from_millis(20));
    }
    check(cancel)
}

pub fn validate_keys(action: &ActionResult) -> Result<(), ActionError> {
    if let Some(keys) = &action.arguments.key {
        let parts: Vec<_> = keys.split('+').collect();
        for (i, part) in parts.iter().enumerate() {
            parse_key(part)?;
            if i + 1 < parts.len()
                && !matches!(
                    part.trim().to_lowercase().as_str(),
                    "ctrl" | "control" | "alt" | "shift" | "meta" | "win" | "cmd" | "command"
                )
            {
                return Err(ActionError::InvalidAction(
                    "Only modifiers may precede the final key".into(),
                ));
            }
        }
    }
    Ok(())
}

pub fn execute_action(
    action: &ActionResult,
    screen: ScreenGeometry,
    target: Option<&WindowTarget>,
    cancel: &CancellationToken,
) -> Result<(), ActionError> {
    validation::validate(action, 1000.0, false).map_err(ActionError::InvalidAction)?;
    validate_keys(action)?;
    check(cancel)?;
    if action.action == "wait" {
        return wait(1000, cancel);
    }
    if !validation::is_mutating(action) {
        return Ok(());
    }
    let target = target.ok_or_else(|| {
        ActionError::InvalidAction(
            "No external target window; click the target application first".into(),
        )
    })?;
    let guard = |focus| window_guard::verify(target, focus).map_err(ActionError::InvalidAction);
    guard(matches!(action.action.as_str(), "type" | "key"))?;
    let point = |p: &[f64]| {
        (
            validation::pixel(p[0], 1000.0, screen.width, screen.x),
            validation::pixel(p[1], 1000.0, screen.height, screen.y),
        )
    };
    let at_point = |x, y| -> Result<(), ActionError> {
        let current = window_guard::at_point(x, y).map_err(ActionError::InvalidAction)?;
        if &current != target {
            return Err(ActionError::InvalidAction(
                "Click target changed; capture again".into(),
            ));
        }
        Ok(())
    };
    let mut enigo =
        Enigo::new(&Settings::default()).map_err(|e| ActionError::ExecutionError(e.to_string()))?;
    let input_err = |e: enigo::InputError| ActionError::ExecutionError(e.to_string());
    match action.action.as_str() {
        "click" | "left_click" | "right_click" | "double_click" => {
            let (x, y) = point(
                action
                    .arguments
                    .coordinate
                    .as_deref()
                    .ok_or_else(|| ActionError::InvalidAction("Missing coordinate".into()))?,
            );
            at_point(x, y)?;
            enigo.move_mouse(x, y, Coordinate::Abs).map_err(input_err)?;
            wait(80, cancel)?;
            at_point(x, y)?;
            let button = if action.action == "right_click" {
                Button::Right
            } else {
                Button::Left
            };
            enigo.button(button, Direction::Click).map_err(input_err)?;
            if action.action == "double_click" {
                wait(60, cancel)?;
                at_point(x, y)?;
                enigo.button(button, Direction::Click).map_err(input_err)?;
            }
        }
        "left_click_drag" => {
            let (sx, sy) = point(
                action
                    .arguments
                    .start_coordinate
                    .as_deref()
                    .ok_or_else(|| ActionError::InvalidAction("Missing drag start".into()))?,
            );
            let (ex, ey) = point(
                action
                    .arguments
                    .end_coordinate
                    .as_deref()
                    .ok_or_else(|| ActionError::InvalidAction("Missing drag end".into()))?,
            );
            at_point(sx, sy)?;
            window_guard::at_point(ex, ey).map_err(ActionError::InvalidAction)?;
            enigo
                .move_mouse(sx, sy, Coordinate::Abs)
                .map_err(input_err)?;
            wait(50, cancel)?;
            at_point(sx, sy)?;
            enigo
                .button(Button::Left, Direction::Press)
                .map_err(input_err)?;
            let result = (|| {
                wait(50, cancel)?;
                window_guard::at_point(ex, ey).map_err(ActionError::InvalidAction)?;
                enigo
                    .move_mouse(ex, ey, Coordinate::Abs)
                    .map_err(input_err)?;
                wait(50, cancel)
            })();
            let release = enigo
                .button(Button::Left, Direction::Release)
                .map_err(input_err);
            result?;
            release?;
        }
        "scroll" => {
            let p = action.arguments.coordinate.as_deref().ok_or_else(|| {
                ActionError::InvalidAction("Scroll requires a target coordinate".into())
            })?;
            let (x, y) = point(p);
            at_point(x, y)?;
            enigo.move_mouse(x, y, Coordinate::Abs).map_err(input_err)?;
            wait(80, cancel)?;
            at_point(x, y)?;
            let amount = action.arguments.amount.unwrap_or(5);
            let (n, axis) = match action.arguments.direction.as_deref() {
                Some("up") => (-amount, enigo::Axis::Vertical),
                Some("down") => (amount, enigo::Axis::Vertical),
                Some("left") => (-amount, enigo::Axis::Horizontal),
                _ => (amount, enigo::Axis::Horizontal),
            };
            enigo.scroll(n, axis).map_err(input_err)?;
        }
        "type" => {
            let chars: Vec<_> = action
                .arguments
                .text
                .as_deref()
                .unwrap_or_default()
                .chars()
                .collect();
            for chunk in chars.chunks(64) {
                check(cancel)?;
                guard(true)?;
                enigo
                    .text(&chunk.iter().collect::<String>())
                    .map_err(input_err)?;
            }
        }
        "key" => {
            let mut keys = action
                .arguments
                .key
                .as_deref()
                .unwrap_or_default()
                .split('+')
                .map(parse_key)
                .collect::<Result<Vec<_>, _>>()?;
            let main = keys
                .pop()
                .ok_or_else(|| ActionError::InvalidAction("Missing key".into()))?;
            let mut held = Vec::new();
            let result = (|| {
                for key in keys {
                    check(cancel)?;
                    guard(true)?;
                    enigo.key(key, Direction::Press).map_err(input_err)?;
                    held.push(key);
                }
                check(cancel)?;
                guard(true)?;
                enigo.key(main, Direction::Click).map_err(input_err)
            })();
            let mut release_error = None;
            for key in held.into_iter().rev() {
                if let Err(e) = enigo.key(key, Direction::Release) {
                    release_error = Some(input_err(e));
                }
            }
            result?;
            if let Some(err) = release_error {
                return Err(err);
            }
        }
        _ => return Err(ActionError::InvalidAction("Unsupported action".into())),
    }
    Ok(())
}

/// Parse a key string to an enigo Key
fn parse_key(key_str: &str) -> Result<Key, ActionError> {
    // Strip surrounding quotes that the model may include (e.g. "enter" -> enter)
    let key_str = key_str.trim().trim_matches('"').trim_matches('\'');
    let key = match key_str.to_lowercase().as_str() {
        "enter" | "return" => Key::Return,
        "tab" => Key::Tab,
        "space" => Key::Space,
        "backspace" => Key::Backspace,
        "delete" | "del" => Key::Delete,
        "escape" | "esc" => Key::Escape,
        "up" => Key::UpArrow,
        "down" => Key::DownArrow,
        "left" => Key::LeftArrow,
        "right" => Key::RightArrow,
        "home" => Key::Home,
        "end" => Key::End,
        "pageup" => Key::PageUp,
        "pagedown" => Key::PageDown,
        "ctrl" | "control" => Key::Control,
        "alt" => Key::Alt,
        "shift" => Key::Shift,
        "meta" | "win" | "cmd" | "command" => Key::Meta,
        "capslock" => Key::CapsLock,
        #[cfg(any(target_os = "windows", all(unix, not(target_os = "macos"))))]
        "insert" | "ins" => Key::Insert,
        #[cfg(any(target_os = "windows", all(unix, not(target_os = "macos"))))]
        "numlock" => Key::Numlock,
        #[cfg(any(target_os = "windows", all(unix, not(target_os = "macos"))))]
        "pause" | "break" => Key::Pause,
        #[cfg(any(target_os = "windows", all(unix, not(target_os = "macos"))))]
        "printscreen" | "prtsc" | "prtscn" | "print_screen" => Key::PrintScr,
        #[cfg(target_os = "windows")]
        "menu" | "apps" | "contextmenu" => Key::Apps,
        "f1" => Key::F1,
        "f2" => Key::F2,
        "f3" => Key::F3,
        "f4" => Key::F4,
        "f5" => Key::F5,
        "f6" => Key::F6,
        "f7" => Key::F7,
        "f8" => Key::F8,
        "f9" => Key::F9,
        "f10" => Key::F10,
        "f11" => Key::F11,
        "f12" => Key::F12,
        s if s.chars().count() == 1 => Key::Unicode(s.chars().next().unwrap()),
        _ => {
            return Err(ActionError::InvalidAction(format!(
                "Unknown key: {}",
                key_str
            )))
        }
    };

    Ok(key)
}
