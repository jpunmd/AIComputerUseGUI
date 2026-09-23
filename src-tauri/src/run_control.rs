use crate::{
    screenshot::ScreenGeometry, types::ActionResult, validation, window_guard::WindowTarget,
};
use serde::Serialize;
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Clone)]
pub struct Observation {
    pub id: String,
    pub geometry: ScreenGeometry,
    pub foreground: Option<WindowTarget>,
    pub windows: Vec<WindowTarget>,
    pub captured_at: Instant,
}

pub struct PreparedAction {
    pub id: String,
    pub action: ActionResult,
    pub observation: Observation,
    pub target: Option<WindowTarget>,
    pub approved: bool,
    pub created_at: Instant,
}

struct Run {
    id: String,
    cancel: CancellationToken,
    supervised: bool,
    observation: Option<Observation>,
    pending: Option<PreparedAction>,
}

#[derive(Default)]
pub struct RunControl {
    run: Mutex<Option<Run>>,
    pub execution: Mutex<()>,
}

#[derive(Serialize)]
pub struct Proposal {
    pub id: String,
    pub action: ActionResult,
    pub requires_approval: bool,
}

impl RunControl {
    pub fn begin(&self, supervised: bool) -> Result<String, String> {
        let mut current = self.run.lock().map_err(|_| "Run state unavailable")?;
        if let Some(run) = current.as_ref() {
            run.cancel.cancel();
        }
        let id = Uuid::new_v4().to_string();
        *current = Some(Run {
            id: id.clone(),
            cancel: CancellationToken::new(),
            supervised,
            observation: None,
            pending: None,
        });
        Ok(id)
    }

    pub fn token(&self, id: &str) -> Result<CancellationToken, String> {
        let current = self.run.lock().map_err(|_| "Run state unavailable")?;
        let run = current
            .as_ref()
            .filter(|r| r.id == id && !r.cancel.is_cancelled())
            .ok_or("Run stopped or replaced")?;
        Ok(run.cancel.clone())
    }

    pub fn stop(&self, id: Option<&str>) {
        if let Ok(mut current) = self.run.lock() {
            if let Some(run) = current.as_mut().filter(|r| id.is_none_or(|id| r.id == id)) {
                run.cancel.cancel();
                run.pending = None;
                run.observation = None;
            }
        }
    }

    pub fn observe(
        &self,
        id: &str,
        geometry: ScreenGeometry,
        foreground: Option<WindowTarget>,
        windows: Vec<WindowTarget>,
    ) -> Result<String, String> {
        let mut current = self.run.lock().map_err(|_| "Run state unavailable")?;
        let run = current
            .as_mut()
            .filter(|r| r.id == id && !r.cancel.is_cancelled())
            .ok_or("Run stopped or replaced")?;
        let observation_id = Uuid::new_v4().to_string();
        run.observation = Some(Observation {
            id: observation_id.clone(),
            geometry,
            foreground,
            windows,
            captured_at: Instant::now(),
        });
        run.pending = None; // New observations invalidate old proposals and approvals.
        Ok(observation_id)
    }

    pub fn observation(&self, id: &str, observation_id: &str) -> Result<Observation, String> {
        let current = self.run.lock().map_err(|_| "Run state unavailable")?;
        let run = current
            .as_ref()
            .filter(|r| r.id == id && !r.cancel.is_cancelled())
            .ok_or("Run stopped or replaced")?;
        run.observation
            .as_ref()
            .filter(|o| {
                o.id == observation_id && o.captured_at.elapsed() < Duration::from_secs(600)
            })
            .cloned()
            .ok_or_else(|| "Observation expired; capture the screen again".into())
    }

    pub fn prepare(
        &self,
        id: &str,
        action: ActionResult,
        observation: Observation,
        target: Option<WindowTarget>,
    ) -> Result<Proposal, String> {
        validation::validate(&action, 1000.0, false)?;
        let mut current = self.run.lock().map_err(|_| "Run state unavailable")?;
        let run = current
            .as_mut()
            .filter(|r| r.id == id && !r.cancel.is_cancelled())
            .ok_or("Run stopped or replaced")?;
        if run
            .observation
            .as_ref()
            .is_none_or(|o| o.id != observation.id)
        {
            return Err("Observation changed".into());
        }
        let requires_approval = run.supervised && validation::is_mutating(&action);
        let proposal_id = Uuid::new_v4().to_string();
        let proposal = Proposal {
            id: proposal_id.clone(),
            action: action.clone(),
            requires_approval,
        };
        run.pending = Some(PreparedAction {
            id: proposal_id,
            action,
            observation,
            target,
            approved: !requires_approval,
            created_at: Instant::now(),
        });
        Ok(proposal)
    }

