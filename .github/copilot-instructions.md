# AI Computer Use GUI - Copilot Instructions

## Architecture Overview

This is a **Tauri 2.0 desktop app** that lets users control their computer via natural language using the Qwen3-VL multimodal LLM. The architecture follows a clear frontend/backend split:

- **Frontend** (`src/`): React + TypeScript + Vite + Tailwind CSS
- **Backend** (`src-tauri/`): Rust with Tauri 2.0 framework

### Data Flow
1. User enters command → `useAgent.ts` captures screenshot via Tauri command
2. Screenshot (base64) + query sent to Rust backend via `invoke('process_computer_use', ...)`
3. Rust `api.rs` calls external OpenAI-compatible API with multimodal request
4. Model returns `<tool_call>` XML with action JSON → parsed by `parse_tool_call()`
5. Coordinates scaled from model's 0-1000 space to actual screen dimensions
6. Action executed via `enigo` crate in `actions.rs`

## Key Patterns

### Tauri Commands (IPC Boundary)
All Rust functions exposed to frontend use `#[tauri::command]` in [src-tauri/src/lib.rs](src-tauri/src/lib.rs):
```rust
#[tauri::command]
async fn capture_screenshot() -> Result<String, String> { ... }
```
Frontend calls via `invoke<ReturnType>('command_name', { args })` from `@tauri-apps/api/core`.

### Coordinate System
The model outputs coordinates in a **0-1000 normalized space**. Conversion happens in both `api.rs` (for response) and `actions.rs` (for execution):
```rust
let x = (coord[0] / 1000.0 * screen_width as f64) as i32;
```

### Error Handling
- Rust uses `thiserror` for typed errors in each module (e.g., `ApiError`, `ActionError`, `ScreenshotError`)
- Errors converted to `String` at Tauri command boundary via `.map_err(|e| e.to_string())`
- Frontend displays errors via toast in `App.tsx`

### Type Synchronization
Types must be kept in sync between:
- [src/types/index.ts](src/types/index.ts) - Frontend TypeScript
- [src-tauri/src/types.rs](src-tauri/src/types.rs) - Backend Rust with Serde

## Development Commands

```bash
npm install              # Install frontend dependencies
npm run tauri dev        # Dev mode (hot reload for both frontend and Rust)
npm run tauri build      # Production build
```

For Rust-only changes during development, the Tauri dev server auto-rebuilds the backend.

## Module Responsibilities

| File | Purpose |
|------|---------|
| `lib.rs` | Tauri command definitions (IPC surface) |
| `api.rs` | Qwen3-VL API client, prompt construction, tool_call parsing |
| `actions.rs` | Computer control via `enigo` (click, type, scroll, etc.) |
| `screenshot.rs` | Screen capture using `screenshots` crate |
| `useAgent.ts` | React hook managing agent state, screenshot capture, API calls |
| `useSettings.ts` | Settings persistence to localStorage |

## Adding New Actions

1. Add action case in `COMPUTER_USE_FUNCTION` prompt in [api.rs](src-tauri/src/api.rs)
2. Add handler in `execute_action()` match block in [actions.rs](src-tauri/src/actions.rs)
3. Update `ActionArguments` struct in [types.rs](src-tauri/src/types.rs) if new parameters needed
4. Mirror type changes in [src/types/index.ts](src/types/index.ts)

## Important Conventions

- **Tool call format**: Model outputs `<tool_call>{"name": "computer", "arguments": {...}}</tool_call>`
- **API compatibility**: Works with any OpenAI-compatible endpoint (vLLM, Ollama, etc.)
- **Settings storage key**: `ai-computer-use-settings` in localStorage
- **Default model endpoint**: `http://localhost:8000/v1` (expects Qwen3-VL)

## Testing Notes

- Use "Test Connection" button in settings panel before running commands
- Auto-execute toggle controls whether actions run automatically or require confirmation
- Debug logs in Rust code use `println!` - visible in dev console
