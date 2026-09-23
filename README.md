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
4. Leave **Review each action** enabled. Approve or deny proposed mouse/keyboard actions. Each approval applies to one exact action and expires after 60 seconds.
5. Use **Continue task** to resume with a fresh screenshot and the original goal. Restoring a session never restores permission to execute.
6. Press **Stop**, or **Ctrl+Alt+F12** even while another application has focus, to cancel. Cancellation cannot undo input already delivered to Windows.

Single-turn mode proposes one action for manual execution. Multi-turn mode plans, acts, observes, and continues up to the configured turn limit (maximum 100) or 20 minutes. Clearing **Review each action** enables direct control for that run; it resets to reviewed control afterwards.

## Staying on task

- The original goal and up to seven plan milestones stay in every multi-turn request.
- Model context contains at most six recent text turns, bounded to 24,000 JavaScript string characters, plus the pinned goal, plan, and ten bounded execution receipts. Only the current screenshot is sent.
- Receipts record input submitted to Windows, **not verified success**. Old turns are omitted whole, and the model is told to ask for missing details. This is deterministic context compaction, not a semantic summary of all earlier facts.
- Follow-up questions retain recent context. Clear chat resets it. Saved checkpoints retain the goal, plan, and receipts; resuming always re-observes the desktop.
- Three identical consecutive action/screenshot pairs stop before the third execution. Turn/time limits also bound runs when animations or cursor changes defeat exact-image matching.
- A `done` action needs completion evidence. Multi-turn completion requires a second `done` decision against a new screen. This is model judgment, not independent proof of success.

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
| Zoom Refine / box mode | Optional second targeting pass; inconclusive refinement stops execution |
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
| `plan` | `text`: one to seven newline-separated milestones |
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

Install the audit tool with `cargo install cargo-audit --locked` if needed. Windows CI runs these checks and builds the executable. Regression tests never send live desktop input. The ignored `capture_primary_monitor_smoke` Rust test can be run manually with `-- --ignored` on an interactive desktop; it captures in memory without sending input or saving the image.

Dependency updates replace `screenshots` with `xcap`, remove the unused shell plugin and unnecessary image decoders, and refresh both lockfiles. See [SECURITY.md](SECURITY.md) for remaining upstream warnings and validation limits.

## License

This project is distributed under the [Software License Agreement](LICENSE), including the commercial-use thresholds in Section 4 and disclaimer in Section 7.
