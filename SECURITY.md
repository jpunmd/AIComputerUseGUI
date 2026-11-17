# Security and validation notes

## Dependency baseline — 2026-11-16

The updated npm lockfile reports **zero vulnerabilities**, including development dependencies. The updated Cargo lockfile reports **zero vulnerability entries** in `cargo audit`. No advisories are suppressed. Rerun audits when installing or updating dependencies.

This baseline includes patch updates for advisories published since September: rustls 0.23.46, rustls-webpki 0.103.17, tokio 1.54.1 and rustix 1.1.6 in Cargo, and vite, vitest, undici, postcss-selector-parser and source-map-js through `npm audit fix`. API-key storage added no dependencies; it uses the Windows credential API through the existing `windows-sys` crate.

Cargo still reports ten informational upstream advisories:

| Package | Advisory | Remaining issue |
| --- | --- | --- |
| proc-macro-error 1.0.4 | RUSTSEC-2024-0370 | Unmaintained |
| unic-char-property 0.9.0 | RUSTSEC-2025-0081 | Unmaintained |
| unic-char-range 0.9.0 | RUSTSEC-2025-0075 | Unmaintained |
| unic-common 0.9.0 | RUSTSEC-2025-0080 | Unmaintained |
| unic-ucd-ident 0.9.0 | RUSTSEC-2025-0100 | Unmaintained |
| unic-ucd-version 0.9.0 | RUSTSEC-2025-0098 | Unmaintained |
| zbus_names 4.3.4 | RUSTSEC-2026-0371 | Unmaintained |
| zvariant 5.15.0 | RUSTSEC-2026-0370 | Unmaintained |
| zvariant_derive 5.15.0 | RUSTSEC-2026-0372 | Unmaintained |
| glib 0.18.5 | [RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html) | Unsound VariantStrIter implementation in the Linux GTK dependency graph |

These come from the Tauri dependency graph, mostly its Linux GTK and D-Bus backends. The glib fix requires 0.20+, outside the GTK versions currently selected by Tauri; it is not compiled into this Windows target. The warnings remain visible rather than being hidden with audit ignores. Migrating the GTK stack is outside these Windows changes.

## Boundaries

- Rust binds approval/cancellation to a proposal, run, and screen observation. Replacing a run/observation invalidates proposals. Stop cancels pending HTTP requests, approval waits, and future input; already-submitted input cannot be recalled.
- Native execution is serialized. Modifier keys and drag buttons are released on cancellation/error paths. Coordinates, text, key combinations, crop dimensions, history size, and HTTP response size are bounded.
- Window identity, process, rectangle, foreground ownership, and display geometry checks reduce stale-target errors. The controller is excluded as an input target. These checks cannot detect a button changing meaning within the same window.
- A small allowlist of shell chords (`win`, `win+d`, `win+e`, `win+r`, `win+s`) needs no captured target window, because Windows routes them to the shell whatever has focus. They still require approval in supervised runs, and the window that later receives typing is checked as usual. When a run starts while the controller has focus, the controller hands focus back to the last ordinary application window the user used; it never targets the taskbar or tool windows.
- Native stale-screen rejections trigger a fresh observation and model decision after a short settling delay, with at most three consecutive retries and six total per run. The original proposal is never replayed. Possible partial input requires an outcome review before more input. Recovery retains task-scoped permission, but never transfers an Allow once grant to a new proposal. A proposal rejected before any input is sent (an invalid key, no focused target, or a point on the controller) goes back to the model for a different action, at most twice in a row. Denied/expired approvals, rejections after input may have been sent, and ordinary execution failures still pause. Stop and the time limit apply during recovery.
- The webview has explicit command permissions and restricted production CSP. Rust contacts the selected model endpoint with redirects disabled. Remote endpoints receive screenshots and text.
- API keys are stored in Windows Credential Manager (generic credential, local-machine persistence, protected by the user's Windows logon) under the endpoint's origin. They are not in settings, sessions, exports or debug output. The webview can save, remove and test for a key; no command returns one, and the model configuration it sends cannot carry one (the field is skipped on deserialization and filled from the store in Rust). A key is attached only to requests for the origin it was saved under, only over HTTPS or to a loopback/private address, and its header is marked sensitive. Keys are limited to 512 printable ASCII characters, which rules out header injection. Server error text is scrubbed of the key before it is returned. The provider (and so the header and request shape) is derived from the exact endpoint host, not from a separate setting.
- What this does not protect against: other software running as the same Windows user can read Credential Manager entries, and the key is briefly present in webview and process memory while it is typed and used. A hosted provider sees every screenshot sent to it.
- Sessions are validated on import/load. Imports are limited to 32 MB, 100 sessions, and 2,000 messages per session. Unknown fields are discarded. Restored tasks are stopped and require a new run/observation. Storage is local and unencrypted.
- Plan text, prior transcripts, and screen text remain untrusted context. Per-action review is the default; direct control is an explicit, saved user setting (toolbar or Settings) that stays visibly flagged while off. **Allow for this task** requires a current, unexpired proposal and changes only that native run's supervision flag. Stop, completion and resumed/new runs do not inherit that grant. Model output and imported sessions cannot set it. This is not an OS sandbox or a guarantee against prompt injection.
- Precision targeting uses an in-memory native capture tied to the current observation. Both model passes see the same frame, and only the final corrected coordinate is prepared for execution. The image is released when the run/observation is replaced or stopped; the native capture is not added to saved sessions.
- The model's flat report (`screen`, `last_action`, `step_done`) and plan steps are model-authored metadata. They cannot change the pinned user goal or grant approval. The controller derives milestone and outcome records from them and owns all IDs; Rust rejects unknown fields/types, rejects plan fields on any other action, and bounds payloads. Reports are removed before action preparation, and the native command rejects proposals that still contain one.
- Milestone completion and memory facts are attributed to model observations, never inferred from successful OS input submission. Saved evidence is historical and may be stale. Imported checkpoints do not independently prove their claimed facts; resuming always takes a new screenshot.

## Test coverage and limits

Regression tests cover API-key handling (origin binding, the HTTPS/private-network rule, key validation, bearer and `x-api-key` headers, redaction from errors and debug output, keys never entering settings), provider request shapes, malformed/multiple/truncated actions, Unicode and quoted braces, null-content tool responses, reasoning isolation, Stop during HTTP and approvals, single-use approvals, replaced runs, moved windows, bounded history, follow-up context, session validation, planning without input, completion re-observation, repeat stopping, failed zoom refinement, bounded correction of rejected proposals, the shell-chord allowlist, and action/model-call/time limits.

Task-memory regressions also cover evidence-linked milestone updates, blocked completion, bounded failure retention, atomic rejection of invalid updates, completed-work preservation during replanning, legacy checkpoint migration, late progress after Stop, and separation of memory from executable proposals.

Regression tests do not send mouse/keyboard input to real applications. An opt-in `local_vision_precision_probe` uses a synthetic taskbar image and an explicitly configured local model to check that refinement corrects a deliberately high estimate. It is not a complete visual-grounding evaluation. Before relying on a model, manually test disposable tasks, Stop during generation/approval, the emergency shortcut, mixed display scaling, and window movement. Completion is judged by the model against a fresh screenshot, not independently verified through application APIs.
