//! Parse only final model output. Reasoning is never an execution channel.
use crate::types::*;

/// Share one schema with the tool definition shown to the model. `simple`
/// selects the flat format (no nested progress object) for small models.
pub fn response_format(coordinate_base: f64, simple: bool) -> serde_json::Value {
    let source = if simple {
        include_str!("../../src/agent/computer-tool-simple.json")
    } else {
        include_str!("../../src/agent/computer-tool.json")
    };
    let tool: serde_json::Value =
        serde_json::from_str(source).expect("bundled computer tool schema must be valid JSON");
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

pub fn structured_prompt(prompt: &str, simple: bool) -> String {
    // The grammar emits JSON, so examples must not teach XML-wrapped output.
    let prompt = prompt
        .replace("<tool_call>", "")
        .replace("</tool_call>", "");
    let nesting = if simple {
        ""
    } else {
        " Keep next_milestone_id and expected_outcome inside arguments.progress."
    };
    format!("{prompt}\n\nResponse transport: return exactly one JSON object with name=computer and arguments matching the supplied response schema. This overrides earlier formatting instructions: no XML tags, Markdown fences or prose outside the object. For an answer or an ambiguous/missing target, use action=none and put the explanation in arguments.text.{nesting}")
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
        progress: None,
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
    fn misplaced_progress_fields_are_rejected_and_correct_nesting_passes() {
        let mut call = serde_json::json!({"name":"computer","arguments":{
            "action":"click","coordinate":[308,977],
            "progress":{"outcome":{"status":"failed","evidence":"Desktop is still visible"},
                "milestones":[{"id":"m1-1","status":"in_progress","evidence":"Browser is not open"}]},
            "next_milestone_id":"m1-1","expected_outcome":"Chrome browser window opens"
        }});
        assert!(parse_json_action(&call.to_string())
            .unwrap_err()
            .contains("unknown field"));
        for key in ["next_milestone_id", "expected_outcome"] {
            let value = call["arguments"]
                .as_object_mut()
                .unwrap()
                .remove(key)
                .unwrap();
            call["arguments"]["progress"][key] = value;
        }
        let action = parse_final_action(&call.to_string()).unwrap();
        crate::validation::validate(&action, 1000.0, true).unwrap();
        let format = response_format(1000.0, false);
        let args = &format["json_schema"]["schema"]["properties"]["arguments"];
        assert_eq!(args["additionalProperties"], false);
        assert!(args["properties"].get("next_milestone_id").is_none());
        assert!(args["properties"]["progress"]["properties"]
            .get("next_milestone_id")
            .is_some());
        assert_eq!(
            response_format(500.0, false)["json_schema"]["schema"]["properties"]["arguments"]
                ["properties"]["coordinate"]["items"]["maximum"],
            500.0
        );
    }

    #[test]
    fn simple_format_is_flat_and_parses_into_a_report() {
        let args =
            &response_format(1000.0, true)["json_schema"]["schema"]["properties"]["arguments"];
        assert_eq!(args["additionalProperties"], false);
        assert!(args["properties"].get("progress").is_none());
        for field in ["screen", "last_action", "step_done"] {
            assert!(args["properties"].get(field).is_some());
        }
        assert!(!structured_prompt("x", true).contains("progress"));
        let action = parse_json_action(r#"{"name":"computer","arguments":{"action":"type","text":"weather","screen":"Chrome address bar focused","last_action":"worked","step_done":true}}"#).unwrap();
        crate::validation::validate(&action, 1000.0, true).unwrap();
        let report = action.report.unwrap();
        assert_eq!(report.last_action, Some(LastAction::Worked));
        assert_eq!(report.step_done, Some(true));
        let plain =
            parse_json_action(r#"{"name":"computer","arguments":{"action":"key","key":"enter"}}"#)
                .unwrap();
        assert!(plain.report.is_none());
        assert!(parse_json_action(r#"{"name":"computer","arguments":{"action":"key","key":"enter","last_action":"maybe"}}"#).is_err());
    }
    #[test]
    fn constrained_prompt_uses_json_examples_and_can_report_missing_targets() {
        let prompt = structured_prompt(
            "Example: <tool_call>{\"name\":\"computer\"}</tool_call>",
            false,
        );
        assert!(!prompt.contains("<tool_call>"));
        assert!(prompt.contains("action=none"));
        assert!(prompt.contains("inside arguments.progress"));
    }
    #[test]
    fn local_qwen_progress_responses_pass_wire_and_action_validation() {
        let outputs: Vec<String> =
            serde_json::from_str(include_str!("../../tests/fixtures/qwen-progress.json")).unwrap();
        for output in outputs {
            let action = parse_final_action(&output).unwrap();
            crate::validation::validate(&action, 1000.0, true).unwrap();
            assert!(action.progress.is_some());
        }
    }
    #[test]
    fn schema_errors_name_the_invalid_field_or_value_for_repair() {
        let unknown = parse_json_action(
            r#"{"name":"computer","arguments":{"action":"key","keys":["enter"]}}"#,
        )
        .unwrap_err();
        assert!(unknown.contains("unknown field `keys`"));
        let status = parse_json_action(r#"{"name":"computer","arguments":{"action":"click","coordinate":[400,980],"progress":{"milestones":[{"id":"m1-1","status":"pending","evidence":"Desktop visible"}]}}}"#).unwrap_err();
        assert!(status.contains("unknown variant `pending`"));
        assert!(status.contains("in_progress"));
        let malformed = parse_json_action("{\"name\":").unwrap_err();
        assert!(malformed.contains("line 1"));
        let long = serde_json::json!({"name":"computer","arguments":{"action":"wait","progress":{"next_milestone_id":true}}, "💥".repeat(5000):true});
        assert!(
            parse_json_action(&long.to_string())
                .unwrap_err()
                .chars()
                .count()
                < 800
        );
    }

    #[test]
    fn progress_is_typed_and_round_trips_without_optional_nulls() {
        let call = serde_json::json!({"name":"computer","arguments":{"action":"done","text":"Saved","progress":{"milestones":[{"id":"m1-1","status":"completed","evidence":"Saved label visible"}],"notes":[{"kind":"question","text":"Which folder next?"}]}}});
        let action = parse_json_action(&call.to_string()).unwrap();
        let serialized = serde_json::to_value(&action).unwrap();
        assert_eq!(serialized["progress"]["milestones"][0]["id"], "m1-1");
        assert!(serialized["progress"].get("outcome").is_none());
        assert!(serialized["progress"]["notes"][0].get("evidence").is_none());
        assert!(serialized["arguments"].get("progress").is_none());
        let mut forbidden = call.clone();
        forbidden["arguments"]["progress"]["approved"] = true.into();
        assert!(parse_json_action(&forbidden.to_string()).is_err());
        let mut invalid = call;
        invalid["arguments"]["progress"]["milestones"][0]["status"] = "authorized".into();
        assert!(parse_json_action(&invalid.to_string()).is_err());
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
