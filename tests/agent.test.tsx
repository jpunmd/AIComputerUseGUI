import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgent } from '../src/hooks/useAgent';
import { DEFAULT_SETTINGS } from '../src/hooks/useSettings';
import { AgentResponse, TaskProgress } from '../src/types';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));
const settings = {
  ...DEFAULT_SETTINGS,
  enablePlanning: false,
  actionDelayMs: 0,
  maxTurns: 8,
};
const reply = (
  action: string,
  args: object = {},
  progress?: TaskProgress,
): AgentResponse => ({
  success: true,
  output_text: JSON.stringify({ action, arguments: args }),
  action: { action, arguments: args, ...(progress ? { progress } : {}) },
});
let responses: AgentResponse[] = [];
let supervised = true;
let observationNumber = 0;

beforeEach(() => {
  responses = [];
  supervised = true;
  observationNumber = 0;
  vi.clearAllMocks();
  mocks.listen.mockResolvedValue(() => {});
  mocks.invoke.mockImplementation(
    async (command: string, args: Record<string, unknown>) => {
      if (command === 'start_run') {
        supervised = args.supervised as boolean;
        return 'run-1';
      }
      if (command === 'capture_screenshot_with_metadata')
        return {
          base64_image: 'unchanged-screen',
          image_width: 1000,
          image_height: 1000,
          actual_screen_width: 1000,
          actual_screen_height: 1000,
          observation_id: 'obs-' + ++observationNumber,
        };
      if (command === 'process_computer_use') {
        const response = responses.shift();
        if (!response) throw Error('No test model response remaining');
        return response;
      }
      if (command === 'prepare_action')
        return {
          id: 'proposal-1',
          action: JSON.parse(args.action as string),
          requires_approval: supervised,
        };
      if (['approve_action', 'execute_action', 'stop_run'].includes(command))
        return;
      throw Error('Unexpected command ' + command);
    },
  );
});
afterEach(cleanup);

