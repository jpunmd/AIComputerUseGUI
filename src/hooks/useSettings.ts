import { useState, useEffect } from 'react';
import { Settings } from '../types';
import { THEMES, osTheme } from '../theme';

export const MAX_EXTRA_INSTRUCTIONS = 8000;

export const DEFAULT_SETTINGS: Settings = {
  apiEndpoint: 'http://localhost:8889/v1',
  modelId: 'Qwen/Qwen3-VL-30B-A3B-Instruct',
  extraInstructions: '', // Added to the built-in prompt (src/agent/protocol.ts)
  actionDelayMs: 1000, // Delay after action before next screenshot (ms)
  settleTimeoutMs: 2500, // Then wait up to this long for animations/loads to finish
  maxTurns: 20, // Maximum number of executed actions before stopping
  maxRunMinutes: 20, // Wall-clock limit for one run
  screenshotMaxDimension: 1920, // Longest side sent to the model; 1920 = 1080p (a 4K screen downscales exactly 2:1)
  maxTokens: 8192, // Thinking counts toward this; too low truncates the reply before its action
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

/**
 * Older builds saved the whole system prompt. A saved default (any version,
 * possibly lightly edited) is dropped so the current built-in prompt applies;
 * anything else is the user's own text and becomes additional instructions.
 */
export function migrateSystemPrompt(saved: unknown): string {
  if (typeof saved !== 'string') return '';
  const text = saved.replace(/<tools>[\s\S]*?<\/tools>/g, '').trim();
  return text.startsWith('You are a desktop control agent') ? '' : text;
}

// Explicit allowlist also drops legacy persistent auto-approval and unknown fields.
export function sanitizeSettings(value: unknown): Settings {
  const result = {...DEFAULT_SETTINGS};
  if (!value || typeof value !== 'object') return result;
  const stored=value as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    if (typeof stored[key] === typeof DEFAULT_SETTINGS[key]) Object.assign(result,{[key]:stored[key]});
  }
  if (stored.extraInstructions === undefined)
    result.extraInstructions = migrateSystemPrompt(stored.systemPrompt);
  result.extraInstructions = result.extraInstructions.slice(0, MAX_EXTRA_INSTRUCTIONS);
  const bounded=(n:number,min:number,max:number,fallback:number)=>Number.isFinite(n)?Math.min(max,Math.max(min,n)):fallback;
  result.maxTurns=Math.round(bounded(result.maxTurns,1,100,20));
  result.maxRunMinutes=Math.round(bounded(result.maxRunMinutes,1,240,20));
  result.actionDelayMs=bounded(result.actionDelayMs,0,10000,1000);
  result.settleTimeoutMs=Math.round(bounded(result.settleTimeoutMs,0,10000,2500));
  result.maxTokens=Math.round(bounded(result.maxTokens,256,32768,8192));
  result.screenshotMaxDimension=Math.round(bounded(result.screenshotMaxDimension,256,3840,1920));
  result.zoomCropFraction=bounded(result.zoomCropFraction,0.05,1,0.3);
  // Older builds saved 'system'; settle it to the current OS appearance.
  if(!THEMES.includes(result.theme)) result.theme=osTheme();
  return result;
}
