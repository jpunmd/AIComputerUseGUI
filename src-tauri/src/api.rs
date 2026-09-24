use crate::types::*;
use reqwest::Client;
use serde::Deserialize;
use thiserror::Error;
use tokio_util::sync::CancellationToken;

const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

fn endpoint(base: &str, path: &str) -> Result<reqwest::Url, ApiError> {
    let mut url = reqwest::Url::parse(base)
        .map_err(|_| ApiError::ApiResponseError("Invalid API endpoint".into()))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(ApiError::ApiResponseError(
            "Use an HTTP(S) API base URL without credentials, query, or fragment".into(),
        ));
    }
    url.set_path(&format!("{}/{}", url.path().trim_end_matches('/'), path));
    Ok(url)
}

async fn decode_response<T: serde::de::DeserializeOwned>(
    mut response: reqwest::Response,
) -> Result<T, ApiError> {
    let status = response.status();
    if response
        .content_length()
        .is_some_and(|n| n > MAX_RESPONSE_BYTES as u64)
    {
        return Err(ApiError::ApiResponseError(
            "Response exceeds 2 MB limit".into(),
        ));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(ApiError::ApiResponseError(
                "Response exceeds 2 MB limit".into(),
            ));
        }
        body.extend_from_slice(&chunk);
    }
    if !status.is_success() {
        return Err(ApiError::ApiResponseError(format!(
            "HTTP {}: {}",
            status.as_u16(),
            String::from_utf8_lossy(&body[..body.len().min(2048)])
        )));
    }
    serde_json::from_slice(&body).map_err(|e| ApiError::ParseError(e.to_string()))
}

#[derive(Error, Debug)]
pub enum ApiError {
    #[error("HTTP request failed: {0}")]
    RequestError(#[from] reqwest::Error),
    #[error("Failed to parse response: {0}")]
    ParseError(String),
    #[error("API returned an error: {0}")]
    ApiResponseError(String),
    #[error("inference cancelled")]
    Cancelled,
}

/// Call the vision-language model API for computer use
#[allow(clippy::too_many_arguments)]
pub async fn call_computer_use_api(
    api_endpoint: &str,
    model_id: &str,
    screenshot_base64: &str,
    query: &str,
    display_width: u32,
    display_height: u32,
    system_prompt: &str,
    enable_thinking: bool,
    prior_turns: Option<Vec<PriorTurn>>,
    coordinate_base: f64,
    cancel: &CancellationToken,
) -> Result<AgentResponse, ApiError> {
    if cancel.is_cancelled() {
        return Err(ApiError::Cancelled);
    }
    if screenshot_base64.len() > 32 * 1024 * 1024
        || query.len() > 131072
        || system_prompt.len() > 65536
        || model_id.len() > 1024
    {
        return Err(ApiError::ApiResponseError(
            "Request exceeds the context or image size limit".into(),
        ));
    }
    if prior_turns.as_ref().is_some_and(|turns| {
        turns.len() > 6
            || turns
                .iter()
                .map(|t| t.user_query.len() + t.assistant_content.len())
                .sum::<usize>()
                > 96000
    }) {
        return Err(ApiError::ApiResponseError(
            "Conversation context exceeds the six-turn / 24K-character budget".into(),
        ));
    }
    #[cfg(debug_assertions)]
    {
        println!("=== API Call Debug ===");
        println!("Query length: {} chars", query.len());
        println!("Screenshot length: {} bytes", screenshot_base64.len());
        println!("Screen size: {}x{}", display_width, display_height);
    }

    // Connect timeout catches an unreachable server quickly; the overall
    // timeout is generous because local VLM inference on large images can
    // legitimately take minutes. Stop still cancels mid-request either way.
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(600))
        .build()?;

    #[cfg(debug_assertions)]
    println!("System prompt length: {} chars", system_prompt.len());

    // Build user content - only the current screenshot
    // Multiple images can confuse some models about which one to act on
    let mut user_content: Vec<ContentPart> = Vec::new();

    // Only the current screenshot is sent; old screens are not actionable evidence.
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
    // current screenshot is the source of truth. Reasoning is display-only;
    // only final answers/actions are replayed into model context.
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

