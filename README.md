# AI Computer Use Agent

A Windows Tauri desktop application that uses Qwen3-VL, Qwen3.5, or Qwen3.6 multimodal LLM to control your computer through natural language commands.

## ⚠️ Safety Warning — Read Before Running

This software hands a language model **direct control of your mouse and keyboard on the host machine**. It can click, type, drag, press keyboard shortcuts, and chain those actions together in a multi-turn loop. That carries real, non-trivial risk:

- **The model can make mistakes.** It can misidentify a button, mistype a path, or interpret your instruction differently than you intended. A misclick on the wrong "Confirm" dialog can delete data, send a message, complete a purchase, or change a system setting in seconds.
- **Misclicks can be irreversible.** The agent has the same authority over your machine that you do. There is no undo for a sent email, a deleted file emptied from the recycle bin, a posted message, or a triggered installer.
- **Prompt injection is a real attack surface.** A web page, document, or notification visible on screen can contain text that the model reads as instructions ("ignore previous instructions and …"). The model cannot reliably distinguish your goals from text it sees on the screen.
- **The "confirm" safety prompt is not a guarantee.** It only fires when the model voluntarily emits a `confirm` action. The model may forget, misclassify a destructive action as safe, or skip the prompt entirely. The "Always Allow" toggle disables the prompt completely — only enable it if you understand and accept that.
- **Credentials, secrets, and personal data on screen are sent to the model.** Every screenshot is uploaded to whatever API endpoint you configure. Anything visible — passwords, 2FA codes, private messages, financial info — leaves your machine.
- **Logs may capture sensitive content in debug builds.** Release builds redact user input from stdout, but debug builds (`npm run tauri dev`) print queries, typed text, and key sequences for troubleshooting.

### How this should be run

- **Use a sandbox.** Run inside a dedicated VM, throwaway user account, or isolated container — not your daily-driver desktop. Snapshot before each session.
- **Stay in the room.** Treat this as a supervised tool, not an autonomous agent. Watch every step. Be ready to hit the **Stop** button or unplug the keyboard/mouse.
- **Don't sign in to anything you care about.** Avoid running with your primary email, banking, social media, password manager, cloud storage, or work accounts logged in.
- **Don't enable "Always Allow"** unless the worst-case action in the sandbox is acceptable.
- **Use a local model.** Sending screenshots of your desktop to a third-party API has obvious privacy implications. A local OpenAI-compatible server (vLLM, llama.cpp, Ollama) keeps the data on your machine.
- **Keep `Max Turns` low** while you are learning the agent's behavior on a new task.

You assume all risk for any actions the agent takes. See the [LICENSE](LICENSE) (Section 7) for the full disclaimer of warranty and limitation of liability.

## Features

- 🖥️ **Screenshot Capture**: Automatically captures screenshots of your desktop
- 🤖 **AI-Powered Actions**: Uses the LLM to interpret your commands and determine the appropriate actions
- 🖱️ **Computer Control**: Execute clicks, typing, scrolling, keyboard shortcuts, and more
- 🔁 **Multi-Turn Agent**: Runs an action loop until the task is complete or the turn limit is hit
- 🧠 **Thinking Mode**: Surfaces and preserves chain-of-thought reasoning for models that support it
- 🛡️ **Safety Confirmations**: Prompts before delete, download, install, or other sensitive actions, with allow-once / reject / always-allow options
- 💾 **Session History**: Save, rename, export, import, and reload past chat sessions
- ⚙️ **Configurable API**: Works with any OpenAI-compatible API endpoint
- 🎨 **Modern UI**: Dark theme with glass morphism effects

## Prerequisites