describe('agent controller safety', () => {
  it('tracks two milestones through observed outcomes and keeps metadata out of native input', async () => {
    responses = [
      reply('plan', {
        text: JSON.stringify({
          steps: [
            { title: 'Open report', success_criteria: 'Report visible' },
            { title: 'Save report', success_criteria: 'Saved label visible' },
          ],
        }),
      }),
      reply(
        'key',
        { key: 'ctrl+o' },
        { next_milestone_id: 'm1-1', expected_outcome: 'Report opens' },
      ),
      reply(
        'key',
        { key: 'ctrl+s' },
        {
          outcome: { status: 'succeeded', evidence: 'Report visible' },
          milestones: [
            {
              id: 'm1-1',
              status: 'completed',
              evidence: 'Report text visible',
            },
          ],
          next_milestone_id: 'm1-2',
          expected_outcome: 'Saved indicator appears',
        },
      ),
      reply(
        'done',
        { text: 'Report saved' },
        {
          outcome: { status: 'succeeded', evidence: 'Saved indicator visible' },
          milestones: [
            {
              id: 'm1-2',
              status: 'completed',
              evidence: 'Correct destination and Saved label visible',
            },
          ],
          notes: [
            {
              kind: 'artifact',
              text: 'C:\\Reports\\final.txt',
              evidence: 'Save dialog confirmed this destination',
            },
          ],
        },
      ),
      reply('done', { text: 'Saved state still visible on new screen' }),
    ];
    const { result } = renderHook(() => useAgent());
    await act(async () => {
      await result.current.runMultiTurn(
        'Save report',
        { ...settings, enablePlanning: true },
        false,
      );
    });
    expect(result.current.task?.status).toBe('completed');
    expect(result.current.task?.plan.map((s) => s.status)).toEqual([
      'completed',
      'completed',
    ]);
    expect(result.current.task?.receipts.map((r) => r.outcome)).toEqual([
      'succeeded',
      'succeeded',
    ]);
    expect(result.current.task?.summary).toContain('C:\\Reports\\final.txt');
    const native = mocks.invoke.mock.calls
      .filter((c) => c[0] === 'prepare_action')
      .map((c) => JSON.parse(c[1].action));
    expect(native).toHaveLength(2);
    expect(
      native.every((a) => !('progress' in a) && !('progress' in a.arguments)),
    ).toBe(true);
    const checkpoint =
      result.current.messages[result.current.messages.length - 1].task;
    expect(checkpoint?.notes[0].evidence.step).toBe(4);
  });

  it('does not accept repeated done claims while milestones remain pending', async () => {
    responses = [
      reply('plan', { text: 'Open report\nSave report' }),
      reply('done', { text: 'Done' }),
      reply('done', { text: 'Really done' }),
    ];
    const { result } = renderHook(() => useAgent());
    await act(async () => {
      await result.current.runMultiTurn(
        'Save report',
        { ...settings, enablePlanning: true },
        false,
      );
    });
    expect(result.current.task?.status).toBe('needs_user');
    expect(result.current.error).toContain('unfinished milestones');
    expect(mocks.invoke.mock.calls.some((c) => c[0] === 'execute_action')).toBe(
      false,
    );
    const prompts = mocks.invoke.mock.calls
      .filter((c) => c[0] === 'process_computer_use')
      .map((c) => c[1].query);
    expect(prompts[2]).toContain('m1-2: Save report (pending)');
  });

  it('rejects an invalid progress update before input and preserves the previous plan', async () => {
    responses = [
      reply('plan', { text: 'Open report' }),
      reply(
        'key',
        { key: 'enter' },
        {
          milestones: [
            { id: 'invented', status: 'completed', evidence: 'Trust me' },
          ],
        },
      ),
      reply('none', { text: 'Need help' }),
    ];
    const { result } = renderHook(() => useAgent());
    await act(async () => {
      await result.current.runMultiTurn(
        'Open report',
        { ...settings, enablePlanning: true },
        false,
      );
    });
    expect(result.current.task?.plan[0].status).toBe('pending');
    expect(mocks.invoke.mock.calls.some((c) => c[0] === 'execute_action')).toBe(
      false,
    );
  });

  it('replans once after repeated input and retains the failed approach in memory', async () => {
    const unchanged = {
      outcome: { status: 'uncertain' as const, evidence: 'Screen unchanged' },
    };
    responses = [
      reply('plan', { text: 'Open report' }),
      reply('key', { key: 'enter' }),
      reply('key', { key: 'enter' }, unchanged),
      reply('key', { key: 'enter' }, unchanged),
      reply('plan', {
        text: JSON.stringify({
          reason: 'Enter had no effect; click the File menu instead',
          steps: [
            {
              id: 'm1-1',
              title: 'Open through File menu',
              success_criteria: 'Report text visible',
            },
          ],
        }),
      }),
      reply('click', { coordinate: [100, 100] }),
      reply(
        'done',
        { text: 'Report visible' },
        {
          outcome: { status: 'succeeded', evidence: 'Report text visible' },
          milestones: [
            {
              id: 'm1-1',
              status: 'completed',
              evidence: 'Report text visible',
            },
          ],
        },
      ),
      reply('done', { text: 'Report remains open' }),
    ];
    const { result } = renderHook(() => useAgent());
    await act(async () => {
      await result.current.runMultiTurn(
        'Open report',
        { ...settings, enablePlanning: true, maxTurns: 10 },
        false,
      );
    });
    expect(result.current.task?.status).toBe('completed');
    expect(result.current.task?.revision).toBe(2);
    expect(
      result.current.task?.notes.some(
        (n) => n.kind === 'failure' && n.text.includes('without progress'),
      ),
    ).toBe(true);
    expect(
      mocks.invoke.mock.calls.filter((c) => c[0] === 'execute_action'),
    ).toHaveLength(3);
    const planRequest = mocks.invoke.mock.calls.filter(
      (c) => c[0] === 'process_computer_use',
    )[4][1].query;
    expect(planRequest).toContain('different approach');
  });

  it('Stop during a progress response cannot apply late completion evidence', async () => {
    responses = [reply('plan', { text: 'Open report' })];
    let resolveReview!: (r: AgentResponse) => void;
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((cmd, args) =>
      cmd === 'process_computer_use' && observationNumber === 2
        ? new Promise((resolve) => {
            resolveReview = resolve;
          })
        : original(cmd, args),
    );
    const { result } = renderHook(() => useAgent());
    let task!: Promise<void>;
    act(() => {
      task = result.current.runMultiTurn(
        'Open report',
        { ...settings, enablePlanning: true },
        false,
      );
    });
    await waitFor(() => expect(resolveReview).toBeDefined());
    await act(async () => {
      result.current.stopMultiTurn();
      resolveReview(
        reply(
          'done',
          { text: 'Done' },
          {
            milestones: [
              { id: 'm1-1', status: 'completed', evidence: 'Late evidence' },
            ],
          },
        ),
      );
      await task;
    });
    expect(result.current.task?.status).toBe('stopped');
    expect(result.current.task?.plan[0].status).toBe('pending');
    expect(mocks.invoke.mock.calls.some((c) => c[0] === 'execute_action')).toBe(
      false,
    );
  });

  it('Stop settles a pending approval and cannot execute after a late Allow click', async () => {
    responses = [reply('click', { coordinate: [500, 500] })];
    const { result } = renderHook(() => useAgent());
    let task!: Promise<void>;
    act(() => {
      task = result.current.runMultiTurn('Click the editor', settings);
    });
    await waitFor(() =>
      expect(result.current.pendingConfirmation).not.toBeNull(),
    );
    const lateAllow = result.current.pendingConfirmation!.onConfirm;
    await act(async () => {
      result.current.stopMultiTurn();
      lateAllow();
      await task;
    });
    expect(result.current.isProcessing).toBe(false);
    expect(result.current.pendingConfirmation).toBeNull();
    expect(mocks.invoke.mock.calls.some((c) => c[0] === 'execute_action')).toBe(
      false,
    );
  });

  it('checks stop after capture before starting inference', async () => {
    let captureResolve!: (x: unknown) => void;
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((cmd, args) =>
      cmd === 'capture_screenshot_with_metadata'
        ? new Promise((resolve) => {
            captureResolve = resolve;
          })
        : original(cmd, args),
    );
    const { result } = renderHook(() => useAgent());
    let task!: Promise<void>;
    act(() => {
      task = result.current.runMultiTurn('Test', settings);
    });
    await waitFor(() => expect(captureResolve).toBeDefined());
    await act(async () => {
      result.current.stopMultiTurn();
      captureResolve({ base64_image: '', observation_id: 'obs' });
      await task;
    });
    expect(
      mocks.invoke.mock.calls.some((c) => c[0] === 'process_computer_use'),
    ).toBe(false);
  });

  it('requires exact proposal approval before executing and verifies completion again', async () => {
    responses = [
      reply('key', { key: 'enter' }),
      reply(
        'done',
        { text: 'Saved label visible' },
        { outcome: { status: 'succeeded', evidence: 'Saved label visible' } },
      ),
      reply('done', { text: 'Saved label still visible' }),
    ];
    const { result } = renderHook(() => useAgent());
    let task!: Promise<void>;
    act(() => {
      task = result.current.runMultiTurn('Save', settings);
    });
    await waitFor(() =>
      expect(result.current.pendingConfirmation).not.toBeNull(),
    );
    expect(mocks.invoke.mock.calls.some((c) => c[0] === 'execute_action')).toBe(
      false,
    );
    await act(async () => {
      result.current.pendingConfirmation!.onConfirm();
      await task;
    });
    const commands = mocks.invoke.mock.calls.map((c) => c[0]);
    expect(commands.indexOf('approve_action')).toBeLessThan(
      commands.indexOf('execute_action'),
    );
    expect(commands.filter((c) => c === 'process_computer_use')).toHaveLength(
      3,
    );
    expect(result.current.task?.status).toBe('completed');
  });

  it('preserves single-turn follow-up context and clears it for a new chat', async () => {
    responses = [
      reply('none', { text: 'Noted' }),
      reply('none', { text: 'Continuing' }),
      reply('none', { text: 'Fresh' }),
    ];
    const { result } = renderHook(() => useAgent());
    await act(async () => {
      await result.current.processQuery('Remember Notepad', settings);
      await result.current.processQuery('Which app?', settings);
    });
    const calls = mocks.invoke.mock.calls.filter(
      (c) => c[0] === 'process_computer_use',
    );
    expect(calls[1][1].priorTurns[0].user_query).toContain('Remember Notepad');
    await act(async () => {
      result.current.clearMessages();
      await result.current.processQuery('New question', settings);
    });
    expect(
      mocks.invoke.mock.calls.filter(
        (c) => c[0] === 'process_computer_use',
      )[2][1].priorTurns,
    ).toEqual([]);
  });

  it('stops unchanged action/screen repetition before a third execution', async () => {
    responses = Array.from({ length: 3 }, (_, i) =>
      reply(
        'key',
        { key: 'enter' },
        i
          ? { outcome: { status: 'uncertain', evidence: 'Screen unchanged' } }
          : undefined,
      ),
    );
    const { result } = renderHook(() => useAgent());
    await act(async () => {
      await result.current.runMultiTurn(
        'Test',
        { ...settings, maxTurns: 3 },
        false,
      );
    });
    expect(
      mocks.invoke.mock.calls.filter((c) => c[0] === 'execute_action'),
    ).toHaveLength(2);
    expect(result.current.task?.summary).toContain('without progress');
  });

  it('plan-only never executes input, and Continue preserves the original goal', async () => {
    responses = [reply('plan', { text: 'Open the document\nSave the report' })];
    const { result } = renderHook(() => useAgent());
    await act(async () => {
      await result.current.runMultiTurn(
        'Save report to Reports',
        settings,
        true,
        false,
        true,
      );
    });
    expect(result.current.task?.plan).toHaveLength(2);
    expect(mocks.invoke.mock.calls.some((c) => c[0] === 'execute_action')).toBe(
      false,
    );
    responses = [reply('none', { text: 'Need document path' })];
    await act(async () => {
      await result.current.runMultiTurn('Continue', settings, true, true);
    });
    const latest = mocks.invoke.mock.calls
      .filter((c) => c[0] === 'process_computer_use')
      .at(-1)!;
    expect(latest[1].query).toContain('Save report to Reports');
    expect(latest[1].query).toContain('Save the report');
    expect(result.current.task?.status).toBe('needs_user');
  });

  it('does not execute coarse coordinates if refinement fails', async () => {
    responses = [reply('click', { coordinate: [500, 500] })];
    const { result } = renderHook(() => useAgent());
    await act(async () => {
      await result.current.runMultiTurn(
        'Click editor',
        { ...settings, zoomRefine: true },
        false,
      );
    });
    expect(mocks.invoke.mock.calls.some((c) => c[0] === 'execute_action')).toBe(
      false,
    );
    expect(result.current.error).toContain('refine_coordinate');
  });
});
