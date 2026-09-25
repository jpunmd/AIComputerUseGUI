use crate::types::ActionResult;

pub const MAX_TEXT_BYTES: usize = 8192;

pub fn validate(
    action: &ActionResult,
    coordinate_base: f64,
    allow_box: bool,
) -> Result<(), String> {
    if let Some(progress) = &action.progress {
        validate_progress(progress)?;
    }
    if let Some(screen) = action.report.as_ref().and_then(|r| r.screen.as_deref()) {
        if screen.trim().is_empty() || screen.chars().count() > 500 || screen.contains('\0') {
            return Err("Invalid or oversized screen description".into());
        }
    }
    if !coordinate_base.is_finite() || coordinate_base <= 0.0 || coordinate_base > 10000.0 {
        return Err("Invalid coordinate base".into());
    }
    let args = &action.arguments;
    let point = |value: Option<&Vec<f64>>, box_allowed: bool| -> Result<(), String> {
        let p = value.ok_or("Missing coordinate")?;
        if p.len() != 2 && !(box_allowed && p.len() == 4) {
            return Err("Expected exactly two coordinates (or four for a bounding box)".into());
        }
        if p.iter()
            .any(|v| !v.is_finite() || *v < 0.0 || *v > coordinate_base)
        {
            return Err(
                "Coordinates must be finite and within the model's coordinate range".into(),
            );
        }
        if p.len() == 4 && (p[0] > p[2] || p[1] > p[3]) {
            return Err("Bounding box corners are reversed".into());
        }
        Ok(())
    };
    if args
        .text
        .as_ref()
        .is_some_and(|s| s.len() > MAX_TEXT_BYTES || s.contains('\0'))
    {
        return Err("Text is too long or contains a null character".into());
    }
    match action.action.as_str() {
        "click" | "left_click" | "right_click" | "double_click" => {
            point(args.coordinate.as_ref(), allow_box)?
        }
        "left_click_drag" => {
            point(args.start_coordinate.as_ref(), false)?;
            point(args.end_coordinate.as_ref(), false)?;
        }
        "type" | "confirm" | "done" | "plan" => {
            if args.text.as_ref().is_none_or(|s| s.trim().is_empty()) {
                return Err(
                    "This action requires text (done must describe completion evidence)".into(),
                );
            }
        }
        "key" => {
            let key = args.key.as_ref().ok_or("Missing key")?;
            if key.is_empty() || key.len() > 64 || key.split('+').count() > 5 {
                return Err("Invalid key sequence".into());
            }
        }
        "scroll" => {
            point(args.coordinate.as_ref(), false)?;
            if !matches!(
                args.direction.as_deref(),
                Some("up" | "down" | "left" | "right")
            ) {
                return Err("Scroll direction must be up, down, left, or right".into());
            }
            if !(1..=50).contains(&args.amount.unwrap_or(5)) {
                return Err("Scroll amount must be between 1 and 50".into());
            }
        }
        "wait" | "screenshot" | "none" => {}
        _ => return Err("Unsupported computer action".into()),
    }
    // Do not silently ignore contradictory arguments from malformed model output.
    if (args.coordinate.is_some()
        && !matches!(
            action.action.as_str(),
            "click" | "left_click" | "right_click" | "double_click" | "scroll"
        ))
        || (args.key.is_some() && action.action != "key")
        || ((args.start_coordinate.is_some() || args.end_coordinate.is_some())
            && action.action != "left_click_drag")
        || ((args.amount.is_some() || args.direction.is_some()) && action.action != "scroll")
        || (args.text.is_some()
            && !matches!(
                action.action.as_str(),
                "type" | "confirm" | "done" | "none" | "plan"
            ))
    {
        return Err("Arguments do not match the action type".into());
    }
    Ok(())
}

/// Models often put a description in `text` on clicks and key presses. Text is
/// only an input for the text actions, so elsewhere it is commentary: dropping
/// it can only remove input, never add or redirect it. Other contradictory
/// fields (a coordinate on a key press, etc.) are still rejected by `validate`.
pub fn drop_commentary_text(action: &mut ActionResult) {
    if !matches!(
        action.action.as_str(),
        "type" | "confirm" | "done" | "none" | "plan"
    ) {
        action.arguments.text = None;
    }
}

pub fn is_mutating(action: &ActionResult) -> bool {
    matches!(
        action.action.as_str(),
        "click"
            | "left_click"
            | "right_click"
            | "double_click"
            | "left_click_drag"
            | "type"
            | "key"
            | "scroll"
    )
}

