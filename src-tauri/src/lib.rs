mod actions;
mod api;
mod screenshot;
mod types;

use crate::types::{ActionResult, AgentResponse};
use serde::Serialize;

/// Screenshot result with metadata for the frontend
#[derive(Serialize)]
pub struct ScreenshotWithMetadata {
    pub base64_image: String,
    pub image_width: u32,
    pub image_height: u32,
    pub actual_screen_width: u32,
    pub actual_screen_height: u32,
}

/// Capture a screenshot and return it as base64
#[tauri::command]
async fn capture_screenshot() -> Result<String, String> {
    screenshot::capture_screen().map_err(|e| e.to_string())
}

/// Capture a screenshot with metadata (dimensions)
#[tauri::command]
async fn capture_screenshot_with_metadata() -> Result<ScreenshotWithMetadata, String> {
    let result = screenshot::capture_screen_with_metadata().map_err(|e| e.to_string())?;
    Ok(ScreenshotWithMetadata {
        base64_image: result.base64_image,
        image_width: result.image_width,
        image_height: result.image_height,
        actual_screen_width: result.actual_screen_width,
        actual_screen_height: result.actual_screen_height,
    })
}

/// Process a computer use query
#[tauri::command]
async fn process_computer_use(
    screenshot_base64: String,
    query: String,
    api_endpoint: String,
    model_id: String,
    display_width: u32,
    display_height: u32,
    max_tokens: u32,
    verbosity: String,
    screenshot_history: Option<Vec<String>>,
) -> Result<AgentResponse, String> {
    api::call_computer_use_api(
        &api_endpoint,
        &model_id,
        &screenshot_base64,
        &query,
        display_width,
        display_height,
        max_tokens,
        &verbosity,
        screenshot_history,
    )
    .await
    .map_err(|e| e.to_string())
}

/// Execute an action on the computer
#[tauri::command]
async fn execute_action(action: String) -> Result<(), String> {
    println!("execute_action called with: {}", action);
    
    let action_result: ActionResult =
        serde_json::from_str(&action).map_err(|e| format!("Failed to parse action: {}. Input was: {}", e, action))?;

    println!("Parsed action: {:?}", action_result);

    let (width, height) = screenshot::get_screen_dimensions().map_err(|e| e.to_string())?;
    println!("Screen dimensions: {}x{}", width, height);

    actions::execute_action(&action_result, width, height).map_err(|e| e.to_string())
}

/// Test API connection
#[tauri::command]
async fn test_api_connection(api_endpoint: String, model_id: String) -> Result<bool, String> {
    api::test_connection(&api_endpoint, &model_id)
        .await
        .map_err(|e| e.to_string())
}

/// Get screen dimensions
#[tauri::command]
async fn get_screen_size() -> Result<(u32, u32), String> {
    screenshot::get_screen_dimensions().map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            capture_screenshot,
            capture_screenshot_with_metadata,
            process_computer_use,
            execute_action,
            test_api_connection,
            get_screen_size,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
