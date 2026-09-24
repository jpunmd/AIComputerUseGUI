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
}));
vi.mock('../src/hooks/useAgent', () => ({
  useAgent: () => ({
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
  }),
}));
vi.mock('../src/hooks/useSettings', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../src/hooks/useSettings')>();
  return {
    ...original,
    useSettings: () => ({
      settings: original.DEFAULT_SETTINGS,
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
});
