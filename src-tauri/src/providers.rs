//! What differs between model providers: how the key is sent, which request
//! fields they accept, and (for Claude) the request and response shapes.
//!
//! The provider is derived from the endpoint's host, so it cannot disagree
//! with where the request actually goes.

use crate::{secrets::ApiKey, types::*};
use serde_json::{json, Value};

const ANTHROPIC_VERSION: &str = "2026-10-21";

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Provider {
    /// A local or self-hosted OpenAI-compatible server (llama.cpp, vLLM,
    /// LM Studio, Ollama) or any other compatible endpoint.
    Compatible,
    OpenRouter,
    OpenAi,
    Anthropic,
    Google,
}

impl Provider {
    pub fn of(url: &reqwest::Url) -> Self {
        match url.host_str().unwrap_or_default() {
            "openrouter.ai" => Self::OpenRouter,
            "api.openai.com" => Self::OpenAi,
            "api.anthropic.com" => Self::Anthropic,
            "generativelanguage.googleapis.com" => Self::Google,
            _ => Self::Compatible,
        }
    }

    pub fn is_hosted(self) -> bool {
        self != Self::Compatible
    }

    /// Path of the completion call, relative to the configured base URL.
    pub fn completion_path(self) -> &'static str {
        match self {
            Self::Anthropic => "messages",
            _ => "chat/completions",
        }
    }

    /// A cheap authenticated GET that proves the endpoint and key work.
    /// OpenRouter lists models without a key, so ask about the key itself.
    pub fn check_path(self) -> &'static str {
        match self {
            Self::OpenRouter => "key",
            _ => "models",
        }
    }

    /// Attach the key the way this provider expects. The value is marked
    /// sensitive so HTTP debug output never prints it.
    pub fn authorize(
        self,
        request: reqwest::RequestBuilder,
        key: Option<&ApiKey>,
    ) -> reqwest::RequestBuilder {
        let request = match self {
            Self::Anthropic => request.header("anthropic-version", ANTHROPIC_VERSION),
            _ => request,
        };
        let Some(key) = key else { return request };
        let (name, value) = match self {
            Self::Anthropic => ("x-api-key", key.expose().to_owned()),
            _ => ("authorization", format!("Bearer {}", key.expose())),
        };
        match reqwest::header::HeaderValue::from_str(&value) {
            Ok(mut value) => {
                value.set_sensitive(true);
                request.header(name, value)
            }
            // ApiKey::parse only admits printable ASCII, so this cannot fail.
            Err(_) => request,
        }
    }

    /// Adjust an OpenAI-style request to what this provider accepts.
    pub fn shape(self, request: &mut ChatRequest) {
        if self.is_hosted() {
            // A chat-template switch for local servers; hosted APIs reject
            // or ignore the unknown field.
            request.chat_template_kwargs = None;
        }
        if self == Self::OpenAi {
            // Current OpenAI models take max_completion_tokens; reasoning
            // models reject max_tokens.
            request.max_completion_tokens = request.max_tokens.take();
        }
    }

    /// The JSON body to send.
    pub fn body(self, request: &ChatRequest, thinking: bool) -> Value {
        match self {
            Self::Anthropic => anthropic_body(request, thinking),
            _ => serde_json::to_value(request).unwrap_or_default(),
        }
    }

    /// Normalize a successful response to the OpenAI shape the parser reads.
    pub fn response(self, body: Value) -> Result<ChatResponse, String> {
        match self {
            Self::Anthropic => Ok(anthropic_response(&body)),
            _ => serde_json::from_value(body).map_err(|e| e.to_string()),
        }
    }
}