            messages.push(ChatMessage {
                role: "assistant".to_string(),
                content: vec![ContentPart::Text {
                    text: turn.assistant_content.clone(),
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
        max_tokens: Some(4096),
        chat_template_kwargs: Some(ChatTemplateKwargs {
            enable_thinking: Some(enable_thinking),
            preserve_thinking: Some(enable_thinking),
        }),
    };

    // Make the API request. Racing against the cancel signal lets a Stop press
    // drop the request mid-generation instead of waiting out the inference.
    let endpoint = endpoint(api_endpoint, "chat/completions")?;
    let request_future = async {
        let response = client.post(endpoint).json(&request).send().await?;

        decode_response::<ChatResponse>(response).await
    };
    let chat_response: ChatResponse = tokio::select! {
        result = request_future => result?,
        _ = cancel.cancelled() => return Err(ApiError::Cancelled),
    };

    // Parse the response
    let raw_output_text = chat_response
        .choices
        .first()
        .and_then(|c| c.message.content.clone())
        .unwrap_or_default();

    #[cfg(debug_assertions)]
    println!(
        "API Response raw output_text ({} chars)",
        raw_output_text.len()
    );

    // llama.cpp (and some other servers) leave <think>...</think> tags inline in
    // the content rather than splitting them into reasoning_content. Strip them
    // out so the tool_call parser doesn't choke and so we can surface the
    // reasoning separately.
    let (output_text, inline_thinking) = extract_think_tags(&raw_output_text);

    // Extract reasoning for display only, never for action execution.
    let reasoning_content = chat_response
        .choices
        .first()
        .and_then(|c| c.message.reasoning_content.clone())
        .filter(|s| !s.trim().is_empty());

    let choice = chat_response
        .choices
        .first()
        .ok_or_else(|| ApiError::ParseError("Empty model response".into()))?;
    let action = match parse_and_validate(choice, &output_text, coordinate_base) {
        Ok(action) => action,
        Err(error) => return Ok(rejected_response(choice, &output_text, error)),
    };

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
            println!(
                "Coordinate conversion: model ({}, {}) -> screen ({}, {}) [screen size: {}x{}]",
                coord[0], coord[1], abs_x, abs_y, display_width, display_height
            );
            Coordinate { x: abs_x, y: abs_y }
        } else {
            Coordinate { x: 0.0, y: 0.0 }
        }
    });

    // Thinking priority for display:
    //   1. reasoning_content field (vLLM, llama.cpp with reasoning_format=deepseek)
    //   2. inline <think>...</think> tags (llama.cpp with reasoning_format=none)
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
    println!(
        "AgentResponse: action={}, is_done={}",
        response.action.action, response.is_done
    );

    Ok(response)
}

fn parse_and_validate(
    choice: &ChatChoice,
    output_text: &str,
    coordinate_base: f64,
) -> Result<ActionResult, String> {
    let action = crate::protocol::parse_response(choice, output_text)?;
    crate::validation::validate(&action, coordinate_base, true)?;
    Ok(action)
}

