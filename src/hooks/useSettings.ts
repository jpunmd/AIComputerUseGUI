import { TOOL_DEFINITION } from '../agent/protocol';
import { useState, useEffect } from 'react';
import { Settings } from '../types';
import { THEMES, osTheme } from '../theme';

export const DEFAULT_SYSTEM_PROMPT = `You are a desktop control agent. Your sole purpose is to control the user's computer by taking actions with the mouse and keyboard to accomplish tasks and answer questions. Come up with a plan to answer the question or accomplish the task before starting, then carry it out one action at a time.

Your front end is a GUI application called "AI Computer Use Agent" — this is the chat window the user types into and watches your actions through. Do NOT click, type into, or otherwise interact with this window. If you see it on screen, treat it as off-limits and work around it (switch to the target window, minimize the agent window if needed, etc.). The agent window typically shows a chat history, a command input box, screenshots, and a Settings/gear icon — never click these.

Current computer tool definition:
${TOOL_DEFINITION}

# Coordinate System
- Use NORMALIZED coordinates from 0 to 1000
- (0, 0) = top-left corner, (1000, 1000) = bottom-right corner
- (500, 500) = center of the screen

Always return a computer action in <tool_call></tool_call> tags:
<tool_call>
{"name": "computer", "arguments": {"action": "...", ...}}
</tool_call>

# Behavior Guidelines
- Plan before you act: briefly think through the steps needed, then execute one action per turn
- BE PROACTIVE: once the plan is clear, immediately start working on it
- Your reasoning and action MUST be consistent
- For information questions ("what's the weather?", "what does this error mean?"), find the answer (on screen if needed) and finish with action "done", putting the answer in "text"; for anything that requires interacting with the screen, take an action
- Do NOT interact with the AI Computer Use Agent window itself
- Use "confirm" before potentially sensitive or permanent actions, including: deleting files or data, downloading files, installing or uninstalling software, formatting drives, or any action that grants elevated permissions. Describe in the "text" argument exactly what you are about to do.

# Click Targeting
- Always aim for the CENTER of the target element to avoid near-misses
- For a logo, icon, button, or image: click the visual center of the shape
- For text or a text link: click the middle of the text's bounding box (horizontal midpoint, vertical midpoint of the character height)
- For a search box, input field, or text area: click the center of the field, not its edge or border
- Do not click on borders, padding, edges, corners, or whitespace adjacent to an element

# Safety Guidelines
- Be PRECISE with destructive actions
- For sensitive or permanent actions (delete, download, install, uninstall, format, granting permissions), use "confirm" action first

# Multi-Turn Instructions
- You will receive a list of actions already completed and a screenshot of the CURRENT state
- Do NOT repeat actions that are already in the history
- If the goal appears complete, use action "done"
- For scroll: always include direction ("up", "down", "left", "right")`;

export const DEFAULT_SETTINGS: Settings = {
  apiEndpoint: 'http://localhost:8889/v1',
  modelId: 'Qwen/Qwen3-VL-30B-A3B-Instruct',
  displayWidth: 1000,
  displayHeight: 1000,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  actionDelayMs: 1000, // Delay after action before next screenshot (ms)
  maxTurns: 20, // Maximum number of turns before stopping
  screenshotMaxDimension: 1920, // Longest side sent to the model; 1920 = 1080p (a 4K screen downscales exactly 2:1)
  enableThinking: true, // Thinking mode on by default (Qwen3-VL thinking models)
  expandThinkingByDefault: true, // Show the model's reasoning expanded by default
  enablePlanning: true,
  zoomRefine: false, // Precision clicks: opt-in magnified-crop check before each click (an extra model call per click).
  zoomCropFraction: 0.3, // Zoom window = 30% of the screen, centered on the coarse prediction
  boxRefine: false, // Off by default: clicks target a predicted point; on: the model boxes the target and we click the box center (works with or without zoomRefine)
  debugMode: false, // Developer instruments (calibration probe) hidden by default
  saveScreenshotsInSessions: false, // Opt in to persisting desktop images.
  reviewEachAction: true, // Ask before each mouse/keyboard action unless the user saves direct control as the default.
  theme: osTheme(), // First launch matches the OS; after that the saved choice is used.
  showSessions: true, // Saved-sessions sidebar open by default.
};

const STORAGE_KEY = 'ai-computer-use-settings';

/**
 * Which model to use given what the server lists (loaded models first).
 * Keeps the configured ID when the server serves it; otherwise returns the
 * first available one. Returns null when nothing should change.
 */
export function pickModel(current: string, available: string[]): string | null {
  if (!available.length || available.includes(current)) return null;
  return available[0];
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        return sanitizeSettings(JSON.parse(stored));
      }
    } catch {
      console.error('Failed to load settings from storage');
    }
    return DEFAULT_SETTINGS;
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      console.error('Failed to save settings to storage');
    }
  }, [settings]);

  const updateSettings = (updates: Partial<Settings>) => {
    setSettings(prev => sanitizeSettings({ ...prev, ...updates }));
  };

  // Appearance is the user's choice, not agent configuration, so a reset
  // keeps the current theme.
  const resetSettings = () => {
    setSettings(prev => ({ ...DEFAULT_SETTINGS, theme: prev.theme }));
  };

  return {
    settings,
    updateSettings,
    resetSettings,
    DEFAULT_SETTINGS,
  };
}

// Explicit allowlist also drops legacy persistent auto-approval and unknown fields.
export function sanitizeSettings(value: unknown): Settings {
  const result = {...DEFAULT_SETTINGS};
  if (!value || typeof value !== 'object') return result;
  const stored=value as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    if (typeof stored[key] === typeof DEFAULT_SETTINGS[key]) Object.assign(result,{[key]:stored[key]});
  }
  const bounded=(n:number,min:number,max:number,fallback:number)=>Number.isFinite(n)?Math.min(max,Math.max(min,n)):fallback;
  result.maxTurns=Math.round(bounded(result.maxTurns,1,100,20));
  result.actionDelayMs=bounded(result.actionDelayMs,0,10000,1000);
  result.screenshotMaxDimension=Math.round(bounded(result.screenshotMaxDimension,256,3840,1920));
  result.zoomCropFraction=bounded(result.zoomCropFraction,0.05,1,0.3);
  // Older builds saved 'system'; settle it to the current OS appearance.
  if(!THEMES.includes(result.theme)) result.theme=osTheme();
  return result;
}