/// Claude's structured outputs reject numeric, length and array-size limits.
/// Drop them from the schema; every response is still validated locally.
fn without_unsupported_limits(schema: &Value) -> Value {
    const LIMITS: [&str; 9] = [
        "minimum",
        "maximum",
        "exclusiveMinimum",
        "exclusiveMaximum",
        "multipleOf",
        "minLength",
        "maxLength",
        "minItems",
        "maxItems",
    ];
    match schema {
        Value::Object(map) => Value::Object(
            map.iter()
                .filter(|(name, _)| !LIMITS.contains(&name.as_str()))
                .map(|(name, value)| {
                    let value = if name == "properties" {
                        // Keys here are field names, not schema keywords.
                        match value {
                            Value::Object(fields) => Value::Object(
                                fields
                                    .iter()
                                    .map(|(field, schema)| {
                                        (field.clone(), without_unsupported_limits(schema))
                                    })
                                    .collect(),
                            ),
                            other => other.clone(),
                        }
                    } else {
                        without_unsupported_limits(value)
                    };
                    (name.clone(), value)
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(without_unsupported_limits).collect()),
        other => other.clone(),
    }
}

fn anthropic_content(parts: &[ContentPart]) -> Vec<Value> {
    parts
        .iter()
        .map(|part| match part {
            ContentPart::Text { text } => json!({"type": "text", "text": text}),
            ContentPart::ImageUrl { image_url } => {
                // Screenshots are sent as data URLs; Claude takes the parts.
                let (media_type, data) = image_url
                    .url
                    .strip_prefix("data:")
                    .and_then(|rest| rest.split_once(";base64,"))
                    .unwrap_or(("image/png", image_url.url.as_str()));
                json!({"type": "image", "source": {"type": "base64", "media_type": media_type, "data": data}})
            }
        })
        .collect()
}

/// Translate to the Claude Messages API: the system prompt is a top-level
/// field, images are base64 sources, and the schema goes in output_config.
fn anthropic_body(request: &ChatRequest, thinking: bool) -> Value {
    let mut system = String::new();
    let mut messages = vec![];
    for message in &request.messages {
        if message.role == "system" {
            for part in &message.content {
                if let ContentPart::Text { text } = part {
                    if !system.is_empty() {
                        system.push_str("\n\n");
                    }
                    system.push_str(text);
                }
            }
        } else {
            messages.push(
                json!({"role": message.role, "content": anthropic_content(&message.content)}),
            );
        }
    }
    let mut body = json!({
        "model": request.model,
        "max_tokens": request.max_tokens.or(request.max_completion_tokens).unwrap_or(8192),
        "messages": messages,
    });
    if !system.is_empty() {
        body["system"] = system.into();
    }
    if thinking {
        // Adaptive is the only mode current models accept; the summary is
        // for display. Off means the model's own default, since several
        // models reject an explicit "disabled".
        body["thinking"] = json!({"type": "adaptive", "display": "summarized"});
    }
    if let Some(schema) = request
        .response_format
        .as_ref()
        .and_then(|format| format["json_schema"].get("schema"))
    {
        body["output_config"] = json!({
            "format": {"type": "json_schema", "schema": without_unsupported_limits(schema)}
        });
    }
    body
}

fn anthropic_response(body: &Value) -> ChatResponse {
    let blocks = |kind: &str, field: &str| -> Vec<&str> {
        body["content"]
            .as_array()
            .map(|content| {
                content
                    .iter()
                    .filter(|block| block["type"] == kind)
                    .filter_map(|block| block[field].as_str())
                    .filter(|text| !text.is_empty())
                    .collect()
            })
            .unwrap_or_default()
    };
    let text = blocks("text", "text").join("");
    let reasoning = blocks("thinking", "thinking").join("\n\n");
    let finish_reason = match body["stop_reason"].as_str() {
        Some("max_tokens") => "length",
        Some("refusal") => "content_filter",
        _ => "stop",
    };
    ChatResponse {
        choices: vec![ChatChoice {
            message: ChatMessageResponse {
                content: Some(text),
                reasoning_content: (!reasoning.is_empty()).then_some(reasoning),
                reasoning: None,
                tool_calls: vec![],
            },
            finish_reason: Some(finish_reason.into()),
        }],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider(url: &str) -> Provider {
        Provider::of(&reqwest::Url::parse(url).unwrap())
    }

    fn request() -> ChatRequest {
        ChatRequest {
            response_format: Some(crate::protocol::response_format(1000.0)),
            model: "m".into(),
            messages: vec![
                ChatMessage {
                    role: "system".into(),
                    content: vec![ContentPart::Text {
                        text: "rules".into(),
                    }],
                },
                ChatMessage {
                    role: "user".into(),
                    content: vec![
                        ContentPart::ImageUrl {
                            image_url: ImageUrl {
                                url: "data:image/png;base64,QUJD".into(),
                            },
                        },
                        ContentPart::Text {
                            text: "open notepad".into(),
                        },
                    ],
                },
            ],
            max_tokens: Some(4096),
            max_completion_tokens: None,
            chat_template_kwargs: Some(ChatTemplateKwargs {
                enable_thinking: Some(true),
            }),
        }
    }

    #[test]
    fn provider_comes_from_the_exact_host() {
        assert_eq!(
            provider("https://openrouter.ai/api/v1"),
            Provider::OpenRouter
        );
        assert_eq!(provider("https://api.openai.com/v1"), Provider::OpenAi);
        assert_eq!(
            provider("https://api.anthropic.com/v1"),
            Provider::Anthropic
        );
        assert_eq!(
            provider("https://generativelanguage.googleapis.com/v1beta/openai"),
            Provider::Google
        );
        for url in [
            "http://localhost:8889/v1",
            "https://api.openai.com.example.net/v1",
            "https://my-proxy.example/api.anthropic.com/v1",
        ] {
            assert_eq!(provider(url), Provider::Compatible, "{url}");
        }
    }

    #[test]
    fn hosted_requests_drop_local_only_fields() {
        let mut local = request();
        Provider::Compatible.shape(&mut local);
        let local = Provider::Compatible.body(&local, true);
        assert_eq!(local["chat_template_kwargs"]["enable_thinking"], true);
        assert_eq!(local["max_tokens"], 4096);
        assert!(local.get("max_completion_tokens").is_none());

        for hosted in [Provider::OpenRouter, Provider::Google] {
            let mut shaped = request();
            hosted.shape(&mut shaped);
            let body = hosted.body(&shaped, true);
            assert!(body.get("chat_template_kwargs").is_none());
            assert_eq!(body["max_tokens"], 4096);
        }

        let mut openai = request();
        Provider::OpenAi.shape(&mut openai);
        let openai = Provider::OpenAi.body(&openai, true);
        assert_eq!(openai["max_completion_tokens"], 4096);
        assert!(openai.get("max_tokens").is_none());
        assert!(openai.get("chat_template_kwargs").is_none());
        assert_eq!(openai["response_format"]["type"], "json_schema");
    }

    #[test]
    fn claude_requests_use_the_messages_shape() {
        let mut shaped = request();
        Provider::Anthropic.shape(&mut shaped);
        let body = Provider::Anthropic.body(&shaped, true);
        assert_eq!(body["system"], "rules");
        assert_eq!(body["max_tokens"], 4096);
        assert_eq!(body["messages"].as_array().unwrap().len(), 1);
        assert_eq!(
            body["messages"][0]["content"][0],
            json!({"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "QUJD"}})
        );
        assert_eq!(body["messages"][0]["content"][1]["text"], "open notepad");
        assert_eq!(
            body["thinking"],
            json!({"type": "adaptive", "display": "summarized"})
        );
        for absent in ["response_format", "chat_template_kwargs", "temperature"] {
            assert!(body.get(absent).is_none(), "{absent}");
        }
        // The schema keeps its structure but loses the limits Claude rejects.
        let format = &body["output_config"]["format"];
        assert_eq!(format["type"], "json_schema");
        let schema = format["schema"].to_string();
        for limit in ["maximum", "minimum", "maxLength", "minItems", "maxItems"] {
            assert!(!schema.contains(&format!("\"{limit}\"")), "{limit}");
        }
        assert!(schema.contains("\"additionalProperties\":false"));
        assert!(schema.contains("\"anyOf\""));
        assert!(schema.contains("left_click_drag"));

        // Thinking off leaves the model's default; no schema, no output_config.
        shaped.response_format = None;
        let plain = Provider::Anthropic.body(&shaped, false);
        assert!(plain.get("thinking").is_none());
        assert!(plain.get("output_config").is_none());
    }

    #[test]
    fn schema_limits_are_removed_without_touching_field_names() {
        let cleaned = without_unsupported_limits(&json!({
            "type": "object",
            "properties": {
                "maximum": {"type": "number", "maximum": 5},
                "tags": {"type": "array", "minItems": 1, "items": {"type": "string", "maxLength": 3}}
            },
            "required": ["maximum"]
        }));
        assert_eq!(
            cleaned,
            json!({
                "type": "object",
                "properties": {
                    "maximum": {"type": "number"},
                    "tags": {"type": "array", "items": {"type": "string"}}
                },
                "required": ["maximum"]
            })
        );
    }

    #[test]
    fn claude_responses_map_to_the_shared_parser() {
        let response = Provider::Anthropic
            .response(json!({
                "content": [
                    {"type": "thinking", "thinking": "The button is top left."},
                    {"type": "text", "text": "{\"name\":\"computer\",\"arguments\":{\"action\":\"wait\"}}"}
                ],
                "stop_reason": "end_turn"
            }))
            .unwrap();
        let choice = &response.choices[0];
        assert_eq!(choice.finish_reason.as_deref(), Some("stop"));
        assert_eq!(
            choice.message.reasoning_content.as_deref(),
            Some("The button is top left.")
        );
        assert_eq!(
            crate::protocol::parse_response(choice, choice.message.content.as_deref().unwrap())
                .unwrap()
                .action,
            "wait"
        );
        for (stop, expected) in [
            ("max_tokens", "output token limit"),
            ("refusal", "filtered"),
        ] {
            let response = Provider::Anthropic
                .response(json!({"content": [], "stop_reason": stop}))
                .unwrap();
            let error = crate::protocol::parse_response(&response.choices[0], "").unwrap_err();
            assert!(error.contains(expected), "{error}");
        }
    }
}
