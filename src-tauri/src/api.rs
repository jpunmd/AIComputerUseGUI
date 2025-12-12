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

You are provided with function signatures within <tools></tools> XML tags:
<tools>
{"type": "function", "function": {"name": "computer", "description": "Use a mouse and keyboard to interact with a computer screen.", "parameters": {"properties": {"action": {"description": "The action to perform.", "enum": ["click", "left_click", "right_click", "double_click", "left_click_drag", "scroll", "type", "key", "wait", "screenshot", "done", "confirm"], "type": "string"}, "coordinate": {"description": "The x,y coordinate for click/scroll actions.", "items": {"type": "number"}, "type": "array"}, "text": {"description": "For 'type' action, or for 'confirm' action to describe what needs confirmation.", "type": "string"}, "key": {"description": "For 'key' action.", "type": "string"}, "start_coordinate": {"description": "For left_click_drag.", "items": {"type": "number"}, "type": "array"}, "end_coordinate": {"description": "For left_click_drag.", "items": {"type": "number"}, "type": "array"}, "direction": {"description": "For scroll: up/down/left/right.", "enum": ["up", "down", "left", "right"], "type": "string"}, "amount": {"description": "For scroll.", "type": "number"}}, "required": ["action"], "type": "object"}}}
</tools>

Actions: click, double_click (open items), right_click, type, key, scroll, done (task complete), confirm (ask user before risky action).

For each action, return JSON in <tool_call></tool_call> tags:
<tool_call>
{"name": "computer", "arguments": {"action": "...", ...}}
</tool_call>
"#;

/// Verbosity-specific instructions
fn get_verbosity_instructions(verbosity: &str) -> &'static str {
    match verbosity {
        "concise" => r#"
IMPORTANT: Be extremely concise. Output ONLY the tool_call with no explanation. When the task is complete, you MUST still output a tool_call with action "done"."#,
        "verbose" => r#"
Explain your reasoning before each action. You MUST always output a tool_call. When the task is complete, output a tool_call with action "done"."#,
        _ => r#"
Be brief. You MUST always output a tool_call. When the task is complete, output a tool_call with action "done"."#,
    }
}

/// Build the system prompt for computer use
fn build_system_prompt(verbosity: &str) -> String {
    let verbosity_instructions = get_verbosity_instructions(verbosity);
    format!(r#"You are a computer control assistant.{}

# Safety Guidelines - CRITICAL
- ONLY perform actions specifically requested by the user
- Be PRECISE: if asked to delete "folder X", delete ONLY folder X, not other items
- NEVER select multiple items unless explicitly asked (avoid Ctrl+A, Shift+Click on unrelated items)
- For destructive actions (delete, format, uninstall, close without saving), use "confirm" action first
- The "confirm" action pauses and asks the user for approval before proceeding
- When in doubt about scope, use "confirm" to clarify with the user
- Do not perform actions that affect files/folders/applications the user did not mention

# Multi-Turn Instructions
- You will receive a list of actions already completed and a screenshot of the CURRENT state
- The screenshot shows what happened AFTER all listed actions were executed
- TRUST the action history - if an action is listed as completed, it was done
- Do NOT repeat actions that are already in the history
- Analyze the screenshot to verify success, then decide the NEXT action
- If the goal appears complete in the screenshot, use "done"
- For scroll: always include direction ("up", "down", "left", "right")
{}"#, COMPUTER_USE_FUNCTION, verbosity_instructions)
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
    verbosity: &str,
) -> Result<AgentResponse, ApiError> {
    println!("=== API Call Debug ===");
    println!("Verbosity: {}", verbosity);
    println!("Query: {}", query);
    println!("Screenshot length: {} bytes", screenshot_base64.len());
    println!("Screen size: {}x{}", display_width, display_height);
    
    let client = Client::new();
    
    let system_prompt = build_system_prompt(verbosity);
    println!("System prompt: {}", system_prompt);
    
    // Build the chat request
    let request = ChatRequest {
        model: model_id.to_string(),
        messages: vec![
            ChatMessage {
                role: "system".to_string(),
                content: vec![ContentPart::Text {
                    text: system_prompt,
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
    
    // Final fallback: if the response indicates the task is complete, treat as "done"
    let response_lower = response.to_lowercase();
    if response_lower.contains("already open") 
        || response_lower.contains("task is complete") 
        || response_lower.contains("no further action")
        || response_lower.contains("goal is achieved")
        || response_lower.contains("successfully completed")
        || response_lower.contains("has been completed")
        || response_lower.contains("is now open")
    {
        return Ok(ActionResult {
            action: "done".to_string(),
            arguments: crate::types::ActionResultArguments {
                coordinate: None,
                text: None,
                key: None,
                start_coordinate: None,
                end_coordinate: None,
                direction: None,
                amount: None,
            },
        });
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