- [Node.js](https://nodejs.org/) (v18 or later)
- [Rust](https://rustup.rs/) (latest stable)
- [Tauri CLI](https://tauri.app/v1/guides/getting-started/prerequisites)
- An OpenAI-compatible API server running Qwen3-VL, Qwen3.5, or Qwen3.6. Recommend using Qwen3.6 35B-A3B or 27B.
- Recommend "preserve thinking" on.

## Installation

1. **Install dependencies:**

   ```bash
   npm install
   ```

2. **Run in development mode:**

   ```bash
   npm run tauri dev
   ```

3. **Build for production:**

   ```bash
   npm run tauri build
   ```

## Configuration

Click the **Settings** (gear icon) button in the top right corner to configure:

- **API Endpoint**: The URL of your OpenAI-compatible API server (e.g., `http://localhost:8000/v1`)
- **Model ID**: The model identifier (e.g., `Qwen/Qwen3-VL-30B-A3B-Instruct`)
- **System Prompt**: Editable agent system prompt; reset-to-default supported
- **Action Delay**: Pause after each action before the next screenshot is captured (milliseconds)
- **Max Turns**: Upper bound on the multi-turn loop, prevents runaway tasks
- **Screenshot Max Dimension**: Caps the longest side of the screenshot sent to the model — lower values cost fewer tokens, higher values preserve detail
- **Thinking Mode**: Enables reasoning for supported models (Qwen3-VL, DeepSeek-R1, etc.)
- **Expand Thinking by Default**: Show reasoning blocks expanded in the chat view
- **Always Allow Sensitive Actions**: Skip the confirmation dialog for delete, download, install, and other sensitive actions (off by default)
- **Display Width/Height**: Coordinates are normalized to a 1000×1000 space — these values map back to your actual screen resolution

## Usage

1. **Start your Qwen3.6 API server** (must be OpenAI-compatible)

2. **Configure the API endpoint** in settings

3. **Test the connection** using the "Test Connection" button

4. **Enter commands** in natural language, for example:
   - "Click the start button"
   - "Open the file menu"
   - "Type 'Hello World'"
   - "Scroll down"
   - "Press Ctrl+S"
   - "What's the weather like in Chicago?"

5. **Enable Auto-execute** to automatically perform actions, or keep it disabled to preview actions first

## Supported Actions

| Action | Description |
|--------|-------------|
| `click` / `left_click` | Left mouse button click |
| `right_click` | Right mouse button click |
| `double_click` | Double left click |
| `left_click_drag` | Click and drag from start to end position |
| `scroll` | Scroll in a direction (up, down, left, right) |
| `type` | Type text at the current cursor position |
| `key` | Press a keyboard key or combination (e.g., `ctrl+c`) |
| `wait` | Wait for a short duration |
| `screenshot` | Re-capture the current screen |
| `confirm` | Pause and ask the user before a sensitive or permanent action |
| `done` | Signal the task is complete and stop the loop |

## Architecture

```
├── src/                    # React frontend
│   ├── components/         # UI components
│   │   ├── ChatHistory.tsx
│   │   ├── CommandInput.tsx
│   │   ├── ScreenshotViewer.tsx
│   │   ├── SessionHistory.tsx
│   │   ├── SettingsPanel.tsx
│   │   └── StatusBar.tsx
│   ├── hooks/              # React hooks
│   │   ├── useAgent.ts
│   │   ├── useSessions.ts
│   │   └── useSettings.ts
│   ├── types/              # TypeScript types
│   └── App.tsx             # Main application
│
├── src-tauri/              # Rust backend
│   └── src/
│       ├── main.rs         # Entry point
│       ├── lib.rs          # Tauri commands
│       ├── api.rs          # API client for Qwen3-VL
│       ├── screenshot.rs   # Screenshot capture
│       ├── actions.rs      # Computer actions (mouse, keyboard)
│       └── types.rs        # Rust types
```

## Development

### Frontend

The frontend is built with:
- **React 18** with TypeScript
- **Tailwind CSS** for styling
- **Lucide React** for icons
- **Tauri API** for native bridge

### Backend

The Rust backend uses:
- **Tauri 2** for the native runtime
- **reqwest** for HTTP requests
- **screenshots** for screen capture
- **enigo** for mouse/keyboard control
- **serde** for JSON serialization

## License

This project is distributed under the terms of the [Software License Agreement](LICENSE). By using or distributing the software you agree to those terms, including the commercial-use thresholds described in Section 4.
