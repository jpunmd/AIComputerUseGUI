import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
const mocks = vi.hoisted(() => ({
  runTask: vi.fn().mockResolvedValue(undefined),
  previewAction: vi.fn(),
  testConnection: vi.fn().mockResolvedValue(true),
  setError: vi.fn(),
  saveSession: vi.fn(),
  updateSettings: vi.fn(),
  stopTask: vi.fn(),
  settings: {} as Record<string, unknown>,
  agent: {} as Record<string, unknown>,
}));
vi.mock('../src/hooks/useAgent', () => ({
  useAgent: () => ({
    stopTask: mocks.stopTask,
    isProcessing: false,
    messages: [],
    error: null,
    currentTurn: 0,
    isTaskRunning: false,
    isStopping: false,
    isDirectControl: false,
    pendingConfirmation: null,
    task: null,
    runTask: mocks.runTask,
    previewAction: mocks.previewAction,
    testConnection: mocks.testConnection,
    setError: mocks.setError,
    ...mocks.agent,
  }),
}));
vi.mock('../src/hooks/useSettings', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../src/hooks/useSettings')>();
  return {
    ...original,
    useSettings: () => ({
      settings: { ...original.DEFAULT_SETTINGS, ...mocks.settings },
      updateSettings: mocks.updateSettings,
      resetSettings: vi.fn(),
    }),
  };
});
vi.mock('../src/hooks/useSessions', () => ({
  useSessions: () => ({ sessions: [], saveSession: mocks.saveSession }),
}));
vi.mock('../src/components', async () => ({
  CommandInput: (await import('../src/components/CommandInput')).CommandInput,
  SettingsPanel: () => null,
  ChatHistory: () => null,
  StatusBar: () => null,
  SessionHistory: () => null,
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.settings = {};
  mocks.agent = {};
});

describe('standard task workflow', () => {
  it('submits directly to the task runner without a mode switch or manual execute controls', async () => {
    render(<App />);
    expect(
      screen.queryByRole('button', {
        name: /Multi-turn|Auto-execute|Execute:/i,
      }),
    ).toBeNull();
    expect(
      screen.getByRole('checkbox', { name: 'Precision clicks' }),
    ).toBeDefined();
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Find the weather' },
    });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() => expect(mocks.runTask).toHaveBeenCalledOnce());
    expect(mocks.runTask.mock.calls[0][0]).toBe('Find the weather');
    expect(mocks.runTask.mock.calls[0].slice(2)).toEqual([true, false, false]);
    expect(mocks.previewAction).not.toHaveBeenCalled();
  });
  it('uses the saved Review each action default and saves toolbar changes', async () => {
    mocks.settings = { reviewEachAction: false };
    render(<App />);
    const toggle = screen.getByRole('checkbox', {
      name: 'Review each action',
    }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(screen.getByText(/Direct control/)).toBeDefined();
    fireEvent.click(toggle);
    expect(mocks.updateSettings).toHaveBeenCalledWith({
      reviewEachAction: true,
    });
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Find the weather' },
    });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() => expect(mocks.runTask).toHaveBeenCalledOnce());
    expect(mocks.runTask.mock.calls[0][2]).toBe(false);
  });
  it('keeps plan-only as a task-runner option', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Plan only' }));
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Plan a report' },
    });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() => expect(mocks.runTask).toHaveBeenCalledOnce());
    expect(mocks.runTask.mock.calls[0][4]).toBe(true);
  });
  it('swaps Send for Stop while running and shows the run control mode', () => {
    mocks.agent = { isProcessing: true, isDirectControl: true };
    render(<App />);
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(mocks.stopTask).toHaveBeenCalledOnce();
    expect(screen.getByText(/you allowed this task/)).toBeDefined();
    expect(screen.getByText('Ctrl+Alt+F12')).toBeDefined();
  });
});

describe('header toggles', () => {
  it('switches between light and dark only, saving the choice', () => {
    mocks.settings = { theme: 'light' };
    render(<App />);
    expect(document.documentElement.dataset.theme).toBe('light');
    fireEvent.click(screen.getByRole('button', { name: 'Switch to dark mode' }));
    expect(mocks.updateSettings).toHaveBeenCalledWith({ theme: 'dark' });
  });
  it('shows and hides the sessions sidebar', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide saved sessions' }));
    expect(mocks.updateSettings).toHaveBeenCalledWith({ showSessions: false });
  });
});
