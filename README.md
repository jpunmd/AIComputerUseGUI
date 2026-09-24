# AI Computer Use Agent

A Windows Tauri application that lets a local vision-language model propose and execute mouse and keyboard actions. It connects to an OpenAI-compatible `/v1/chat/completions` server. Use a model that accepts images and follows the computer-action format in Settings; text-only models cannot ground clicks from screenshots.

## Getting started

Requirements: Windows, Node.js 22.13+ (or 24 LTS), stable Rust, Microsoft C++ build tools, and WebView2. See [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/).

```powershell
npm ci
npm run tauri dev
```

Build for production with `npm run tauri build`.

1. Start your local vision model server. In Settings, enter its API base URL (such as `http://localhost:8000/v1`) and the exact model ID exposed by that server.
2. Test the connection. Put the target application on the **primary monitor** and keep its controls visible beside this controller.
3. Enter a task with clear completion criteria. Planning is enabled by default. Select **Plan only** to inspect milestones before any input executes.
4. With **Review each action** enabled, choose **Allow once** for one action or **Allow for this task** to let the remaining mouse/keyboard actions run automatically. The dialog previews the proposed click. An unanswered proposal expires after 60 seconds.
5. Use **Continue task** to resume with a fresh screenshot and the original goal. Restoring a session never restores permission to execute.
6. Press **Stop**, or **Ctrl+Alt+F12** even while another application has focus, to cancel. Cancellation cannot undo input already delivered to Windows.

Every submitted task plans, acts, observes, and continues up to the configured turn limit (maximum 100) or 20 minutes. There is no separate execution-mode switch. Clearing **Review each action** before starting, or choosing **Allow for this task** during a run, enables direct control until that run ends. New or resumed runs start with reviewed control unless explicitly changed. Model questions still pause for an answer. Debug mode retains a read-only **Dry run** preview; it cannot execute its predicted action or change the task checkpoint.

Enable **Precision clicks** in the task toolbar to check each click in a magnified crop before submitting input. It is on by default for new settings; previously saved choices are preserved. The crop comes from the same native screenshot as the initial prediction, and targets are identified using the goal, milestone and expected result. Only the corrected click is executed. The crop is not overlaid with a reticle that could distract the model. This helps with small icons but cannot guarantee model accuracy.

## Staying on task

- The original goal and up to seven milestones stay in every multi-turn request. Each milestone has a stable ID, observable success condition, status (pending, in progress, completed, or blocked), input count, and evidence from a numbered screen observation.
- The model supplies compact progress updates alongside its next action, using the same inference request. Input receipts remain unverified until a later observation reports success, failure, or uncertainty. The controller requires that review before another input action.
- Durable memory keeps model-extracted facts, exact paths/values, failed approaches, and open questions. Each note records its evidence and source step. Known notes can be updated and answered questions resolved by ID. New tasks clear this memory; Continue and saved checkpoints retain it.
- Memory is bounded to 16 notes / 8,000 text-and-evidence characters, eight input receipts, and five plan revisions. Paths and unresolved questions receive priority during compaction. The task prompt is capped at 32,000 JavaScript string characters, preserving the original goal, plan, current request, and latest receipt. At most six recent conversation turns / 24,000 characters are supplied separately. Only the current screenshot is sent.
- Two reported failures on the same milestone, or three identical consecutive action/screenshot pairs, trigger one plan revision before further input. A revision must explain the changed approach and preserve completed milestones. Continued lack of progress pauses the run. Turn/time limits still apply.
- A `done` claim cannot complete a task with unfinished milestones, open questions, or unreviewed input. Once those are resolved, completion requires a second `done` decision against a new screen. This is model judgment, not independent proof of success.
- The expandable task panel shows milestone statuses, success conditions, evidence, durable notes, and recent input results. Legacy text-only plans load as pending milestones; old execution summaries are treated as unverified history.

See [task progress and memory protocol](docs/task-memory.md) for examples, migration behavior, and limits.

## Control and privacy

This sends real input to the host desktop. Test in a disposable Windows account or VM and supervise it. Screen text can contain malicious instructions; prompting and action validation do not solve prompt injection.