    pub fn approve(&self, id: &str, proposal_id: &str) -> Result<(), String> {
        let mut current = self.run.lock().map_err(|_| "Run state unavailable")?;
        let pending = current
            .as_mut()
            .filter(|r| r.id == id && !r.cancel.is_cancelled())
            .and_then(|r| r.pending.as_mut())
            .filter(|p| p.id == proposal_id && p.created_at.elapsed() < Duration::from_secs(60))
            .ok_or("Approval expired or run stopped")?;
        pending.approved = true;
        Ok(())
    }

    pub fn take(
        &self,
        id: &str,
        proposal_id: &str,
    ) -> Result<(PreparedAction, CancellationToken), String> {
        let mut current = self.run.lock().map_err(|_| "Run state unavailable")?;
        let run = current
            .as_mut()
            .filter(|r| r.id == id && !r.cancel.is_cancelled())
            .ok_or("Run stopped or replaced")?;
        let pending = run
            .pending
            .as_ref()
            .filter(|p| {
                p.id == proposal_id
                    && p.approved
                    && p.created_at.elapsed() < Duration::from_secs(60)
            })
            .ok_or("Action requires a current, matching approval")?;
        if pending.observation.captured_at.elapsed() >= Duration::from_secs(600) {
            return Err("Observation expired".into());
        }
        Ok((
            run.pending.take().ok_or("Action already consumed")?,
            run.cancel.clone(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn setup() -> (RunControl, String, Observation, ActionResult) {
        let control = RunControl::default();
        let run = control.begin(true).unwrap();
        let obs = control
            .observe(
                &run,
                ScreenGeometry {
                    id: 1,
                    width: 100,
                    height: 100,
                    x: 0,
                    y: 0,
                },
                None,
                vec![],
            )
            .unwrap();
        let observation = control.observation(&run, &obs).unwrap();
        let action =
            serde_json::from_value(serde_json::json!({"action":"key","arguments":{"key":"enter"}}))
                .unwrap();
        (control, run, observation, action)
    }
    #[test]
    fn mutation_requires_exact_single_use_approval() {
        let (c, r, o, a) = setup();
        let p = c.prepare(&r, a, o, None).unwrap();
        assert!(p.requires_approval);
        assert!(c.take(&r, &p.id).is_err());
        assert!(c.approve(&r, "wrong-id").is_err());
        c.approve(&r, &p.id).unwrap();
        assert!(c.take(&r, &p.id).is_ok());
        assert!(c.take(&r, &p.id).is_err());
    }
    #[test]
    fn replacing_action_or_observation_revokes_approval() {
        let (c, r, o, a) = setup();
        let p = c.prepare(&r, a.clone(), o.clone(), None).unwrap();
        c.approve(&r, &p.id).unwrap();
        let next = c.prepare(&r, a, o.clone(), None).unwrap();
        assert!(c.take(&r, &p.id).is_err());
        assert!(c.take(&r, &next.id).is_err());
        c.observe(&r, o.geometry, None, vec![]).unwrap();
        assert!(c.approve(&r, &next.id).is_err());
    }
    #[test]
    fn stop_cancels_before_and_during_requests_and_invalidates_actions() {
        let (c, r, o, a) = setup();
        let token = c.token(&r).unwrap();
        let p = c.prepare(&r, a, o, None).unwrap();
        c.stop(Some(&r));
        assert!(token.is_cancelled());
        assert!(c.token(&r).is_err());
        assert!(c.approve(&r, &p.id).is_err());
        let new_run = c.begin(true).unwrap();
        c.stop(Some(&r)); // Delayed cleanup from an old task cannot stop the new one.
        assert!(!c.token(&new_run).unwrap().is_cancelled());
    }
}
