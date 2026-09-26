# AI Computer Use Agent

A Windows Tauri application that lets a local vision-language model propose and execute mouse and keyboard actions. It connects to an OpenAI-compatible `/v1/chat/completions` server. Use a model that accepts images and follows the computer-action format in Settings; text-only models cannot ground clicks from screenshots.

## Recommended models

| Model | Notes |
| --- | --- |
| **Qwen 3.8** (e.g. 27B) | Main development model, served locally by llama.cpp |
| **Qwen 3.8 Flash-Next** | Faster option for the same workflow |

Use a vision-capable build (with llama.cpp this means loading the model's multimodal projector) behind an OpenAI-compatible `/v1` endpoint, and enter the exact model ID the server reports. The tool call is deliberately flat (no nested objects; a plan is a list of strings) because local models follow that far more reliably than nested bookkeeping. Thinking mode is on by default and its reasoning is shown expanded.

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

Every submitted task plans, acts, observes, and continues up to the configured turn limit (maximum 100) or 20 minutes. There is no separate execution-mode switch. **Review each action** is in the main toolbar and in Settings; both control one saved default for new and resumed runs (on by default). Turning it off enables direct control for every run until it is turned back on; a warning stays visible in the main window while it is off. Choosing **Allow for this task** during a reviewed run enables direct control until that run ends. Model questions still pause for an answer. Debug mode retains a read-only **Dry run** preview; it cannot execute its predicted action or change the task checkpoint.

Enable **Precision clicks** in the task toolbar to check each click in a magnified crop before submitting input. It is off by default because it adds a second model call to every click; turn it on if clicks miss small targets. The crop comes from the same native screenshot as the initial prediction, and targets are identified using the goal, milestone and expected result. Only the corrected click is executed. The crop is not overlaid with a reticle that could distract the model. This helps with small icons but cannot guarantee model accuracy.

## Staying on task

- The original goal and up to seven milestones stay in every multi-turn request. Each milestone has a stable ID, observable success condition, status (pending, in progress, completed, or blocked), input count, and evidence from a numbered screen observation.
- The model adds up to three flat fields to its next action in the same inference request: `screen`, `last_action` and `step_done`. The controller turns them into milestone and input-outcome records. An input stays unverified until a later screenshot is reviewed; if the model does not say whether it worked, it is recorded as uncertain rather than blocking the next action.
- Durable memory keeps failed approaches (failed actions, controller interruptions, and blocks), each with its evidence and source step. The three most recent are shown to the model. New tasks clear this memory; Continue and saved checkpoints retain it.
- Memory is bounded to 16 notes / 8,000 text-and-evidence characters, eight input receipts, and five plan revisions. Whole notes are compacted, oldest first. The task prompt is capped at 32,000 JavaScript string characters, preserving the original goal, plan, current request, and latest receipt. At most six recent conversation turns / 24,000 characters are supplied separately. Only the current screenshot is sent.
- Two reported failures on the same milestone, or three identical consecutive action/screenshot pairs, trigger one plan revision before further input. A revision lists only the remaining work, with a reason; finished milestones are kept automatically. Continued lack of progress pauses the run. Turn/time limits still apply.
- When a window, focus, or display change invalidates a proposed action, the agent waits briefly, takes a new screenshot, and chooses a new action automatically. It can recover from Task View or a window switch without losing its goal or task permission. Possible partial input is reviewed before further input; stale coordinates are never replayed. Recovery allows three consecutive retries and six total per run before pausing. **Allow once** still applies only to its original proposal.
- A `done` claim completes the remaining milestones unless the last action failed, but never finishes the task by itself: completion requires a second `done` decision against a new screen, with no unreviewed input. This is model judgment, not independent proof of success.
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
| Thinking mode | On by default, shown expanded. Reasoning is displayed separately and never executed or replayed |
| Screenshot Max Dimension | Longest side of the image sent to the model (256–3840 pixels). Default and recommended: 1920 (1080p) |
| Precision clicks / box mode | Off by default. Check a magnified crop of the same observation; inconclusive refinement stops execution |
| Action Delay / Max Turns | Allow UI changes and bound the loop |
| Save Screenshots in Sessions | Include images in saved/exported history; off by default |

New defaults apply to fresh installs and to **Reset to Defaults** in Settings; previously saved settings keep their values.

Coordinates use a 0–1000 grid mapped to the detected primary monitor, including its desktop offset.

### Screen resolution and 4K monitors

The recommended screenshot size is **1080p** (Screenshot Max Dimension 1920). The screen is captured at full native resolution and then downscaled so its longest side is 1920 pixels. A 4K (3840×2160) monitor becomes exactly 1920×1080, a clean 2:1 reduction.

Downscaling does not affect where clicks land. The model answers in the 0–1000 grid, and the app maps that grid onto the monitor's full pixel area. The screenshot and the click mapping use the same monitor geometry, and a capture whose size does not match it is refused rather than risking a misplaced click. Windows display scaling therefore does not shift clicks.

What 4K changes is detail. With Windows scaling at 150–200% (typical for 4K), text and icons stay readable at 1080p. At 100% scaling, UI elements become about half their usual size in the screenshot. If small targets are missed, raise the setting to 2560 (more tokens, slower) or enable **Precision clicks**, which re-checks each click on a crop taken from the full-resolution capture.

## Model protocol

The client requests schema-constrained JSON through `response_format: {"type":"json_schema", ...}`. The API decoder schema and prompt tool definition share `src/agent/computer-tool.json`. The final answer must contain exactly one computer action:

```json
{"name":"computer","arguments":{"action":"left_click","coordinate":[500,400]}}
```

If the server explicitly rejects structured output as unsupported (HTTP 400/422), the client retries once with its original prompt and displays a compatibility notice. This fallback also accepts a JSON action wrapped in `<tool_call>...</tool_call>`. Other HTTP errors and invalid model responses do not disable the schema. Server support determines whether generation is constrained; every response still passes local validation before input can be proposed.

One OpenAI-style `message.tool_calls` function result named `computer` is also accepted, including null `content`. Multiple calls, unknown tools, malformed/truncated output, and actions only in reasoning are rejected. Rejection messages include the specific validation error and retain the rejected output for inspection. The agent gets two format-correction attempts. A `text` field on an action that does not type (for example a description on a click or key press) is discarded as commentary instead of rejecting the response. Plain text needs user attention and never implies completion; under constrained output the model finishes with `action: "done"` (answer in `text`) and uses `action: "none"` with `text` when it cannot continue.

Every field sits directly in `arguments`. Any action may add three optional fields: `screen` (one sentence about the current screenshot), `last_action` (`worked`, `failed` or `unclear`) and `step_done` (the current plan step's success condition is visible). The controller turns these into milestone and outcome records, and owns all milestone IDs. An omitted `last_action` is recorded as uncertain, so it never blocks the next action. `step_done` completes the current step unless the last action failed. `done` completes the remaining steps, and the controller still confirms completion on a fresh screenshot.

```json
{"name":"computer","arguments":{"action":"type","text":"weather Philadelphia","screen":"Chrome address bar is focused","last_action":"worked","step_done":true}}
{"name":"computer","arguments":{"action":"plan","steps":["Open Chrome -> a Chrome window is visible","Search for weather Philadelphia -> the forecast is shown"]}}
```

| Action | Arguments |
| --- | --- |
| `click`, `left_click`, `right_click`, `double_click` | `coordinate: [x,y]` |
| `left_click_drag` | `start_coordinate`, `end_coordinate` |
| `scroll` | `coordinate`, `direction: up/down/left/right`, optional `amount` (1–50) |
| `type` | `text` (up to 8 KiB UTF-8) |
| `key` | `key`, such as `ctrl+s` |
| `wait`, `screenshot` | No arguments |
| `plan` | `steps`: one to seven strings, each `what to do -> what will be visible when it worked` (without an arrow the step doubles as its own success condition). To revise, send `reason` and only the remaining steps; finished steps are kept. A step list written as lines of `text` is also accepted. |
| `confirm` | `text`: a question; does not authorize subsequent input itself |
| `done` | `text`: the answer or result for the user, with observed completion evidence. Answers to questions go here, not in `none`. |
| `none` | `text`: why the model cannot continue, or what it needs from the user |

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
