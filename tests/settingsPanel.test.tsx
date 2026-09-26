import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsPanel } from '../src/components/SettingsPanel';
import {
  DEFAULT_SETTINGS,
  pickModel,
  sanitizeSettings,
} from '../src/hooks/useSettings';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue([]),
}));
afterEach(cleanup);

describe('Review each action setting', () => {
  it('defaults to reviewed control and survives a save/load round trip', () => {
    expect(DEFAULT_SETTINGS.reviewEachAction).toBe(true);
    const saved = JSON.parse(
      JSON.stringify({ ...DEFAULT_SETTINGS, reviewEachAction: false }),
    );
    expect(sanitizeSettings(saved).reviewEachAction).toBe(false);
    expect(sanitizeSettings({ reviewEachAction: 'no' }).reviewEachAction).toBe(
      true,
    );
  });

  it('is toggled from the settings panel', () => {
    const onUpdateSettings = vi.fn();
    render(
      <SettingsPanel
        settings={DEFAULT_SETTINGS}
        onUpdateSettings={onUpdateSettings}
        onResetSettings={vi.fn()}
        onTestConnection={vi.fn()}
        isOpen
        onClose={vi.fn()}
      />,
    );
    const toggle = screen.getByRole('switch', { name: 'Review Each Action' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    expect(onUpdateSettings).toHaveBeenCalledWith({ reviewEachAction: false });
  });
});

describe('Theme setting', () => {
  it('remembers light or dark, and settles the old "system" value to the OS appearance', () => {
    expect(sanitizeSettings({ theme: 'dark' }).theme).toBe('dark');
    expect(sanitizeSettings({ theme: 'light' }).theme).toBe('light');
    const matchMedia = vi.fn().mockReturnValue({ matches: true });
    vi.stubGlobal('matchMedia', matchMedia);
    try {
      expect(sanitizeSettings({ theme: 'system' }).theme).toBe('dark');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('model picker', () => {
  it('keeps a served model and otherwise picks the first listed one', () => {
    expect(pickModel('b', ['a', 'b'])).toBeNull();
    expect(pickModel('missing', ['loaded.gguf', 'other.gguf'])).toBe(
      'loaded.gguf',
    );
    expect(pickModel('manual-id', [])).toBeNull();
  });

  it('switches the settings to a model the server serves', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(['Qwen3-VL-8B-Instruct-Q4_K_M.gguf']);
    const onUpdateSettings = vi.fn();
    render(
      <SettingsPanel
        settings={DEFAULT_SETTINGS}
        onUpdateSettings={onUpdateSettings}
        onResetSettings={vi.fn()}
        onTestConnection={vi.fn()}
        isOpen
        onClose={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(onUpdateSettings).toHaveBeenCalledWith({
        modelId: 'Qwen3-VL-8B-Instruct-Q4_K_M.gguf',
      }),
    );
  });
});
