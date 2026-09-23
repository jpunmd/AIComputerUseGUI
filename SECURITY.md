# Security and validation notes

## Dependency baseline — 2026-09-23

The updated npm lockfile reports **zero vulnerabilities**, including development dependencies. The updated Cargo lockfile reports **zero vulnerability entries** in `cargo audit`. No advisories are suppressed. Rerun audits when installing or updating dependencies.

Cargo still reports seven informational upstream advisories:

| Package | Advisory | Remaining issue |
| --- | --- | --- |
| proc-macro-error 1.0.4 | RUSTSEC-2024-0370 | Unmaintained |
| unic-char-property 0.9.0 | RUSTSEC-2025-0081 | Unmaintained |
| unic-char-range 0.9.0 | RUSTSEC-2025-0075 | Unmaintained |
| unic-common 0.9.0 | RUSTSEC-2025-0080 | Unmaintained |
| unic-ucd-ident 0.9.0 | RUSTSEC-2025-0100 | Unmaintained |
| unic-ucd-version 0.9.0 | RUSTSEC-2025-0098 | Unmaintained |
| glib 0.18.5 | [RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html) | Unsound VariantStrIter implementation in the Linux GTK dependency graph |

These come from the Tauri/GTK dependency graph. The glib fix requires 0.20+, outside the GTK versions currently selected by Tauri; it is not compiled into this Windows target. The warnings remain visible rather than being hidden with audit ignores. Migrating the GTK stack is outside these Windows changes.

## Boundaries

- Rust binds approval/cancellation to a proposal, run, and screen observation. Replacing a run/observation invalidates proposals. Stop cancels pending HTTP requests, approval waits, and future input; already-submitted input cannot be recalled.
- Native execution is serialized. Modifier keys and drag buttons are released on cancellation/error paths. Coordinates, text, key combinations, crop dimensions, history size, and HTTP response size are bounded.
- Window identity, process, rectangle, foreground ownership, and display geometry checks reduce stale-target errors. The controller is excluded as an input target. These checks cannot detect a button changing meaning within the same window.
- The webview has explicit command permissions and restricted production CSP. Rust contacts the selected model endpoint with redirects disabled. Remote endpoints receive screenshots and text.
- Sessions are validated on import/load. Imports are limited to 32 MB, 100 sessions, and 2,000 messages per session. Unknown fields are discarded. Restored tasks are stopped and require a new run/observation. Storage is local and unencrypted.
- Plan text, prior transcripts, and screen text remain untrusted context. Per-action review is default; direct control is an explicit choice for each multi-turn run. This is not an OS sandbox or a guarantee against prompt injection.

## Test coverage and limits

Regression tests cover malformed/multiple/truncated actions, Unicode and quoted braces, null-content tool responses, reasoning isolation, Stop during HTTP and approvals, single-use approvals, replaced runs, moved windows, bounded history, follow-up context, session validation, planning without input, completion re-observation, repeat stopping, and failed zoom refinement.

Automated tests do not validate a particular model's visual grounding or send mouse/keyboard input to real applications. Before relying on a model, manually test disposable tasks, Stop during generation/approval, the emergency shortcut, mixed display scaling, and window movement. Completion is judged by the model against a fresh screenshot, not independently verified through application APIs.
