import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DisplayPicker,
  resolveDisplay,
  type DisplayInfo,
} from '../src/components/DisplayPicker';
import { DisplayIdentifier, parseIdentify } from '../src/components/DisplayIdentifier';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../src/hooks/useSettings';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const PRIMARY: DisplayInfo = {
  name: '\\\\.\\DISPLAY1',
  friendly_name: 'Dell U2720Q',
  number: 2,
  x: 1920,
  y: 0,
  width: 2560,
  height: 1440,
  primary: true,
};
const SIDE: DisplayInfo = {
  name: '\\\\.\\DISPLAY2',
  friendly_name: '\\\\.\\DISPLAY2',
  number: 1,
  x: 0,
  y: 0,
  width: 1920,
  height: 1080,
  primary: false,
};

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command: string) => {
    if (command === 'list_displays') return [SIDE, PRIMARY];
    return undefined;
  });
});
afterEach(cleanup);

describe('display setting', () => {
  it('defaults to the primary display and survives a save/load round trip', () => {
    expect(DEFAULT_SETTINGS.targetDisplay).toBe('');
    const saved = JSON.parse(
      JSON.stringify({ ...DEFAULT_SETTINGS, targetDisplay: SIDE.name }),
    );
    expect(sanitizeSettings(saved).targetDisplay).toBe(SIDE.name);
    expect(sanitizeSettings({ targetDisplay: 3 }).targetDisplay).toBe('');
  });

  it('resolves the empty choice to the primary display', () => {
    expect(resolveDisplay([SIDE, PRIMARY], '')).toBe(PRIMARY);
    expect(resolveDisplay([SIDE, PRIMARY], SIDE.name)).toBe(SIDE);
    expect(resolveDisplay([SIDE], '\\\\.\\DISPLAY9')).toBeUndefined();
  });
});

describe('identify overlay routing', () => {
  it('treats the main window URL as the app, not an overlay', () => {
    expect(parseIdentify('')).toBeNull();
    expect(parseIdentify('?other=1')).toBeNull();
    expect(parseIdentify('?identify=0')).toBeNull();
    expect(parseIdentify('?identify=abc')).toBeNull();
  });

  it('reads the number, primary flag and size the window was opened with', () => {
    expect(parseIdentify('?identify=2&primary=1&size=2560x1440')).toEqual({
      number: 2,
      primary: true,
      width: 2560,
      height: 1440,
    });
  });

  it('shows the number on the overlay', () => {
    render(
      <DisplayIdentifier number={3} primary={false} width={1920} height={1080} />,
    );
    expect(screen.getByText('Display 3')).toBeTruthy();
    expect(screen.getByText('1920 × 1080')).toBeTruthy();
  });
});

describe('DisplayPicker', () => {
  it('numbers each display and marks the primary one', async () => {
    render(<DisplayPicker value="" onChange={vi.fn()} runActive={false} />);
    const tile = await screen.findByRole('button', { name: /Display 2: Dell U2720Q, 2560 × 1440 \(primary\)/ });
    expect(tile).toBeTruthy();
    expect(screen.getByRole('button', { name: /Display 1: 1920 × 1080/ })).toBeTruthy();
    expect(screen.getByText(/Working on Display 2/)).toBeTruthy();
  });

  it('chooses a display from the diagram and from the list', async () => {
    const onChange = vi.fn();
    render(<DisplayPicker value="" onChange={onChange} runActive={false} />);
    fireEvent.click(await screen.findByRole('button', { name: /Display 1: 1920/ }));
    expect(onChange).toHaveBeenLastCalledWith(SIDE.name);

    fireEvent.change(screen.getByRole('combobox'), { target: { value: SIDE.name } });
    expect(onChange).toHaveBeenLastCalledWith(SIDE.name);
  });

  it('identifies displays through the backend command', async () => {
    render(<DisplayPicker value="" onChange={vi.fn()} runActive={false} />);
    const button = await screen.findByRole('button', { name: /Identify displays/ });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('identify_displays'),
    );
    expect(screen.getByRole('button', { name: /Showing numbers/ })).toBeTruthy();
  });

  it('holds the choice and the overlay while a run is active', async () => {
    render(<DisplayPicker value="" onChange={vi.fn()} runActive />);
    await screen.findByRole('button', { name: /Display 1: 1920/ });
    expect(
      (screen.getByRole('button', { name: /Identify displays/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByRole('combobox') as HTMLSelectElement).disabled).toBe(true);
    expect(
      (screen.getByRole('button', { name: /Display 1: 1920/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('warns when the saved display is no longer connected', async () => {
    render(
      <DisplayPicker value="\\\\.\\DISPLAY9" onChange={vi.fn()} runActive={false} />,
    );
    expect(
      await screen.findByText(/The selected display is not connected/),
    ).toBeTruthy();
  });

  it('reports a failure to list displays without crashing', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('no monitors'));
    render(<DisplayPicker value="" onChange={vi.fn()} runActive={false} />);
    expect(await screen.findByText(/Could not list displays: no monitors/)).toBeTruthy();
  });
});
