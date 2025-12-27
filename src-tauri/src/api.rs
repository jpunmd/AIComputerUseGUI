use crate::types::*;
use reqwest::Client;
use serde::Deserialize;
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

/// Maximum number of recent screenshots to include for context
/// Set to 0 to disable screenshot history (recommended - multiple images can confuse the model)
const MAX_SCREENSHOT_HISTORY: usize = 0;

/// Call the Qwen3-VL API for computer use
pub async fn call_computer_use_api(
    api_endpoint: &str,
    model_id: &str,
    screenshot_base64: &str,
    query: &str,
    display_width: u32,
    display_height: u32,
    system_prompt: &str,
    screenshot_history: Option<Vec<String>>,
) -> Result<AgentResponse, ApiError> {
    println!("=== API Call Debug ===");
    println!("Query: {}", query);
    println!("Screenshot length: {} bytes", screenshot_base64.len());
    println!("Screen size: {}x{}", display_width, display_height);
    println!("Screenshot history count: {}", screenshot_history.as_ref().map(|h| h.len()).unwrap_or(0));
    
    let client = Client::new();
    
    println!("System prompt length: {} chars", system_prompt.len());
    
    // Build user content - only the current screenshot
    // Multiple images can confuse some models about which one to act on
    let mut user_content: Vec<ContentPart> = Vec::new();
    
    // Only add screenshot history if explicitly enabled (MAX_SCREENSHOT_HISTORY > 0)
    if MAX_SCREENSHOT_HISTORY > 0 {
        if let Some(history) = &screenshot_history {
            let start_idx = if history.len() > MAX_SCREENSHOT_HISTORY {
                history.len() - MAX_SCREENSHOT_HISTORY
            } else {
                0
            };
            
            for (i, old_screenshot) in history[start_idx..].iter().enumerate() {
                user_content.push(ContentPart::Text {
                    text: format!("[Previous state {}]", i + 1),
                });
                user_content.push(ContentPart::ImageUrl {
                    image_url: ImageUrl {
                        url: format!("data:image/png;base64,{}", old_screenshot),
                    },
                });
            }
            
            // Add clear separator before current screenshot
            if !history.is_empty() {
                user_content.push(ContentPart::Text {
                    text: "=== CURRENT STATE (perform actions on this image) ===".to_string(),
                });
            }
        }
    }
    
    // Add current screenshot - this is the only image if history is disabled
    user_content.push(ContentPart::ImageUrl {
        image_url: ImageUrl {
            url: format!("data:image/png;base64,{}", screenshot_base64),
        },
    });
    
    // Add the query text
    user_content.push(ContentPart::Text {
        text: query.to_string(),
    });
    
    // Build the chat request
    let request = ChatRequest {
        model: model_id.to_string(),
        messages: vec![
            ChatMessage {
                role: "system".to_string(),
                content: vec![ContentPart::Text {
                    text: system_prompt.to_string(),
                }],
            },
            ChatMessage {
                role: "user".to_string(),
                content: user_content,
            },
        ],
        max_tokens: None, // Let the server decide max tokens
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
    
    // Fallback: try to find "tool_call" followed by JSON (without XML tags)
    // Pattern: tool_call{"name": "computer", ...} or tool_call\n{"name": "computer", ...}
    if let Some(start) = response.find("tool_call") {
        let after_keyword = &response[start + 9..]; // Skip "tool_call"
        let trimmed = after_keyword.trim_start();
        if trimmed.starts_with('{') {
            // Find the matching closing brace
            if let Some(json_start) = trimmed.find('{') {
                let json_part = &trimmed[json_start..];
                // Try to find the end of the JSON object by matching braces
                let mut brace_count = 0;
                let mut json_end = 0;
                for (i, c) in json_part.chars().enumerate() {
                    match c {
                        '{' => brace_count += 1,
                        '}' => {
                            brace_count -= 1;
                            if brace_count == 0 {
                                json_end = i + 1;
                                break;
                            }
                        }
                        _ => {}
                    }
                }
                if json_end > 0 {
                    let json_str = &json_part[..json_end];
                    if let Ok(tool_call) = serde_json::from_str::<ToolCall>(json_str) {
                        return Ok(ActionResult::from(tool_call));
                    }
                }
            }
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

/// Response from the /models endpoint
#[derive(Debug, Deserialize)]
pub struct ModelsResponse {
    pub data: Vec<ModelInfo>,
}

#[derive(Debug, Deserialize)]
pub struct ModelInfo {
    pub id: String,
}

/// Fetch available models from the API endpoint
pub async fn fetch_models(api_endpoint: &str) -> Result<Vec<String>, ApiError> {
    let client = Client::new();
    
    let endpoint = format!("{}/models", api_endpoint.trim_end_matches('/'));
    let response = client
        .get(&endpoint)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await?;
    
    if !response.status().is_success() {
        let error_text = response.text().await.unwrap_or_default();
        return Err(ApiError::ApiResponseError(error_text));
    }
    
    let models_response: ModelsResponse = response
        .json()
        .await
        .map_err(|e| ApiError::ParseError(format!("Failed to parse models response: {}", e)))?;
    
    let model_ids: Vec<String> = models_response.data.into_iter().map(|m| m.id).collect();
    Ok(model_ids)
}