Rust validates action names, argument shapes, coordinates, text lengths, key combinations, and scroll limits. Proposals are bound to the current run and observation. Approvals are single-use; stale/replaced runs and this controller's window are rejected. Monitor geometry and target window identity/position are checked before input. These checks do not detect every content change inside an unchanged window.

Screenshots and task text go to the configured model server. A loopback endpoint keeps that traffic on this machine; a LAN or remote endpoint sends it elsewhere. HTTP redirects are disabled. Choose an endpoint you trust. Local IndexedDB history is unencrypted. Screenshot persistence defaults off for new settings; existing saved preferences are retained. Exports may contain sensitive text and optional images. Debug logs contain operational metadata, not prompts or typed text.

Click the intended target before typing or pressing keys. If it changes or becomes obscured during approval, resume from a fresh screen. Protected input execution currently supports Windows only.

## Settings

| Setting | Purpose |
| --- | --- |
| API endpoint / model ID | Local or explicitly chosen remote vision server |
| System prompt | Editable instructions; mandatory execution rules are appended |
| Plan Before Acting | Generate milestones before a new multi-turn task |
| Thinking mode | Show returned reasoning separately; reasoning is never executed or replayed |
| Screenshot Max Dimension | Resize the primary screen image (256–3840 pixels) |
| Precision clicks / box mode | Check a magnified crop of the same observation; inconclusive refinement stops execution |
| Action Delay / Max Turns | Allow UI changes and bound the loop |
| Save Screenshots in Sessions | Include images in saved/exported history; off by default |

Coordinates use a 0–1000 grid mapped to the detected primary monitor, including its desktop offset.

## Model protocol

The final answer must contain exactly one complete computer tool call:

```xml
<tool_call>{"name":"computer","arguments":{"action":"left_click","coordinate":[500,400]}}</tool_call>
```

One OpenAI-style `message.tool_calls` function result named `computer` is also accepted, including null `content`. The client uses prompt-defined actions rather than requiring tool-schema constrained generation. Multiple calls, unknown tools, malformed/truncated output, and actions only in reasoning are rejected. Plain text needs user attention and never implies completion.

| Action | Arguments |
| --- | --- |
| `click`, `left_click`, `right_click`, `double_click` | `coordinate: [x,y]` |
| `left_click_drag` | `start_coordinate`, `end_coordinate` |
| `scroll` | `coordinate`, `direction: up/down/left/right`, optional `amount` (1–50) |
| `type` | `text` (up to 8 KiB UTF-8) |
| `key` | `key`, such as `ctrl+s` |
| `wait`, `screenshot` | No arguments |
| `plan` | `text`: JSON containing `steps` with `title` and `success_criteria`; revised plans also require `reason` and retained milestone IDs. Legacy newline plans remain accepted. |
| `confirm` | `text`: a question; does not authorize subsequent input itself |
| `done` | `text`: observed completion evidence |

## Verification and dependencies

```powershell
npm test
npm run build
npm audit
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml --lib --locked
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
cargo audit --file src-tauri/Cargo.lock
```

Install the audit tool with `cargo install cargo-audit --locked` if needed. Windows CI runs these checks and builds the executable. Regression tests never send live desktop input. To check capture geometry on an interactive desktop, run `cargo test --manifest-path src-tauri/Cargo.toml capture_primary_monitor_smoke -- --ignored`; it captures in memory without sending input or saving the image.

An optional local-model test checks point and box refinement against a synthetic taskbar image. It starts with a deliberately high estimate and verifies that the corrected point falls inside the target icon. No desktop input is sent:

```powershell
$env:VISION_TEST_ENDPOINT = 'http://127.0.0.1:8889/v1'
cargo test --manifest-path src-tauri/Cargo.toml local_vision_precision_probe -- --ignored --nocapture
```

Dependency updates replace `screenshots` with `xcap`, remove the unused shell plugin and unnecessary image decoders, and refresh both lockfiles. See [SECURITY.md](SECURITY.md) for remaining upstream warnings and validation limits.

## License

This project is distributed under the [Software License Agreement](LICENSE), including the commercial-use thresholds in Section 4 and disclaimer in Section 7.
