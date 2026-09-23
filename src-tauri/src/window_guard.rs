//! Guards target identity and prevents the model interacting with its controller.
#[derive(Clone, Debug, PartialEq)]
pub struct WindowTarget {
    pub handle: usize,
    pub process: u32,
    pub rect: [i32; 4],
}

#[cfg(windows)]
mod platform {
    use super::WindowTarget;
    use windows_sys::Win32::{
        Foundation::{HWND, POINT, RECT},
        UI::WindowsAndMessaging::*,
    };
    fn inspect(window: HWND) -> Result<WindowTarget, String> {
        unsafe {
            let root = GetAncestor(window, GA_ROOT);
            if root.is_null() || IsWindow(root) == 0 {
                return Err("Target window no longer exists".into());
            }
            let mut process = 0;
            GetWindowThreadProcessId(root, &mut process);
            if process == 0 || process == std::process::id() {
                return Err("The agent cannot control its own window".into());
            }
            let mut rect: RECT = std::mem::zeroed();
            if GetWindowRect(root, &mut rect) == 0 {
                return Err("Cannot inspect target window".into());
            }
            Ok(WindowTarget {
                handle: root as usize,
                process,
                rect: [rect.left, rect.top, rect.right, rect.bottom],
            })
        }
    }
    pub fn foreground() -> Option<WindowTarget> {
        unsafe { inspect(GetForegroundWindow()).ok() }
    }
    pub fn snapshot() -> Vec<WindowTarget> {
        unsafe extern "system" fn collect(window: HWND, data: isize) -> i32 {
            if IsWindowVisible(window) != 0 {
                if let Ok(target) = inspect(window) {
                    let windows = &mut *(data as *mut Vec<WindowTarget>);
                    windows.push(target);
                }
            }
            1
        }
        let mut windows = Vec::new();
        unsafe {
            EnumWindows(
                Some(collect),
                &mut windows as *mut Vec<WindowTarget> as isize,
            );
        }
        windows
    }
    pub fn at_point(x: i32, y: i32) -> Result<WindowTarget, String> {
        unsafe { inspect(WindowFromPoint(POINT { x, y })) }
    }
    pub fn verify(target: &WindowTarget, focus: bool) -> Result<(), String> {
        unsafe {
            if inspect(target.handle as HWND)? != *target {
                return Err("Target window moved or changed; capture again".into());
            }
            if focus {
                // The approval UI can take focus. An unrelated external app taking it cannot.
                if let Some(current) = foreground() {
                    if current.handle != target.handle {
                        return Err("Another application took focus; capture again".into());
                    }
                }
                if SetForegroundWindow(target.handle as HWND) == 0
                    || GetForegroundWindow() != target.handle as HWND
                {
                    return Err("Cannot restore the approved target window".into());
                }
            }
            Ok(())
        }
    }
    pub fn emergency_pressed() -> bool {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
            GetAsyncKeyState, VK_CONTROL, VK_F12, VK_MENU,
        };
        unsafe {
            GetAsyncKeyState(VK_CONTROL as i32) < 0
                && GetAsyncKeyState(VK_MENU as i32) < 0
                && GetAsyncKeyState(VK_F12 as i32) < 0
        }
    }
}
#[cfg(not(windows))]
mod platform {
    use super::WindowTarget;
    pub fn foreground() -> Option<WindowTarget> {
        None
    }
    pub fn snapshot() -> Vec<WindowTarget> {
        Vec::new()
    }
    pub fn at_point(_: i32, _: i32) -> Result<WindowTarget, String> {
        Err("Protected computer control currently requires Windows".into())
    }
    pub fn verify(_: &WindowTarget, _: bool) -> Result<(), String> {
        Err("Protected computer control currently requires Windows".into())
    }
    pub fn emergency_pressed() -> bool {
        false
    }
}
pub use platform::*;

pub fn require_captured(windows: &[WindowTarget], target: &WindowTarget) -> Result<(), String> {
    if windows.contains(target) {
        Ok(())
    } else {
        Err("Target window changed since the screenshot; capture again".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn changed_or_new_targets_cannot_use_old_observations() {
        let target = WindowTarget {
            handle: 1,
            process: 2,
            rect: [0, 0, 100, 100],
        };
        let windows = vec![target.clone()];
        assert!(require_captured(&windows, &target).is_ok());
        assert!(require_captured(
            &windows,
            &WindowTarget {
                rect: [10, 0, 110, 100],
                ..target.clone()
            }
        )
        .is_err());
        assert!(require_captured(
            &windows,
            &WindowTarget {
                process: 3,
                ..target.clone()
            }
        )
        .is_err());
        assert!(require_captured(&[], &target).is_err());
    }
}
