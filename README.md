# AI Computer Use Agent

A Tauri desktop application that uses Qwen3-VL multimodal LLM to control your computer through natural language commands.

## Features

- 🖥️ **Screenshot Capture**: Automatically captures screenshots of your desktop
- 🤖 **AI-Powered Actions**: Uses Qwen3-VL to interpret your commands and determine the appropriate actions
- 🖱️ **Computer Control**: Execute clicks, typing, scrolling, keyboard shortcuts, and more
- ⚙️ **Configurable API**: Works with any OpenAI-compatible API endpoint
- 🎨 **Modern UI**: Beautiful dark theme with glass morphism effects

## Prerequisites

- [Node.js](https://nodejs.org/) (v18 or later)
- [Rust](https://rustup.rs/) (latest stable)
- [Tauri CLI](https://tauri.app/v1/guides/getting-started/prerequisites)
- An OpenAI-compatible API server running Qwen3-VL

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
- **Display Width/Height**: The coordinate space used by the model (default: 1000x1000)
- **Max Tokens**: Maximum tokens for the model response

## Usage

1. **Start your Qwen3-VL API server** (must be OpenAI-compatible)

2. **Configure the API endpoint** in settings

3. **Test the connection** using the "Test Connection" button

4. **Enter commands** in natural language, for example:
   - "Click the start button"
   - "Open the file menu"
   - "Type 'Hello World'"
   - "Scroll down"
   - "Press Ctrl+S"

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

## Architecture

```
├── src/                    # React frontend
│   ├── components/         # UI components
│   │   ├── ChatHistory.tsx
│   │   ├── CommandInput.tsx
│   │   ├── ScreenshotViewer.tsx
│   │   ├── SettingsPanel.tsx
│   │   └── StatusBar.tsx
│   ├── hooks/              # React hooks
│   │   ├── useAgent.ts
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

## Troubleshooting

### API Connection Issues

- Ensure your API server is running and accessible
- Check the API endpoint URL (should end with `/v1` for OpenAI-compatible APIs)
- Verify the model ID matches what your server provides

### Screenshot Issues

- On Windows, run the application with appropriate permissions
- Some screens or applications may not be captured due to DRM protection

### Action Execution Issues

- Some applications may block simulated input
- Ensure the application window is focused before executing actions

## License

MIT License
