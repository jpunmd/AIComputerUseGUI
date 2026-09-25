use serde::Serialize;

/// Only native stale-screen checks may request automatic re-observation.
/// Ordinary failures (including denied/expired approval) remain terminal.
#[derive(Debug, Serialize, thiserror::Error)]
#[error("{message}")]
pub struct ControlError {
    pub code: &'static str,
    pub message: String,
    pub input_may_have_been_sent: bool,
}

impl ControlError {
    pub fn screen_changed(message: impl Into<String>) -> Self {
        Self {
            code: "screen_changed",
            message: message.into(),
            input_may_have_been_sent: false,
        }
    }

    pub fn after_input_attempt(mut self) -> Self {
        // A guard can reject the second click, a typing chunk, or a drag after
        // some input was sent. Never tell the model to replay it blindly.
        self.input_may_have_been_sent = true;
        self
    }
}

impl From<String> for ControlError {
    fn from(message: String) -> Self {
        Self {
            code: "action_rejected",
            message,
            input_may_have_been_sent: false,
        }
    }
}

impl From<&str> for ControlError {
    fn from(message: &str) -> Self {
        message.to_owned().into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_metadata_is_explicit_and_preserves_possible_partial_input() {
        let changed = ControlError::screen_changed("Window moved");
        let wire = serde_json::to_value(&changed).unwrap();
        assert_eq!(wire["code"], "screen_changed");
        assert_eq!(wire["input_may_have_been_sent"], false);
        let wire = serde_json::to_value(changed.after_input_attempt()).unwrap();
        assert_eq!(wire["input_may_have_been_sent"], true);
        // Error text alone cannot authorize a retry.
        let rejected =
            ControlError::from("Target window changed since the screenshot; capture again");
        assert_eq!(rejected.code, "action_rejected");
        assert_eq!(ControlError::from("Run stopped").code, "action_rejected");
    }
}
