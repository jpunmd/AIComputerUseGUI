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

/// Call the vision-language model API for computer use
pub async fn call_computer_use_api(
    api_endpoint: &str,
    model_id: &str,
    screenshot_base64: &str,
    query: &str,
    display_width: u32,
    display_height: u32,
    system_prompt: &str,
    screenshot_history: Option<Vec<String>>,
    enable_thinking: bool,
    prior_turns: Option<Vec<PriorTurn>>,
    coordinate_base: f64,
) -> Result<AgentResponse, ApiError> {
    #[cfg(debug_assertions)]
    {
        println!("=== API Call Debug ===");
        println!("Query length: {} chars", query.len());
        println!("Screenshot length: {} bytes", screenshot_base64.len());
        println!("Screen size: {}x{}", display_width, display_height);
        println!("Screenshot history count: {}", screenshot_history.as_ref().map(|h| h.len()).unwrap_or(0));
    }
    
    let client = Client::new();
    
    #[cfg(debug_assertions)]
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
    
    // Build conversation: system → (prior user/assistant turns) → current user.
    // Prior turns are text-only (no screenshots) to keep token cost down — the
    // current screenshot is the source of truth, prior thinking + actions give
    // continuity. When preserve_thinking is enabled, prior assistant content is
    // wrapped with <think>...</think> so the model's chat template re-includes
    // the reasoning instead of stripping it.
    let mut messages: Vec<ChatMessage> = Vec::new();
    messages.push(ChatMessage {
        role: "system".to_string(),
        content: vec![ContentPart::Text {
            text: system_prompt.to_string(),
        }],
    });

    if let Some(turns) = &prior_turns {
        for turn in turns {
            messages.push(ChatMessage {
                role: "user".to_string(),
                content: vec![ContentPart::Text {
                    text: turn.user_query.clone(),
                }],
            });

            let assistant_text = match (&turn.assistant_thinking, enable_thinking) {
                (Some(thinking), true) if !thinking.trim().is_empty() => {
                    format!("<think>\n{}\n</think>\n\n{}", thinking.trim(), turn.assistant_content)
                }
                _ => turn.assistant_content.clone(),
            };
            messages.push(ChatMessage {
                role: "assistant".to_string(),
                content: vec![ContentPart::Text {
                    text: assistant_text,
                }],
            });
        }
    }

    messages.push(ChatMessage {
        role: "user".to_string(),
        content: user_content,
    });

    // Build the chat request
    let request = ChatRequest {
        model: model_id.to_string(),
        messages,
        max_tokens: None, // Let the server decide max tokens
        chat_template_kwargs: if enable_thinking {
            Some(ChatTemplateKwargs {
                enable_thinking: Some(true),
                // Auto-enable preserve_thinking whenever thinking is on so prior
                // <think> blocks are kept in the rendered conversation.
                preserve_thinking: Some(true),
            })
        } else {
            None
        },
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
    let raw_output_text = chat_response
        .choices
        .first()
        .map(|c| c.message.content.clone())
        .unwrap_or_default();

    #[cfg(debug_assertions)]
    println!("API Response raw output_text ({} chars)", raw_output_text.len());

    // llama.cpp (and some other servers) leave <think>...</think> tags inline in
    // the content rather than splitting them into reasoning_content. Strip them
    // out so the tool_call parser doesn't choke and so we can surface the
    // reasoning separately.
    let (output_text, inline_thinking) = extract_think_tags(&raw_output_text);

    // Extract the action from the tool_call
    let action = parse_tool_call(&output_text)?;
    
    #[cfg(debug_assertions)]
    println!("Parsed action: {}", action.action);
    
    // Calculate absolute coordinates if present
    // The model outputs coordinates in a normalized space (coordinate_base), we
    // scale to actual screen size. display_width/height passed from frontend are
    // the actual screen dimensions.
    let coordinate_absolute = action.arguments.coordinate.as_ref().map(|coord| {
        if coord.len() >= 2 {
            // Model uses 0-coordinate_base space, scale to actual screen dimensions
            let abs_x = coord[0] / coordinate_base * display_width as f64;
            let abs_y = coord[1] / coordinate_base * display_height as f64;
            #[cfg(debug_assertions)]
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
    
    // Extract thinking/reasoning from the response.
    // Priority:
    //   1. reasoning_content field (vLLM, llama.cpp with reasoning_format=deepseek)
    //   2. inline <think>...</think> tags (llama.cpp with reasoning_format=none)
    //   3. text before <tool_call> as a last-resort fallback
    let reasoning_content = chat_response
        .choices
        .first()
        .and_then(|c| c.message.reasoning_content.clone())
        .filter(|s| !s.trim().is_empty());

    #[cfg(debug_assertions)]
    println!(
        "Thinking sources -> reasoning_content: {}, inline <think>: {}",
        chat_response
            .choices
            .first()
            .and_then(|c| c.message.reasoning_content.as_ref())
            .map(|s| format!("{} chars", s.len()))
            .unwrap_or_else(|| "none".to_string()),
        inline_thinking
            .as_ref()
            .map(|s| format!("{} chars", s.len()))
            .unwrap_or_else(|| "none".to_string()),
    );

    let thinking = reasoning_content.or(inline_thinking).or_else(|| {
        if let Some(tool_call_start) = output_text.find("<tool_call>") {
            let before_tool_call = output_text[..tool_call_start].trim();
            if !before_tool_call.is_empty() {
                Some(before_tool_call.to_string())
            } else {
                None
            }
        } else {
            None
        }
    });
    
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
    
    #[cfg(debug_assertions)]
    println!("AgentResponse: action={}, is_done={}", response.action.action, response.is_done);
    
    Ok(response)
}

/// Result of a zoom-refine (second) pass.
#[derive(Debug, Clone, serde::Serialize)]
pub struct RefineResult {
    /// Refined coordinate in normalized `coordinate_base` space over the FULL
    /// screen (i.e. after descale #1: crop-local -> full-screen normalized).
    pub coordinate: Vec<f64>,
    /// The raw pass-2 coordinate the model emitted, in normalized
    /// `coordinate_base` space over the CROP image. Empty when not refined.
    /// Used to draw the click marker on the zoom crop in the chat history.
    pub crop_coordinate: Vec<f64>,
    /// The raw bounding box [x0, y0, x1, y1] the model emitted in box mode,
    /// in normalized `coordinate_base` space over the CROP image. Empty unless
    /// box mode produced a 4-element box. Used to draw the box on the crop.
    pub crop_box: Vec<f64>,
    /// The zoomed crop image (base64 PNG) the refine pass looked at.
    pub crop_image: String,
    /// True if refinement produced a coordinate; false if it fell back to coarse.
    pub refined: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
}

/// Second pass of coarse-to-fine grounding. Crops a zoom window around the
/// coarse prediction (from the native screen), asks the model to click the
/// precise center within that magnified view, then maps the crop-local
/// coordinate back to full-screen normalized space.
#[allow(clippy::too_many_arguments)]
pub async fn refine_coordinate(
    api_endpoint: &str,
    model_id: &str,
    coarse_x: f64,
    coarse_y: f64,
    action_type: &str,
    query: &str,
    crop_frac: f64,
    max_dimension: u32,
    coordinate_base: f64,
    enable_thinking: bool,
    box_mode: bool,
) -> Result<RefineResult, ApiError> {
    // Coarse normalized coord -> center fraction for the crop window.
    let center_fx = coarse_x / coordinate_base;
    let center_fy = coarse_y / coordinate_base;

    let crop = crate::screenshot::capture_zoom_crop(center_fx, center_fy, crop_frac, max_dimension)
        .map_err(|e| ApiError::ApiResponseError(format!("zoom capture failed: {}", e)))?;

    let base_int = coordinate_base.round() as i64;
    // Two grounding formats to A/B: a direct click point, or a tight bounding box
    // (Gemma's native detection format) whose center we click. The box prompt
    // explicitly excludes text labels so the center lands on the glyph, not the
    // caption beneath an icon.
    let (system_prompt, focused_query) = if box_mode {
        (
            format!(
                "You are a precise visual grounding assistant viewing a ZOOMED-IN crop of a \
                 computer screen. A magenta crosshair reticle marks the APPROXIMATE location of \
                 the intended target (from a previous step). Draw the TIGHTEST bounding box \
                 around the single CLICKABLE element at or nearest the reticle — the icon glyph, \
                 button, or input field itself. Do NOT include the text label or caption beneath \
                 or beside an icon; box only the clickable graphic. Return the box as four \
                 normalized 0-{base} coordinates [x0, y0, x1, y1] (top-left, then bottom-right) \
                 over THIS image. ALWAYS respond with exactly one tool_call; never refuse, never \
                 return plain text. Respond ONLY with: <tool_call>{{\"name\": \"computer\", \
                 \"arguments\": {{\"action\": \"{action}\", \"coordinate\": [x0, y0, x1, y1]}}}}</tool_call>",
                action = action_type,
                base = base_int
            ),
            format!(
                "Goal: {goal}\n\nThe magenta reticle marks the approximate target. Return the \
                 TIGHT bounding box [x0, y0, x1, y1] around the clickable element itself (exclude \
                 any text label) as a single {action} tool_call.",
                goal = query,
                action = action_type
            ),
        )
    } else {
        (
            format!(
                "You are a precise click-localization assistant viewing a ZOOMED-IN crop of a \
                 computer screen. A magenta crosshair reticle has been drawn on the image to mark \
                 the APPROXIMATE location of the intended target (from a previous step). Identify \
                 the single UI element (icon, button, field, menu item, or text) at or nearest \
                 the reticle, and return the precise coordinate of THAT element's center. The \
                 reticle marks the target's vicinity, not necessarily its exact center — correct \
                 to the true center of the element. ALWAYS respond with exactly one tool_call \
                 containing a coordinate; never refuse, never return plain text, never claim the \
                 target is missing. Use normalized 0-{base} coordinates over THIS image \
                 ((0,0)=top-left, ({base},{base})=bottom-right). Respond ONLY with: \
                 <tool_call>{{\"name\": \"computer\", \"arguments\": {{\"action\": \"{action}\", \"coordinate\": [x, y]}}}}</tool_call>",
                action = action_type,
                base = base_int
            ),
            format!(
                "Goal: {goal}\n\nThe magenta reticle marks the approximate location of the target \
                 for that goal. Return the precise CENTER of the UI element at the reticle as a \
                 single {action} tool_call.",
                goal = query,
                action = action_type
            ),
        )
    };

    // Reuse the main call path on the crop image (no history, no prior turns).
    // The display dims are irrelevant here — we read the normalized coordinate,
    // not the absolute one — so pass the base for both.
    //
    // A pass-2 failure must NOT discard the crop we already captured: keep the
    // coarse coordinate but still return the crop image so the chat history can
    // show what the zoom pass looked at (and log why it fell back).
    let resp = match call_computer_use_api(
        api_endpoint,
        model_id,
        &crop.base64_image,
        &focused_query,
        base_int as u32,
        base_int as u32,
        &system_prompt,
        None,
        enable_thinking,
        None,
        coordinate_base,
    )
    .await
    {
        Ok(resp) => resp,
        Err(e) => {
            println!("Refine pass-2 inference failed ({}); keeping coarse, returning crop", e);
            return Ok(RefineResult {
                coordinate: vec![coarse_x, coarse_y],
                crop_coordinate: vec![],
                crop_box: vec![],
                crop_image: crop.base64_image,
                refined: false,
                thinking: None,
            });
        }
    };

    // Resolve the crop-local click point. In box mode the model returns
    // [x0, y0, x1, y1]; click its center. Otherwise it returns [x, y] directly.
    // Fall back to a 2-element point even in box mode if the model ignored the
    // box instruction.
    let local_point = resp.action.arguments.coordinate.as_ref().and_then(|coord| {
        if box_mode && coord.len() >= 4 {
            Some(((coord[0] + coord[2]) / 2.0, (coord[1] + coord[3]) / 2.0))
        } else if coord.len() >= 2 {
            Some((coord[0], coord[1]))
        } else {
            None
        }
    });

    // The raw box, kept for drawing on the crop in the chat history.
    let crop_box = resp
        .action
        .arguments
        .coordinate
        .as_ref()
        .filter(|_| box_mode)
        .filter(|c| c.len() >= 4)
        .map(|c| vec![c[0], c[1], c[2], c[3]])
        .unwrap_or_default();

    // Map the crop-local point back to full-screen normalized.
    if let Some((local_x, local_y)) = local_point {
        let local_fx = (local_x / coordinate_base).clamp(0.0, 1.0);
        let local_fy = (local_y / coordinate_base).clamp(0.0, 1.0);
        let full_fx = crop.origin_fx + local_fx * crop.frac_w;
        let full_fy = crop.origin_fy + local_fy * crop.frac_h;
        println!(
            "Refine ({}): crop-local ({:.1},{:.1}) -> full normalized ({:.1},{:.1}) [was coarse ({:.1},{:.1})]",
            if box_mode { "box" } else { "point" },
            local_x, local_y, full_fx * coordinate_base, full_fy * coordinate_base, coarse_x, coarse_y
        );
        return Ok(RefineResult {
            coordinate: vec![full_fx * coordinate_base, full_fy * coordinate_base],
            crop_coordinate: vec![local_x, local_y],
            crop_box,
            crop_image: crop.base64_image,
            refined: true,
            thinking: resp.thinking,
        });
    }

    // Refine produced no usable coordinate — keep the coarse prediction.
    Ok(RefineResult {
        coordinate: vec![coarse_x, coarse_y],
        crop_coordinate: vec![],
        crop_box: vec![],
        crop_image: crop.base64_image,
        refined: false,
        thinking: resp.thinking,
    })
}

/// Extract <think>...</think> blocks from the model output.
/// Returns (text_with_think_blocks_removed, joined_thinking_content).
/// Handles multiple think blocks and an unclosed final block (streaming-style).
fn extract_think_tags(text: &str) -> (String, Option<String>) {
    if !text.contains("<think>") {
        return (text.to_string(), None);
    }

    let mut cleaned = String::with_capacity(text.len());
    let mut thoughts: Vec<String> = Vec::new();
    let mut rest = text;

    while let Some(open_idx) = rest.find("<think>") {
        cleaned.push_str(&rest[..open_idx]);
        let after_open = &rest[open_idx + "<think>".len()..];
        if let Some(close_rel) = after_open.find("</think>") {
            let thought = after_open[..close_rel].trim();
            if !thought.is_empty() {
                thoughts.push(thought.to_string());
            }
            rest = &after_open[close_rel + "</think>".len()..];
        } else {
            // Unclosed <think> — treat the remainder as thinking content
            let thought = after_open.trim();
            if !thought.is_empty() {
                thoughts.push(thought.to_string());
            }
            rest = "";
            break;
        }
    }
    cleaned.push_str(rest);

    let thinking = if thoughts.is_empty() {
        None
    } else {
        Some(thoughts.join("\n\n"))
    };
    (cleaned.trim().to_string(), thinking)
}

/// Parse the tool_call from the model's response
/// The model returns: <tool_call>{"name": "computer", "arguments": {"action": "click", "coordinate": [x, y]}}</tool_call>
fn parse_tool_call(response: &str) -> Result<ActionResult, ApiError> {
    // Try to find <tool_call> tags first.
    // Use rfind for the opening tag so duplicated/nested <tool_call> openings
    // (the model sometimes echoes the example tag from the system prompt) don't
    // get included in the JSON slice.
    if let Some(start) = response.rfind("<tool_call>") {
        let after_open = start + "<tool_call>".len();
        let end = response[after_open..]
            .find("</tool_call>")
            .map(|e| after_open + e)
            .unwrap_or(response.len());
        let json_str = response[after_open..end]
            .trim()
            .trim_start_matches("<tool_call>")
            .trim_end_matches("</tool_call>")
            .trim();

        let tool_call: ToolCall = serde_json::from_str(json_str)
            .map_err(|e| ApiError::ParseError(format!("Failed to parse tool_call JSON: {}. JSON was: {}", e, json_str)))?;

        return Ok(ActionResult::from(tool_call));
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
    
    // No tool_call found - this is a conversational response, return "none" action
    // This allows the agent to respond to queries that don't require computer actions
    Ok(ActionResult {
        action: "none".to_string(),
        arguments: crate::types::ActionResultArguments {
            coordinate: None,
            text: Some(response.to_string()),
            key: None,
            start_coordinate: None,
            end_coordinate: None,
            direction: None,
            amount: None,
        },
    })
}

/// Test the API connection
pub async fn test_connection(api_endpoint: &str) -> Result<bool, ApiError> {
    let client = Client::new();
    
    let endpoint = format!("{}/models", api_endpoint.trim_end_matches('/'));
    let response = client
        .get(&endpoint)
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
