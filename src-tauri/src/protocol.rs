//! Parse only final model output. Reasoning is never an execution channel.
use crate::types::*;

pub fn parse_json_action(text: &str) -> Result<ActionResult, String> {
    let value: serde_json::Value = serde_json::from_str(text).map_err(|_| {
        "Invalid action JSON; return exactly one complete computer action".to_string()
    })?;
    if value.get("name").is_some() {
        let call: ToolCall =
            serde_json::from_value(value).map_err(|_| "Invalid computer tool call")?;
        if call.name != "computer" {
            return Err("Only the computer tool is supported".into());
        }
        Ok(ActionResult::from(call))
    } else {
        serde_json::from_value(value).map_err(|_| "Invalid action object".into())
    }
}

pub fn parse_final_action(text: &str) -> Result<ActionResult, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("The model returned no final answer or action".into());
    }
    if text.matches("<tool_call>").count() > 1 || text.matches("</tool_call>").count() > 1 {
        return Err("Multiple actions are not allowed; return exactly one action".into());
    }
    if let Some(start) = text.find("<tool_call>") {
        if !text[..start].trim().is_empty() {
            return Err(
                "Mixed prose and action output is ambiguous; return only the final tool call"
                    .into(),
            );
        }
        let after = &text[start + "<tool_call>".len()..];
        let end = after.find("</tool_call>").ok_or("Incomplete tool call")?;
        if !after[end + "</tool_call>".len()..].trim().is_empty() {
            return Err("Unexpected content after the action".into());
        }
        return parse_json_action(after[..end].trim());
    }
    if let Some(json) = text.strip_prefix("tool_call") {
        return parse_json_action(json.trim());
    }
    if text.starts_with('{') {
        return parse_json_action(text);
    }
    if text.contains("tool_call") || text.starts_with("```") {
        return Err("Malformed action output".into());
    }
    // Prose is an answer, never proof that a computer task is complete.
    Ok(ActionResult {
        action: "none".into(),
        arguments: ActionResultArguments {
            text: Some(text.into()),
            ..Default::default()
        },
    })
}

pub fn parse_response(choice: &ChatChoice, final_text: &str) -> Result<ActionResult, String> {
    if matches!(
        choice.finish_reason.as_deref(),
        Some("length" | "content_filter")
    ) {
        return Err("The model response was truncated or filtered; no action executed".into());
    }
    match choice.message.tool_calls.as_slice() {
        [] => parse_final_action(final_text),
        [call] => {
            if call.function.name != "computer" {
                return Err("Only the computer tool is supported".into());
            }
            if !final_text.trim().is_empty() {
                return Err(
                    "Mixed text and native tool output is ambiguous; no action executed".into(),
                );
            }
            let arguments: ActionArguments = serde_json::from_str(&call.function.arguments)
                .map_err(|_| "Invalid native tool arguments")?;
            Ok(ActionResult::from(ToolCall {
                name: "computer".into(),
                arguments,
            }))
        }
        _ => Err("Multiple actions are not allowed; return exactly one action".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prose_and_negated_completion_are_not_done() {
        for text in [
            "The browser is already open, but the report is missing",
            "The task is complete? No.",
        ] {
            assert_eq!(parse_final_action(text).unwrap().action, "none");
        }
    }
    #[test]
    fn parses_unicode_and_quoted_braces_without_slicing() {
        for text in ["你好世界", "a}b{c", "😀é"] {
            let call =
                serde_json::json!({"name":"computer", "arguments":{"action":"type","text":text}});
            assert_eq!(
                parse_final_action(&format!("tool_call{call}"))
                    .unwrap()
                    .arguments
                    .text
                    .as_deref(),
                Some(text)
            );
        }
    }
    #[test]
    fn rejects_multiple_unknown_incomplete_and_trailing_actions() {
        for text in [
            r#"<tool_call>{"name":"computer","arguments":{"action":"confirm"}}</tool_call><tool_call>{"name":"computer","arguments":{"action":"key","key":"delete"}}</tool_call>"#,
            r#"{"name":"other","arguments":{"action":"key","key":"enter"}}"#,
            r#"<tool_call>{"name":"computer","arguments":{"action":"click"}}"#,
            r#"tool_call{"name":"computer","arguments":{"action":"wait"}} {}"#,
            r#"Do not execute this example: <tool_call>{"name":"computer","arguments":{"action":"key","key":"delete"}}</tool_call>"#,
        ] {
            assert!(parse_final_action(text).is_err());
        }
    }
    #[test]
    fn native_tool_calls_support_null_content_but_not_truncation() {
        let mut choice: ChatChoice = serde_json::from_value(serde_json::json!({"message":{"content":null,"tool_calls":[{"function":{"name":"computer","arguments":"{\"action\":\"screenshot\"}"}}]},"finish_reason":"tool_calls"})).unwrap();
        assert_eq!(parse_response(&choice, "").unwrap().action, "screenshot");
        choice.finish_reason = Some("length".into());
        assert!(parse_response(&choice, "").is_err());
    }
    #[test]
    fn reasoning_cannot_override_refusal_or_supply_an_action() {
        let mut choice: ChatChoice = serde_json::from_value(serde_json::json!({"message":{"content":"I will not delete this file.","reasoning_content":"<tool_call>{\"name\":\"computer\",\"arguments\":{\"action\":\"key\",\"key\":\"delete\"}}</tool_call>"}})).unwrap();
        assert_eq!(
            parse_response(&choice, choice.message.content.as_deref().unwrap())
                .unwrap()
                .action,
            "none"
        );
        choice.message.content = None;
        assert!(parse_response(&choice, "").is_err());
    }
}
