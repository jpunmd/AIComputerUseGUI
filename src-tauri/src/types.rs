use serde::{Deserialize, Serialize};

/// Settings for the computer use agent (used by frontend, kept for API compatibility)
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub api_endpoint: String,
    pub model_id: String,
    pub display_width: u32,
    pub display_height: u32,
}

#[allow(dead_code)]
impl Default for Settings {
    fn default() -> Self {
        Self {
            api_endpoint: "http://localhost:8000/v1".to_string(),
            model_id: "Qwen/Qwen3-VL-30B-A3B-Instruct".to_string(),
            display_width: 1000,
            display_height: 1000,
        }
    }
}

/// Coordinate in the image space
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Coordinate {
    pub x: f64,
    pub y: f64,
}

/// Action arguments from the model (inside the tool_call)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionArguments {
    /// The action type: click, left_click, right_click, double_click, type, key, scroll, etc.
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coordinate: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_coordinate: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_coordinate: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub direction: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub button: Option<String>,
}

/// Tool call result from the model
/// Format: {"name": "computer", "arguments": {"action": "click", "coordinate": [x, y]}}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub name: String,
    pub arguments: ActionArguments,
}

/// Action result - flattened for easier use
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionResult {
    pub action: String,
    pub arguments: ActionResultArguments,
}

/// Flattened action arguments for ActionResult
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionResultArguments {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coordinate: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_coordinate: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_coordinate: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub direction: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount: Option<i32>,
}

impl From<ToolCall> for ActionResult {
    fn from(tool_call: ToolCall) -> Self {
        ActionResult {
            action: tool_call.arguments.action,
            arguments: ActionResultArguments {
                coordinate: tool_call.arguments.coordinate,
                text: tool_call.arguments.text,
                key: tool_call.arguments.key,
                start_coordinate: tool_call.arguments.start_coordinate,
                end_coordinate: tool_call.arguments.end_coordinate,
                direction: tool_call.arguments.direction,
                amount: tool_call.arguments.amount,
            },
        }
    }
}

/// Response from the agent
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentResponse {
    pub output_text: String,
    pub action: ActionResult,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coordinate_absolute: Option<Coordinate>,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Whether the agent believes the task is complete
    #[serde(default)]
    pub is_done: bool,
    /// The agent's reasoning/thinking about what to do next
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
}

/// OpenAI-compatible chat message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: Vec<ContentPart>,
}

/// Content part for multimodal messages
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ContentPart {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "image_url")]
    ImageUrl { image_url: ImageUrl },
}

/// Image URL structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageUrl {
    pub url: String,
}

/// Extra kwargs for chat template (e.g., enable thinking mode)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatTemplateKwargs {
    pub enable_thinking: bool,
}

/// OpenAI-compatible chat request
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_template_kwargs: Option<ChatTemplateKwargs>,
}

/// OpenAI-compatible chat response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatResponse {
    pub choices: Vec<ChatChoice>,
}

/// Chat choice from the response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatChoice {
    pub message: ChatMessageResponse,
}

/// Message in the response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessageResponse {
    pub content: String,
    /// Reasoning/thinking content from thinking models (e.g. Qwen3, DeepSeek-R1)
    #[serde(default)]
    pub reasoning_content: Option<String>,
}
