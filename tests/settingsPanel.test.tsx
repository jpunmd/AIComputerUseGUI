import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsPanel } from '../src/components/SettingsPanel';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../src/hooks/useSettings';

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
