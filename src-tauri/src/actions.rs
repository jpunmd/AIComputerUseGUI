use crate::types::ActionResult;
use enigo::{
    Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings,
};
use std::thread;
use std::time::Duration;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum ActionError {
    #[error("Failed to execute action: {0}")]
    ExecutionError(String),
    #[error("Invalid action: {0}")]
    InvalidAction(String),
    #[error("Missing required argument: {0}")]
    MissingArgument(String),
}

/// Execute an action on the computer
pub fn execute_action(action: &ActionResult, screen_width: u32, screen_height: u32) -> Result<(), ActionError> {
    println!("Executing action: {} with screen size {}x{}", action.action, screen_width, screen_height);
    
    let mut enigo = Enigo::new(&Settings::default())
        .map_err(|e| ActionError::ExecutionError(e.to_string()))?;
    
    match action.action.as_str() {
        "click" | "left_click" => {
            let coord = action.arguments.coordinate.as_ref()
                .ok_or_else(|| ActionError::MissingArgument("coordinate".to_string()))?;
            
            if coord.len() < 2 {
                return Err(ActionError::InvalidAction("coordinate must have x and y values".to_string()));
            }
            
            // Model outputs in 0-1000 range, scale to actual screen size
            let x = (coord[0] / 1000.0 * screen_width as f64) as i32;
            let y = (coord[1] / 1000.0 * screen_height as f64) as i32;
            
            println!("Click: model coords ({}, {}) -> screen coords ({}, {})", coord[0], coord[1], x, y);
            
            enigo.move_mouse(x, y, Coordinate::Abs)
                .map_err(|e| ActionError::ExecutionError(e.to_string()))?;
            thread::sleep(Duration::from_millis(100));
            enigo.button(Button::Left, Direction::Click)
                .map_err(|e| ActionError::ExecutionError(e.to_string()))?;
            
            println!("Click executed successfully");
        }
        
        "right_click" => {
            let coord = action.arguments.coordinate.as_ref()
                .ok_or_else(|| ActionError::MissingArgument("coordinate".to_string()))?;
            
            if coord.len() < 2 {
                return Err(ActionError::InvalidAction("coordinate must have x and y values".to_string()));
            }
            
            let x = (coord[0] / 1000.0 * screen_width as f64) as i32;
            let y = (coord[1] / 1000.0 * screen_height as f64) as i32;
            
            enigo.move_mouse(x, y, Coordinate::Abs)
                .map_err(|e| ActionError::ExecutionError(e.to_string()))?;
            thread::sleep(Duration::from_millis(50));
            enigo.button(Button::Right, Direction::Click)
                .map_err(|e| ActionError::ExecutionError(e.to_string()))?;
        }
        
        "double_click" => {
            let coord = action.arguments.coordinate.as_ref()
                .ok_or_else(|| ActionError::MissingArgument("coordinate".to_string()))?;
            
            if coord.len() < 2 {
                return Err(ActionError::InvalidAction("coordinate must have x and y values".to_string()));
            }
            
            let x = (coord[0] / 1000.0 * screen_width as f64) as i32;
            let y = (coord[1] / 1000.0 * screen_height as f64) as i32;
            
            enigo.move_mouse(x, y, Coordinate::Abs)
                .map_err(|e| ActionError::ExecutionError(e.to_string()))?;
            thread::sleep(Duration::from_millis(50));
            enigo.button(Button::Left, Direction::Click)
                .map_err(|e| ActionError::ExecutionError(e.to_string()))?;
            thread::sleep(Duration::from_millis(50));
            enigo.button(Button::Left, Direction::Click)
                .map_err(|e| ActionError::ExecutionError(e.to_string()))?;
        }
        
        "left_click_drag" => {
            let start = action.arguments.start_coordinate.as_ref()
                .ok_or_else(|| ActionError::MissingArgument("start_coordinate".to_string()))?;
            let end = action.arguments.end_coordinate.as_ref()
                .ok_or_else(|| ActionError::MissingArgument("end_coordinate".to_string()))?;
            
            if start.len() < 2 || end.len() < 2 {
                return Err(ActionError::InvalidAction("coordinates must have x and y values".to_string()));
            }
            
            let start_x = (start[0] / 1000.0 * screen_width as f64) as i32;
            let start_y = (start[1] / 1000.0 * screen_height as f64) as i32;
            let end_x = (end[0] / 1000.0 * screen_width as f64) as i32;
            let end_y = (end[1] / 1000.0 * screen_height as f64) as i32;
            
            // Move to start position
            enigo.move_mouse(start_x, start_y, Coordinate::Abs)
                .map_err(|e| ActionError::ExecutionError(e.to_string()))?;
            thread::sleep(Duration::from_millis(50));
            
            // Press button
            enigo.button(Button::Left, Direction::Press)
                .map_err(|e| ActionError::ExecutionError(e.to_string()))?;
            thread::sleep(Duration::from_millis(50));
            
            // Move to end position
            enigo.move_mouse(end_x, end_y, Coordinate::Abs)
                .map_err(|e| ActionError::ExecutionError(e.to_string()))?;
            thread::sleep(Duration::from_millis(50));
            
            // Release button
            enigo.button(Button::Left, Direction::Release)
                .map_err(|e| ActionError::ExecutionError(e.to_string()))?;
        }
        
        "scroll" => {
            let coord = action.arguments.coordinate.as_ref()
                .ok_or_else(|| ActionError::MissingArgument("coordinate".to_string()))?;
            let direction = action.arguments.direction.as_ref()
                .ok_or_else(|| ActionError::MissingArgument("direction".to_string()))?;
            
            if coord.len() < 2 {
                return Err(ActionError::InvalidAction("coordinate must have x and y values".to_string()));
            }
            
            let x = (coord[0] / 1000.0 * screen_width as f64) as i32;
            let y = (coord[1] / 1000.0 * screen_height as f64) as i32;
            let amount = action.arguments.amount.unwrap_or(3);
            
            enigo.move_mouse(x, y, Coordinate::Abs)
                .map_err(|e| ActionError::ExecutionError(e.to_string()))?;
            thread::sleep(Duration::from_millis(50));
            
            match direction.as_str() {
                "up" => {
                    enigo.scroll(amount, enigo::Axis::Vertical)
                        .map_err(|e| ActionError::ExecutionError(e.to_string()))?;
                }
                "down" => {
                    enigo.scroll(-amount, enigo::Axis::Vertical)
                        .map_err(|e| ActionError::ExecutionError(e.to_string()))?;
                }
                "left" => {
                    enigo.scroll(-amount, enigo::Axis::Horizontal)
                        .map_err(|e| ActionError::ExecutionError(e.to_string()))?;
                }
                "right" => {
                    enigo.scroll(amount, enigo::Axis::Horizontal)
                        .map_err(|e| ActionError::ExecutionError(e.to_string()))?;
                }
                _ => return Err(ActionError::InvalidAction(format!("Unknown scroll direction: {}", direction))),
            }
        }
        
        "type" => {
            let text = action.arguments.text.as_ref()
                .ok_or_else(|| ActionError::MissingArgument("text".to_string()))?;
            
            enigo.text(text)
                .map_err(|e| ActionError::ExecutionError(e.to_string()))?;
        }
        
        "key" => {
            let key_str = action.arguments.key.as_ref()
                .ok_or_else(|| ActionError::MissingArgument("key".to_string()))?;
            
            // Parse the key string (e.g., "ctrl+c", "enter", "backspace")
            execute_key_sequence(&mut enigo, key_str)?;
        }
        
        "wait" => {
            // Wait action - just pause execution
            thread::sleep(Duration::from_secs(1));
        }
        
        "screenshot" => {
            // Screenshot action - no-op here, handled separately
        }
        
        _ => {
            return Err(ActionError::InvalidAction(format!("Unknown action: {}", action.action)));
        }
    }
    
    Ok(())
}