pub fn pixel(value: f64, base: f64, size: u32, origin: i32) -> i32 {
    origin + (value / base * size.saturating_sub(1) as f64).round() as i32
}

fn validate_progress(progress: &crate::types::TaskProgress) -> Result<(), String> {
    use crate::types::NoteKind;
    let text = |value: &str, max: usize| {
        if value.trim().is_empty() || value.chars().count() > max || value.contains('\0') {
            Err("Invalid or oversized task progress text".to_string())
        } else {
            Ok(())
        }
    };
    if let Some(rows) = &progress.milestones {
        if rows.len() > 7 {
            return Err("Too many milestone updates".into());
        }
        for row in rows {
            text(&row.id, 40)?;
            text(&row.evidence, 500)?;
        }
    }
    if let Some(outcome) = &progress.outcome {
        text(&outcome.evidence, 500)?;
    }
    if let Some(notes) = &progress.notes {
        if notes.len() > 6 {
            return Err("Too many memory notes".into());
        }
        for note in notes {
            text(&note.text, 400)?;
            if let Some(id) = &note.id {
                text(id, 40)?;
            }
            match &note.evidence {
                Some(evidence) => text(evidence, 500)?,
                None if note.kind == NoteKind::Question => (),
                None => return Err("Memory facts require observed evidence".into()),
            }
        }
    }
    if let Some(ids) = &progress.resolve_questions {
        if ids.len() > 6 {
            return Err("Too many question resolutions".into());
        }
        for resolution in ids {
            text(&resolution.id, 40)?;
            text(&resolution.answer, 400)?;
            text(&resolution.evidence, 500)?;
        }
    }
    if let Some(id) = &progress.next_milestone_id {
        text(id, 40)?;
    }
    if let Some(expected) = &progress.expected_outcome {
        text(expected, 400)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn action(value: serde_json::Value) -> ActionResult {
        serde_json::from_value(value).unwrap()
    }
    #[test]
    fn rejects_invalid_input_without_touching_os() {
        for value in [
            serde_json::json!({"action":"click","arguments":{"coordinate":[1001,5]}}),
            serde_json::json!({"action":"click","arguments":{"coordinate":[1]}}),
            serde_json::json!({"action":"scroll","arguments":{"direction":"sideways"}}),
            serde_json::json!({"action":"scroll","arguments":{"direction":"up","amount":-2147483648i64}}),
            serde_json::json!({"action":"type","arguments":{"text":"x".repeat(MAX_TEXT_BYTES+1)}}),
            serde_json::json!({"action":"done","arguments":{}}),
            serde_json::json!({"action":"key","arguments":{"key":"enter","coordinate":[0,0]}}),
        ] {
            assert!(validate(&action(value), 1000.0, false).is_err());
        }
        let click = action(serde_json::json!({"action":"click","arguments":{"coordinate":[0,0]}}));
        for base in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert!(validate(&click, base, false).is_err());
        }
    }
    #[test]
    fn commentary_text_is_dropped_only_from_non_text_actions() {
        let mut key = action(serde_json::json!({"action":"key","arguments":{"key":"Escape","text":"Dismiss the dropdown"}}));
        assert!(validate(&key, 1000.0, false).is_err());
        drop_commentary_text(&mut key);
        assert_eq!(key.arguments.text, None);
        assert!(validate(&key, 1000.0, false).is_ok());
        let mut typed = action(serde_json::json!({"action":"type","arguments":{"text":"weather"}}));
        drop_commentary_text(&mut typed);
        assert_eq!(typed.arguments.text.as_deref(), Some("weather"));
        let mut mixed = action(serde_json::json!({"action":"key","arguments":{"key":"enter","coordinate":[0,0],"text":"x"}}));
        drop_commentary_text(&mut mixed);
        assert!(validate(&mixed, 1000.0, false).is_err());
    }
    #[test]
    fn pixels_include_monitor_origin_and_remain_inside_display() {
        assert_eq!(pixel(0.0, 1000.0, 1920, -1920), -1920);
        assert_eq!(pixel(1000.0, 1000.0, 1920, -1920), -1);
        assert_eq!(pixel(1000.0, 1000.0, 1920, 0), 1919);
    }
    #[test]
    fn bounding_boxes_must_be_collapsed_before_execution() {
        let a = action(
            serde_json::json!({"action":"click","arguments":{"coordinate":[100,200,300,400]}}),
        );
        assert!(validate(&a, 1000.0, true).is_ok());
        assert!(validate(&a, 1000.0, false).is_err());
    }
}