fn rejected_response(choice: &ChatChoice, output_text: &str, error: String) -> AgentResponse {
    // Retain only final output for diagnosis/repair, never reasoning or an
    // executable proposal. Bound Unicode by characters without splitting UTF-8.
    let mut diagnostic = output_text.to_string();
    if !choice.message.tool_calls.is_empty() {
        diagnostic.push_str("\nNative tool calls:\n");
        diagnostic.push_str(&serde_json::to_string(&choice.message.tool_calls).unwrap_or_default());
    }
    let mut excerpt: String = diagnostic.chars().take(16000).collect();
    if excerpt.len() < diagnostic.len() {
        excerpt.push_str("\n[Response excerpt truncated]");
    }
    AgentResponse {
        output_text: excerpt,
        action: ActionResult {
            action: "none".into(),
            arguments: ActionResultArguments::default(),
            progress: None,
        },
        coordinate_absolute: None,
        success: false,
        error: Some(ApiError::ParseError(error).to_string()),
        is_done: false,
        thinking: None,
    }
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
    /// True after successful refinement. Inconclusive targeting returns an error.
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
    cancel: &CancellationToken,
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
                 over THIS image. Return exactly one tool_call only when the target is clearly visible. \
                 If it is missing or ambiguous, return plain text explaining that it was not found. Respond ONLY with: <tool_call>{{\"name\": \"computer\", \
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
                 to the true center of the element. Return one tool_call containing a coordinate only when the target is clearly visible. \
                 If it is missing or ambiguous, return plain text explaining that it was not found. Use normalized 0-{base} coordinates over THIS image \
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
    // A pass-2 failure stops execution instead of using the coarse prediction.
    let resp = match call_computer_use_api(
        api_endpoint,
        model_id,
        &crop.base64_image,
        &focused_query,
        base_int as u32,
        base_int as u32,
        &system_prompt,
        enable_thinking,
        None,
        coordinate_base,
        cancel,
    )
    .await
    {
        Ok(resp) => resp,
        // A user-requested stop should abort the whole turn, not fall back to
        // the coarse coordinate (which would then get clicked).
        Err(ApiError::Cancelled) => return Err(ApiError::Cancelled),
        Err(e) => return Err(e),
    };

    if !resp.success {
        return Err(ApiError::ParseError(
            resp.error
                .unwrap_or_else(|| "Invalid targeting response".into()),
        ));
    }

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

    // No target is safer than clicking an unverified coarse prediction.
    Err(ApiError::ParseError(
        "Target not found in zoomed view; no action executed".into(),
    ))
}

/// Extract leading <think>...</think> blocks from the model output.
/// Returns (text_with_think_blocks_removed, joined_thinking_content).
/// Handles multiple think blocks and an unclosed final block (streaming-style).
fn extract_think_tags(text: &str) -> (String, Option<String>) {
    if !text.contains("<think>") {
        return (text.to_string(), None);
    }

    let mut thoughts: Vec<String> = Vec::new();
    let mut rest = text.trim_start();

    // Never strip tags inside JSON strings (for example text the user wants typed).
    while let Some(after_open) = rest.strip_prefix("<think>") {
        if let Some(close_rel) = after_open.find("</think>") {
            let thought = after_open[..close_rel].trim();
            if !thought.is_empty() {
                thoughts.push(thought.to_string());
            }
            rest = after_open[close_rel + "</think>".len()..].trim_start();
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

    let thinking = if thoughts.is_empty() {
        None
    } else {
        Some(thoughts.join("\n\n"))
    };
    (rest.trim().to_string(), thinking)
}

/// Test the API connection
pub async fn test_connection(api_endpoint: &str) -> Result<bool, ApiError> {
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()?;

    let endpoint = endpoint(api_endpoint, "models")?;
    let response = client
        .get(endpoint)
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
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()?;

    let endpoint = endpoint(api_endpoint, "models")?;
    let response = client
        .get(endpoint)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await?;

    let models_response: ModelsResponse = decode_response(response).await?;

    let model_ids: Vec<String> = models_response.data.into_iter().map(|m| m.id).collect();
    Ok(model_ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejected_responses_keep_bounded_diagnostics_but_never_an_action() {
        for choice in [
            serde_json::json!({"message":{"content":"<tool_call>{\"name\":\"computer\",\"arguments\":{\"action\":\"key\",\"keys\":[\"enter\"]}}</tool_call>","reasoning_content":"private reasoning"}}),
            serde_json::json!({"message":{"content":null,"tool_calls":[{"function":{"name":"computer","arguments":"{\"action\":\"click\",\"coordinate\":[1001,5]}"}}]}}),
        ] {
            let choice: ChatChoice = serde_json::from_value(choice).unwrap();
            let content = choice.message.content.as_deref().unwrap_or_default();
            let error = parse_and_validate(&choice, content, 1000.0).unwrap_err();
            let response = rejected_response(&choice, content, error);
            assert!(!response.success);
            assert_eq!(response.action.action, "none");
            assert_eq!(response.action.arguments, ActionResultArguments::default());
            assert!(response.action.progress.is_none());
            assert!(
                response.output_text.contains("computer")
                    || response.output_text.contains("coordinate")
            );
            assert!(!response.output_text.contains("private reasoning"));
            assert!(response
                .error
                .unwrap()
                .starts_with("Failed to parse response:"));
            let long = rejected_response(&choice, &"😀".repeat(20000), "bad output".into());
            assert!(long.output_text.encode_utf16().count() < 33000);
            assert!(long.output_text.ends_with("[Response excerpt truncated]"));
        }
    }
    #[test]
    fn thinking_is_display_only_and_does_not_rewrite_action_text() {
        let action = r#"{"action":"type","arguments":{"text":"<think>literal</think>"}}"#;
        assert_eq!(extract_think_tags(action), (action.into(), None));
        assert_eq!(
            extract_think_tags(&format!("<think>reasoning</think>{action}")),
            (action.into(), Some("reasoning".into()))
        );
        assert_eq!(extract_think_tags("<think>unfinished action").0, "");
    }
    #[test]
    fn endpoint_preserves_base_path_and_rejects_ambiguous_urls() {
        assert_eq!(
            endpoint("http://localhost:8000/v1/", "models")
                .unwrap()
                .as_str(),
            "http://localhost:8000/v1/models"
        );
        for url in [
            "file:///private",
            "http://user:secret@localhost/v1",
            "http://localhost/v1?token=secret",
            "http://localhost/v1#fragment",
        ] {
            assert!(endpoint(url, "models").is_err());
        }
    }
    #[tokio::test]
    async fn stop_cancels_an_in_flight_http_request() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = format!("http://{}/v1", listener.local_addr().unwrap());
        let cancel = CancellationToken::new();
        let request_cancel = cancel.clone();
        let request = tokio::spawn(async move {
            call_computer_use_api(
                &address,
                "test",
                "",
                "test",
                100,
                100,
                "test",
                false,
                None,
                1000.0,
                &request_cancel,
            )
            .await
        });
        let (_connection, _) = listener.accept().await.unwrap();
        cancel.cancel();
        let result = tokio::time::timeout(std::time::Duration::from_secs(2), request)
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(result, Err(ApiError::Cancelled)));
    }
    #[tokio::test]
    async fn oversized_http_responses_are_rejected_before_parsing() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buffer = [0; 4096];
            let _ = stream.read(&mut buffer).await.unwrap();
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 999999999\r\n\r\n")
                .await
                .unwrap();
        });
        let result = fetch_models(&address).await;
        server.await.unwrap();
        assert!(result.unwrap_err().to_string().contains("2 MB limit"));
    }
}