/// Execute a key sequence (e.g., "ctrl+c", "enter")
fn execute_key_sequence(enigo: &mut Enigo, key_str: &str) -> Result<(), ActionError> {
    let parts: Vec<&str> = key_str.split('+').collect();
    
    if parts.len() == 1 {
        // Single key
        let key = parse_key(parts[0])?;
        enigo.key(key, Direction::Click)
            .map_err(|e| ActionError::ExecutionError(e.to_string()))?;
    } else {
        // Key combination (e.g., ctrl+c)
        let mut modifiers = Vec::new();
        let main_key = parts.last().ok_or_else(|| ActionError::InvalidAction("Empty key sequence".to_string()))?;
        
        // Press modifiers
        for part in &parts[..parts.len()-1] {
            let modifier = parse_key(part)?;
            modifiers.push(modifier);
            enigo.key(modifier, Direction::Press)
                .map_err(|e| ActionError::ExecutionError(e.to_string()))?;
        }
        
        // Press and release main key
        let key = parse_key(main_key)?;
        enigo.key(key, Direction::Click)
            .map_err(|e| ActionError::ExecutionError(e.to_string()))?;
        
        // Release modifiers in reverse order
        for modifier in modifiers.into_iter().rev() {
            enigo.key(modifier, Direction::Release)
                .map_err(|e| ActionError::ExecutionError(e.to_string()))?;
        }
    }
    
    Ok(())
}

/// Parse a key string to an enigo Key
fn parse_key(key_str: &str) -> Result<Key, ActionError> {
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
        s if s.len() == 1 => {
            Key::Unicode(s.chars().next().unwrap())
        }
        _ => return Err(ActionError::InvalidAction(format!("Unknown key: {}", key_str))),
    };
    
    Ok(key)
}
