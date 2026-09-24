mod actions;
mod api;
mod control_error;
mod protocol;
mod run_control;
mod screenshot;
mod types;
mod validation;
mod window_guard;

use crate::{
    control_error::ControlError,
    run_control::{Proposal, RunControl},
    types::{ActionResult, AgentResponse},
};
use serde::Serialize;
use std::sync::Arc;
use tauri::{Emitter, Manager, State};

type Control<'a> = State<'a, Arc<RunControl>>;

#[derive(Serialize)]
pub struct ScreenshotWithMetadata {
    pub base64_image: String,
    pub image_width: u32,
    pub image_height: u32,
    pub actual_screen_width: u32,
    pub actual_screen_height: u32,
    pub observation_id: String,
}

#[tauri::command]
fn start_run(supervised: bool, state: Control<'_>) -> Result<String, String> {
    state.begin(supervised)
}
#[tauri::command]
fn stop_run(run_id: String, state: Control<'_>) {
    state.stop(Some(&run_id));
}

#[tauri::command]
async fn capture_screenshot_with_metadata(
    run_id: String,
    max_dimension: Option<u32>,
    state: Control<'_>,
) -> Result<ScreenshotWithMetadata, String> {
    let token = state.token(&run_id)?;
    let foreground = window_guard::foreground();
    let windows = window_guard::snapshot();
    let result = tauri::async_runtime::spawn_blocking(move || {
        screenshot::capture_screen_with_metadata(max_dimension)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    if token.is_cancelled() {
        return Err("Run stopped".into());
    }
    let observation_id = state.observe(
        &run_id,
        result.geometry,
        result.native_image,
        foreground,
        windows,
    )?;
    Ok(ScreenshotWithMetadata {
        base64_image: result.base64_image,
        image_width: result.image_width,
        image_height: result.image_height,
        actual_screen_width: result.actual_screen_width,
        actual_screen_height: result.actual_screen_height,
        observation_id,
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn process_computer_use(
    run_id: String,
    screenshot_base64: String,
    query: String,
    api_endpoint: String,
    model_id: String,
    display_width: u32,
    display_height: u32,
    system_prompt: String,
    enable_thinking: Option<bool>,
    prior_turns: Option<Vec<types::PriorTurn>>,
    state: Control<'_>,
) -> Result<AgentResponse, String> {
    let token = state.token(&run_id)?;
    api::call_computer_use_api(
        &api_endpoint,
        &model_id,
        &screenshot_base64,
        &query,
        display_width,
        display_height,
        &system_prompt,
        enable_thinking.unwrap_or(false),
        prior_turns,
        1000.0,
        &token,
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn refine_coordinate(
    run_id: String,
    observation_id: String,
    api_endpoint: String,
    model_id: String,
    coarse_x: f64,
    coarse_y: f64,
    action_type: String,
    query: String,
    crop_fraction: Option<f64>,
    max_dimension: Option<u32>,
    enable_thinking: Option<bool>,
    box_mode: Option<bool>,
    state: Control<'_>,
) -> Result<api::RefineResult, String> {
    let token = state.token(&run_id)?;
    let observation = state.observation(&run_id, &observation_id)?;
    api::refine_coordinate(
        &observation.native_image,
        &api_endpoint,
        &model_id,
        coarse_x,
        coarse_y,
        &action_type,
        &query,
        crop_fraction.unwrap_or(0.3),
        max_dimension.unwrap_or(1280),
        1000.0,
        enable_thinking.unwrap_or(false),
        box_mode.unwrap_or(false),
        &token,
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn prepare_action(
    run_id: String,
    observation_id: String,
    action: String,
    state: Control<'_>,
) -> Result<Proposal, ControlError> {
    if action.len() > 32768 {
        return Err("Action payload is too large".into());
    }
    let action: ActionResult =
        serde_json::from_str(&action).map_err(|_| "Invalid action payload")?;
    if action.progress.is_some() {
        return Err("Task progress cannot be submitted to the input executor".into());
    }
    validation::validate(&action, 1000.0, false)?;
    actions::validate_keys(&action).map_err(|e| e.to_string())?;
    let observation = state.observation(&run_id, &observation_id)?;
    if screenshot::get_screen_geometry().map_err(|e| e.to_string())? != observation.geometry {
        return Err(ControlError::screen_changed(
            "Display changed; capture again",
        ));
    }
    let target = if let Some(p) = action
        .arguments
        .coordinate
        .as_ref()
        .or(action.arguments.start_coordinate.as_ref())
    {
        Some(window_guard::at_point(
            validation::pixel(
                p[0],
                1000.0,
                observation.geometry.width,
                observation.geometry.x,
            ),
            validation::pixel(
                p[1],
                1000.0,
                observation.geometry.height,
                observation.geometry.y,
            ),
        )?)
    } else if validation::is_mutating(&action) {
        Some(
            observation
                .foreground
                .clone()
                .ok_or("Click the target application before typing or pressing keys")?,
        )
    } else {
        None
    };
    if let Some(target) = &target {
        window_guard::require_captured(&observation.windows, target)?;
    }
    state
        .prepare(&run_id, action, observation, target)
        .map_err(Into::into)
}

#[tauri::command]
fn approve_action(
    run_id: String,
    proposal_id: String,
    allow_for_task: Option<bool>,
    state: Control<'_>,
) -> Result<(), String> {
    state.approve(&run_id, &proposal_id, allow_for_task.unwrap_or(false))
}

#[tauri::command]
async fn execute_action(
    run_id: String,
    proposal_id: String,
    state: Control<'_>,
) -> Result<(), ControlError> {
    let control = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _serial = control
            .execution
            .lock()
            .map_err(|_| "Input executor unavailable")?;
        let (proposal, token) = control.take(&run_id, &proposal_id)?;
        if screenshot::get_screen_geometry().map_err(|e| e.to_string())?
            != proposal.observation.geometry
        {
            return Err(ControlError::screen_changed(
                "Display changed; capture again",
            ));
        }
        actions::execute_action(
            &proposal.action,
            proposal.observation.geometry,
            proposal.target.as_ref(),
            &token,
        )
        .map_err(|e| match e {
            actions::ActionError::TargetChanged(error) => error.after_input_attempt(),
            other => ControlError::from(other.to_string()),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn test_api_connection(api_endpoint: String) -> Result<bool, String> {
    api::test_connection(&api_endpoint)
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
async fn fetch_available_models(api_endpoint: String) -> Result<Vec<String>, String> {
    api::fetch_models(&api_endpoint)
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn get_screen_size() -> Result<(u32, u32), String> {
    screenshot::get_screen_dimensions().map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Arc::new(RunControl::default()))
        .setup(|app| {
            let handle = app.handle().clone();
            let control = app.state::<Arc<RunControl>>().inner().clone();
            std::thread::spawn(move || {
                let mut pressed = false;
                loop {
                    let now = window_guard::emergency_pressed();
                    if now && !pressed {
                        control.stop(None);
                        let _ = handle.emit("agent-stopped", ());
                    }
                    pressed = now;
                    std::thread::sleep(std::time::Duration::from_millis(30));
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_run,
            stop_run,
            capture_screenshot_with_metadata,
            process_computer_use,
            refine_coordinate,
            prepare_action,
            approve_action,
            execute_action,
            test_api_connection,
            fetch_available_models,
            get_screen_size
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
