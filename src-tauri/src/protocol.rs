//! Parse only final model output. Reasoning is never an execution channel.
use crate::types::*;

/// For each group of actions: the fields it must send and the fields it may
/// send, besides the report fields any action may add. Mirrors
/// `validation::validate`.
type ActionFields = (
    &'static [&'static str],
    &'static [&'static str],
    &'static [&'static str],
);
const ACTION_FIELDS: [ActionFields; 9] = [
    (
        &["click", "left_click", "right_click", "double_click"],
        &["coordinate"],
        &[],
    ),
    (
        &["left_click_drag"],
        &["start_coordinate", "end_coordinate"],
        &[],
    ),
    (&["scroll"], &["coordinate", "direction"], &["amount"]),
    (&["type"], &["text"], &[]),
    (&["key"], &["key"], &[]),
    (&["wait", "screenshot"], &[], &[]),
    (&["plan"], &["steps"], &["reason"]),
    (&["done", "confirm"], &["text"], &[]),
    (&["none"], &[], &["text"]),
];
const REPORT_FIELDS: [&str; 3] = ["screen", "last_action", "step_done"];

/// Built from the same flat tool definition shown to the model, as one
/// variant per group of actions. Grammar-constrained servers (llama.cpp) emit
/// required properties first and then optional ones in schema order, and can
/// never return to one they skipped. In a single flat schema every field was
/// optional, so a model that opened a plan with its reason could never add the
/// steps it needs (steps is declared first). Per-action variants make the
/// needed fields required, so they come straight after the action name.
pub fn response_format(coordinate_base: f64) -> serde_json::Value {
    let tool: serde_json::Value =
        serde_json::from_str(include_str!("../../src/agent/computer-tool.json"))
            .expect("bundled computer tool schema must be valid JSON");
    let mut fields = tool["function"]["parameters"]["properties"].clone();
    for field in ["coordinate", "start_coordinate", "end_coordinate"] {
        fields[field]["items"]["maximum"] = coordinate_base.into();
    }
    let fields = fields
        .as_object()
        .expect("computer tool must declare properties");
    let variants: Vec<_> = ACTION_FIELDS
        .iter()
        .map(|(actions, required, optional)| {
            let mut properties = serde_json::Map::new();
            properties.insert(
                "action".into(),
                serde_json::json!({"type": "string", "enum": actions}),
            );
            // Keep the file's order (which the prompt examples follow).
            for (name, schema) in fields {
                let name = name.as_str();
                if required.contains(&name)
                    || optional.contains(&name)
                    || REPORT_FIELDS.contains(&name)
                {
                    properties.insert(name.into(), schema.clone());
                }
            }
            let required: Vec<&str> = std::iter::once("action")
                .chain(required.iter().copied())
                .collect();
            serde_json::json!({
                "type": "object",
                "properties": properties,
                "required": required,
                "additionalProperties": false
            })
        })
        .collect();
    let arguments = serde_json::json!({ "anyOf": variants });
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
    match choice.finish_reason.as_deref() {
        Some("length") => return Err("The model hit the output token limit before finishing; no action executed. Raise Max output tokens in Settings or turn off thinking.".into()),
        Some("content_filter") => {
            return Err("The model server filtered the response; no action executed".into())
        }
        _ => {}
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
    fn variants(format: &serde_json::Value) -> Vec<serde_json::Value> {
        format["json_schema"]["schema"]["properties"]["arguments"]["anyOf"]
            .as_array()
            .unwrap()
            .clone()
    }

    fn keys(v: &serde_json::Value) -> Vec<String> {
        v.as_object().unwrap().keys().cloned().collect()
    }

    #[test]
    fn schema_is_flat_and_nested_progress_is_rejected() {
        let format = response_format(1000.0);
        let file: serde_json::Value =
            serde_json::from_str(include_str!("../../src/agent/computer-tool.json")).unwrap();
        let file_fields = keys(&file["function"]["parameters"]["properties"]);
        let mut actions = vec![];
        for variant in variants(&format) {
            assert_eq!(variant["additionalProperties"], false);
            assert!(variant["properties"].get("progress").is_none());
            for field in REPORT_FIELDS {
                assert!(variant["properties"].get(field).is_some());
            }
            // Fields are flat: no nested objects, at most a list of scalars.
            for (name, schema) in variant["properties"].as_object().unwrap() {
                assert_ne!(schema["type"], "object", "{name}");
                assert_ne!(schema["items"]["type"], "object", "{name}");
            }
            // Keep the file's order (which the prompt examples follow), not
            // alphabetical: text must not be forced last, or a model that wants
            // to add screen after it can only keep extending the string.
            let order: Vec<_> = keys(&variant["properties"])[1..]
                .iter()
                .map(|k| file_fields.iter().position(|f| f == k).unwrap())
                .collect();
            assert!(order.windows(2).all(|w| w[0] < w[1]), "{order:?}");
            actions.extend(
                variant["properties"]["action"]["enum"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|a| a.as_str().unwrap().to_owned()),
            );
        }
        // Every action the tool offers is covered exactly once.
        let offered: Vec<String> = file["function"]["parameters"]["properties"]["action"]["enum"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a.as_str().unwrap().to_owned())
            .collect();
        let mut sorted = actions.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), actions.len());
        let mut expected = offered;
        expected.sort();
        assert_eq!(sorted, expected);
        assert_eq!(
            keys(&format["json_schema"]["schema"]["properties"]),
            ["name", "arguments"]
        );
        for variant in variants(&response_format(500.0)) {
            if let Some(coordinate) = variant["properties"].get("coordinate") {
                assert_eq!(coordinate["items"]["maximum"], 500.0);
            }
        }
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
    fn each_variant_requires_what_validation_requires() {
        let sample = |field: &str| match field {
            "coordinate" | "start_coordinate" | "end_coordinate" => serde_json::json!([500, 500]),
            "direction" => "down".into(),
            "key" => "enter".into(),
            "steps" => serde_json::json!(["Open Chrome -> a Chrome window is visible"]),
            _ => "x".into(),
        };
        for variant in variants(&response_format(1000.0)) {
            let required: Vec<&str> = variant["required"]
                .as_array()
                .unwrap()
                .iter()
                .map(|f| f.as_str().unwrap())
                .collect();
            assert_eq!(required[0], "action");
            for action in variant["properties"]["action"]["enum"].as_array().unwrap() {
                // The least the grammar allows is a valid action...
                let mut arguments = serde_json::json!({"action": action});
                for field in &required[1..] {
                    arguments[field] = sample(field);
                }
                let call = serde_json::json!({"name": "computer", "arguments": arguments});
                let parsed = parse_json_action(&call.to_string()).unwrap();
                crate::validation::validate(&parsed, 1000.0, false)
                    .unwrap_or_else(|e| panic!("{action}: {e}"));
                // ...and dropping any required field is not.
                for field in &required[1..] {
                    let mut short = arguments.clone();
                    short.as_object_mut().unwrap().remove(*field);
                    let call = serde_json::json!({"name": "computer", "arguments": short});
                    let parsed = parse_json_action(&call.to_string()).unwrap();
                    assert!(
                        crate::validation::validate(&parsed, 1000.0, false).is_err(),
                        "{action} without {field}"
                    );
                }
            }
        }
        // The regression: a replan that opens with its reason can still (and
        // must) send steps, because steps is required for plan.
        let plan = variants(&response_format(1000.0))
            .into_iter()
            .find(|v| v["properties"]["action"]["enum"] == serde_json::json!(["plan"]))
            .unwrap();
        assert_eq!(plan["required"], serde_json::json!(["action", "steps"]));
        assert!(plan["properties"].get("reason").is_some());
        assert!(plan["properties"].get("text").is_none());
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
        assert!(parse_response(&choice, "")
            .unwrap_err()
            .contains("output token limit"));
        choice.finish_reason = Some("content_filter".into());
        assert!(parse_response(&choice, "")
            .unwrap_err()
            .contains("filtered"));
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
