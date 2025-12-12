use crate::types::*;
use reqwest::Client;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum ApiError {
    #[error("HTTP request failed: {0}")]
    RequestError(#[from] reqwest::Error),
    #[error("Failed to parse response: {0}")]
    ParseError(String),
    #[error("API returned an error: {0}")]
    ApiResponseError(String),
}

/// The computer use function definition for the system prompt
const COMPUTER_USE_FUNCTION: &str = r#"

# Tools

You may call one or more functions to assist with the user query.

You are provided with function signatures within <tools></tools> XML tags:
<tools>
{"type": "function", "function": {"name": "computer", "description": "Use a mouse and keyboard to interact with a computer screen.\n\nThis is an interface to a desktop GUI. You do not have the ability\nto access a terminal or applications in a command line interface.\n\nHere are the actions available:\n1. click: Click the left mouse button at the specified coordinate.\n2. left_click: Same as click.\n3. right_click: Click the right mouse button at the specified coordinate.\n4. double_click: Double-click the left mouse button at the specified coordinate. Use this to open files, folders, or applications.\n5. left_click_drag: Click and drag from a starting coordinate to an ending coordinate.\n6. scroll: Scroll in a direction ('up', 'down', 'left', 'right') at the specified coordinate.\n7. type: Type the specified text at the current cursor position.\n8. key: Press a keyboard key (e.g., 'enter', 'backspace', 'ctrl+c').\n9. wait: Wait for a specified number of seconds.\n10. screenshot: Take a screenshot of the current screen.\n11. done: Signal that the task has been completed successfully.", "parameters": {"properties": {"action": {"description": "The action to perform.", "enum": ["click", "left_click", "right_click", "double_click", "left_click_drag", "scroll", "type", "key", "wait", "screenshot", "done"], "type": "string"}, "coordinate": {"description": "The x,y coordinate to click at. Required for click, right_click, double_click, scroll actions.", "items": {"type": "number"}, "type": "array"}, "text": {"description": "Required for 'type' action. The text to type.", "type": "string"}, "key": {"description": "Required for 'key' action. The key to press.", "type": "string"}, "start_coordinate": {"description": "For left_click_drag, the starting coordinate.", "items": {"type": "number"}, "type": "array"}, "end_coordinate": {"description": "For left_click_drag, the ending coordinate.", "items": {"type": "number"}, "type": "array"}, "direction": {"description": "For scroll action, the direction to scroll.", "enum": ["up", "down", "left", "right"], "type": "string"}, "amount": {"description": "For scroll action, the amount to scroll.", "type": "number"}, "duration": {"description": "For wait action, the time in seconds to wait.", "type": "number"}}, "required": ["action"], "type": "object"}}}
</tools>

# Multi-Turn Task Instructions

You are helping the user accomplish a goal that may require multiple actions. After each action you take, you will receive a new screenshot showing the result. Continue taking actions until the goal is fully achieved, then use the "done" action to signal completion.

Guidelines:
- Analyze the screenshot carefully before each action
- Take ONE action at a time - you will see the result before the next action
- Use double_click to open files, folders, or applications
- Use single click to select items or press buttons
- When the task is complete, use action "done" to finish
- If you encounter an error or cannot proceed, explain the issue

For each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:
<tool_call>
{"name": <function-name>, "arguments": <args-json-object>}
</tool_call>
"#;

/// Build the system prompt for computer use
fn build_system_prompt() -> String {
    format!("You are a helpful assistant.{}", COMPUTER_USE_FUNCTION)
}

/// Call the Qwen3-VL API for computer use
pub async fn call_computer_use_api(
    api_endpoint: &str,
    model_id: &str,
    screenshot_base64: &str,
    query: &str,
    display_width: u32,
    display_height: u32,
    max_tokens: u32,
) -> Result<AgentResponse, ApiError> {
    let client = Client::new();
    
    // Build the chat request
    let request = ChatRequest {
        model: model_id.to_string(),
        messages: vec![
            ChatMessage {
                role: "system".to_string(),
                content: vec![ContentPart::Text {
                    text: build_system_prompt(),
                }],
            },
            ChatMessage {
                role: "user".to_string(),
                content: vec![
                    ContentPart::ImageUrl {
                        image_url: ImageUrl {
                            url: format!("data:image/png;base64,{}", screenshot_base64),
                        },
                    },
                    ContentPart::Text {
                        text: query.to_string(),
                    },
                ],
            },
        ],
        max_tokens: Some(max_tokens),
    };
    
    // Make the API request
    let endpoint = format!("{}/chat/completions", api_endpoint.trim_end_matches('/'));
    let response = client
        .post(&endpoint)
        .json(&request)
        .send()
        .await?;
    
    if !response.status().is_success() {
        let error_text = response.text().await.unwrap_or_default();
        return Err(ApiError::ApiResponseError(error_text));
    }
    
    let chat_response: ChatResponse = response.json().await?;
    
    // Parse the response
    let output_text = chat_response
        .choices
        .first()
        .map(|c| c.message.content.clone())
        .unwrap_or_default();
    
    println!("API Response output_text: {}", output_text);
    
    // Extract the action from the tool_call
    let action = parse_tool_call(&output_text)?;
    
    println!("Parsed action: {:?}", action);
    
    // Calculate absolute coordinates if present
    // The model outputs coordinates in 0-1000 range, we need to scale to actual screen size
    // display_width/height passed from frontend are the actual screen dimensions
    let coordinate_absolute = action.arguments.coordinate.as_ref().map(|coord| {
        if coord.len() >= 2 {
            // Model uses 0-1000 coordinate space, scale to actual screen dimensions
            let abs_x = coord[0] / 1000.0 * display_width as f64;
            let abs_y = coord[1] / 1000.0 * display_height as f64;
            println!("Coordinate conversion: model ({}, {}) -> screen ({}, {}) [screen size: {}x{}]", 
                coord[0], coord[1], abs_x, abs_y, display_width, display_height);
            Coordinate {
                x: abs_x,
                y: abs_y,
            }
        } else {
            Coordinate { x: 0.0, y: 0.0 }
        }
    });
    
    // Extract thinking/reasoning from the response (text before the tool_call)
    let thinking = if let Some(tool_call_start) = output_text.find("<tool_call>") {
        let before_tool_call = output_text[..tool_call_start].trim();
        if !before_tool_call.is_empty() {
            Some(before_tool_call.to_string())
        } else {
            None
        }
    } else {
        None
    };
    
    // Check if the action is "done" to signal task completion
    let is_done = action.action == "done";
    
    let response = AgentResponse {
        output_text,
        action,
        coordinate_absolute,
        success: true,
        error: None,
        is_done,
        thinking,
    };
    
    println!("AgentResponse JSON: {}", serde_json::to_string(&response).unwrap_or_default());
    
    Ok(response)
}

/// Parse the tool_call from the model's response
/// The model returns: <tool_call>{"name": "computer", "arguments": {"action": "click", "coordinate": [x, y]}}</tool_call>
fn parse_tool_call(response: &str) -> Result<ActionResult, ApiError> {
    // Try to find <tool_call> tags first
    if let Some(start) = response.find("<tool_call>") {
        if let Some(end) = response.find("</tool_call>") {
            let json_str = response[start + 11..end].trim();
            
            // Parse as ToolCall first (the model's format)
            let tool_call: ToolCall = serde_json::from_str(json_str)
                .map_err(|e| ApiError::ParseError(format!("Failed to parse tool_call JSON: {}. JSON was: {}", e, json_str)))?;
            
            // Convert to ActionResult
            return Ok(ActionResult::from(tool_call));
        }
    }
    
    // Fallback: try to parse the entire response as ToolCall
    if let Ok(tool_call) = serde_json::from_str::<ToolCall>(response) {
        return Ok(ActionResult::from(tool_call));
    }
    
    // Another fallback: try to parse as ActionResult directly
    if let Ok(action) = serde_json::from_str::<ActionResult>(response) {
        return Ok(action);
    }
    
    Err(ApiError::ParseError(
        format!("Could not find or parse tool_call in response: {}", response),
    ))
}

/// Test the API connection
pub async fn test_connection(api_endpoint: &str, model_id: &str) -> Result<bool, ApiError> {
    let client = Client::new();
    
    let request = ChatRequest {
        model: model_id.to_string(),
        messages: vec![ChatMessage {
            role: "user".to_string(),
            content: vec![ContentPart::Text {
                text: "Hello".to_string(),
            }],
        }],
        max_tokens: Some(10),
    };
    
    let endpoint = format!("{}/chat/completions", api_endpoint.trim_end_matches('/'));
    let response = client
        .post(&endpoint)
        .json(&request)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await?;
    
    Ok(response.status().is_success())
}
