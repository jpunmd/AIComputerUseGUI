//! Parse only final model output. Reasoning is never an execution channel.
use crate::types::*;

/// Share one schema with the tool definition shown to the model.
pub fn response_format(coordinate_base: f64) -> serde_json::Value {
    let tool: serde_json::Value =
        serde_json::from_str(include_str!("../../src/agent/computer-tool.json"))
            .expect("bundled computer tool schema must be valid JSON");
    let mut arguments = tool["function"]["parameters"].clone();
    for field in ["coordinate", "start_coordinate", "end_coordinate"] {
        arguments["properties"][field]["items"]["maximum"] = coordinate_base.into();
    }
    serde_json::json!({
        "type": "json_schema",
        "json_schema": {
            "name": "computer_action",
            "schema": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "enum": ["computer"]},
                    "arguments": arguments
                },
                "required": ["name", "arguments"],
                "additionalProperties": false
            }
        }
    })
}

pub fn structured_prompt(prompt: &str) -> String {
    // The grammar emits JSON, so examples must not teach XML-wrapped output.
    let prompt = prompt
        .replace("<tool_call>", "")
        .replace("</tool_call>", "");
    format!("{prompt}\n\nResponse transport: return exactly one JSON object with name=computer and arguments matching the supplied response schema. This overrides earlier formatting instructions: no XML tags, Markdown fences or prose outside the object. To finish, use action=done with the answer or result in arguments.text. For an ambiguous/missing target, use action=none and put the explanation in arguments.text.")
}

fn schema_error(context: &str, error: serde_json::Error) -> String {
    // Preserve the actual schema failure for the bounded repair attempt, without
    // letting a model-supplied field/value create an unbounded error message.
    let detail: String = error.to_string().chars().take(700).collect();
    format!("{context}: {detail}")
}

pub fn parse_json_action(text: &str) -> Result<ActionResult, String> {
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|e| schema_error("Invalid action JSON", e))?;
    if value.get("name").is_some() {
        let call: ToolCall = serde_json::from_value(value)
            .map_err(|e| schema_error("Invalid computer tool call", e))?;
        if call.name != "computer" {
            return Err("Only the computer tool is supported".into());
        }
        Ok(ActionResult::from(call))
    } else {
        serde_json::from_value(value).map_err(|e| schema_error("Invalid action object", e))
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
        report: None,
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
                .map_err(|e| schema_error("Invalid native tool arguments", e))?;
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
    fn schema_is_flat_and_nested_progress_is_rejected() {
        let format = response_format(1000.0);
        let args = &format["json_schema"]["schema"]["properties"]["arguments"];
        assert_eq!(args["additionalProperties"], false);
        assert!(args["properties"].get("progress").is_none());
        for field in ["screen", "last_action", "step_done", "steps", "reason"] {
            assert!(args["properties"].get(field).is_some());
        }
        assert_eq!(args["properties"]["steps"]["maxItems"], 7);
        // Grammar-constrained servers emit properties in schema order. Keep the
        // file's order (which the prompt examples follow), not alphabetical:
        // text must not be forced last, or a model that wants to add screen
        // after it can only keep extending the string.
        let file: serde_json::Value =
            serde_json::from_str(include_str!("../../src/agent/computer-tool.json")).unwrap();
        let keys =
            |v: &serde_json::Value| v.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
        assert_eq!(
            keys(&args["properties"]),
            keys(&file["function"]["parameters"]["properties"])
        );
        assert_eq!(
            keys(&format["json_schema"]["schema"]["properties"]),
            ["name", "arguments"]
        );
        assert_eq!(
            response_format(500.0)["json_schema"]["schema"]["properties"]["arguments"]
                ["properties"]["coordinate"]["items"]["maximum"],
            500.0
        );
        for call in [
            r#"{"name":"computer","arguments":{"action":"click","coordinate":[308,977],"progress":{"next_milestone_id":"m1-1"}}}"#,
            r#"{"name":"computer","arguments":{"action":"click","coordinate":[308,977],"next_milestone_id":"m1-1"}}"#,
        ] {
            assert!(parse_json_action(call)
                .unwrap_err()
                .contains("unknown field"));
        }
    }

    #[test]
    fn flat_fields_parse_into_a_report() {
        let action = parse_json_action(r#"{"name":"computer","arguments":{"action":"type","text":"weather","screen":"Chrome address bar focused","last_action":"worked","step_done":true}}"#).unwrap();
        crate::validation::validate(&action, 1000.0, true).unwrap();
        let report = action.report.unwrap();
        assert_eq!(report.last_action, Some(LastAction::Worked));
        assert_eq!(report.step_done, Some(true));
        let plain =
            parse_json_action(r#"{"name":"computer","arguments":{"action":"key","key":"enter"}}"#)
                .unwrap();
        assert!(plain.report.is_none());
    }

    #[test]
    fn plan_steps_parse_and_round_trip_without_optional_nulls() {
        let action = parse_json_action(r#"{"name":"computer","arguments":{"action":"plan","steps":["Open Chrome -> a Chrome window is visible","Search -> results shown"],"reason":"Taskbar icon did not respond"}}"#).unwrap();
        crate::validation::validate(&action, 1000.0, false).unwrap();
        assert_eq!(action.arguments.steps.as_ref().unwrap().len(), 2);
        let serialized = serde_json::to_value(&action).unwrap();
        assert_eq!(
            serialized["arguments"]["reason"],
            "Taskbar icon did not respond"
        );
        assert!(serialized["arguments"].get("text").is_none());
        assert!(serialized.get("report").is_none());
        assert!(parse_json_action(
            r#"{"name":"computer","arguments":{"action":"plan","steps":[{"title":"Open Chrome"}]}}"#
        )
        .is_err());
    }

    #[test]
    fn constrained_prompt_uses_json_examples_and_can_report_missing_targets() {
        let prompt = structured_prompt("Example: <tool_call>{\"name\":\"computer\"}</tool_call>");
        assert!(!prompt.contains("<tool_call>"));
        assert!(prompt.contains("action=none"));
        assert!(prompt.contains("action=done with the answer"));
        assert!(!prompt.contains("progress"));
    }

    #[test]
    fn schema_errors_name_the_invalid_field_or_value_for_repair() {
        let unknown = parse_json_action(
            r#"{"name":"computer","arguments":{"action":"key","keys":["enter"]}}"#,
        )
        .unwrap_err();
        assert!(unknown.contains("unknown field `keys`"));
        let status = parse_json_action(r#"{"name":"computer","arguments":{"action":"key","key":"enter","last_action":"maybe"}}"#).unwrap_err();
        assert!(status.contains("unknown variant `maybe`"));
        assert!(status.contains("worked"));
        let malformed = parse_json_action("{\"name\":").unwrap_err();
        assert!(malformed.contains("line 1"));
        let long = serde_json::json!({"name":"computer","arguments":{"action":"wait","step_done":"yes"}, "💥".repeat(5000):true});
        assert!(
            parse_json_action(&long.to_string())
                .unwrap_err()
                .chars()
                .count()
                < 800
        );
    }

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
