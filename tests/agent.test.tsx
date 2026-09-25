import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgent } from '../src/hooks/useAgent';
import { DEFAULT_SETTINGS } from '../src/hooks/useSettings';
import { AgentResponse, TaskProgress } from '../src/types';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));
// Most tests exercise the full progress protocol; simple-format tests opt in.
const settings = {
  ...DEFAULT_SETTINGS,
  simpleToolFormat: false,
  enablePlanning: false,
  zoomRefine: false,
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
const screenChanged = (partial = false) => ({
  code: 'screen_changed',
  message: 'Target window changed since the screenshot; capture again',
  input_may_have_been_sent: partial,
});

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
      if (command === 'approve_action') {
        if (args.allowForTask) supervised = false;
        return;
      }
      if (['execute_action', 'stop_run'].includes(command)) return;
      throw Error('Unexpected command ' + command);
    },
  );
});
afterEach(cleanup);

describe('agent controller safety', () => {
  it('recovers from a window switch with fresh targeting and retains task permission and milestones', async () => {
    responses = [
      reply('plan', { text: 'Open Chrome' }),
      reply('click', { coordinate: [153, 977] }),
      reply(
        'click',
        { coordinate: [150, 980] },
        {
          outcome: {
            status: 'failed',
            evidence: 'Task View opened instead of Chrome',
          },
        },
      ),
      reply('click', { coordinate: [600, 400] }),
      reply(
        'done',
        { text: 'Chrome is open' },
        {
          outcome: { status: 'succeeded', evidence: 'Chrome window visible' },
          milestones: [
            {
              id: 'm1-1',
              status: 'completed',
              evidence: 'Chrome window visible',
            },
          ],
        },
      ),
      reply('done', { text: 'Chrome remains open' }),
    ];
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((cmd, args) =>
      cmd === 'prepare_action' && observationNumber === 3
        ? Promise.reject(screenChanged())
        : original(cmd, args),
    );
    const { result } = renderHook(() => useAgent());
    let task!: Promise<void>;
    act(() => {
      task = result.current.runTask('Open Chrome', {
        ...settings,
        enablePlanning: true,
      });
    });
    await waitFor(() =>
      expect(result.current.pendingConfirmation?.onAllowTask).toBeDefined(),
    );
    await act(async () => {
      result.current.pendingConfirmation!.onAllowTask!();
      await task;
    });
    expect(result.current.task?.status).toBe('completed');
    expect(result.current.error).toBeNull();
    expect(result.current.task?.plan[0].attempts).toBe(2);
    expect(result.current.task?.receipts.map((r) => r.outcome)).toEqual([
      'failed',
      'succeeded',
    ]);
    expect(
      result.current.task?.notes.some(
        (n) =>
          n.evidence.source === 'controller' && n.text.includes('NOT executed'),
      ),
    ).toBe(true);
    expect(
      mocks.invoke.mock.calls.filter((c) => c[0] === 'approve_action'),
    ).toHaveLength(1);
    expect(
      mocks.invoke.mock.calls.filter((c) => c[0] === 'execute_action'),
    ).toHaveLength(2);
    const proposals = mocks.invoke.mock.calls
      .filter((c) => c[0] === 'prepare_action')
      .map((c) => c[1]);
    expect(proposals.map((p) => p.observationId)).toEqual([
      'obs-2',
      'obs-3',
      'obs-4',
    ]);
    expect(JSON.parse(proposals[2].action).arguments.coordinate).toEqual([
      600, 400,
    ]);
    const recoveryPrompt = mocks.invoke.mock.calls.filter(
      (c) => c[0] === 'process_computer_use',
    )[3][1].query;
    expect(recoveryPrompt).toContain('NOT executed');
    expect(recoveryPrompt).toContain('Task View');
    expect(recoveryPrompt).toContain('Open Chrome');
  });

  it('requires outcome review before more input after a possibly partial action', async () => {
    responses = [
      reply('double_click', { coordinate: [200, 300] }),
      reply('key', { key: 'enter' }), // Missing outcome must not execute.
      reply(
        'done',
        { text: 'File opened on the first click' },
        {
          outcome: {
            status: 'succeeded',
            evidence: 'File visible on new screen',
          },
        },
      ),
      reply('done', { text: 'File remains open' }),
    ];
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((cmd, args) =>
      cmd === 'execute_action'
        ? Promise.reject(screenChanged(true))
        : original(cmd, args),
    );
    const { result } = renderHook(() => useAgent());
    await act(async () => {
      await result.current.runTask('Open file', settings, false);
    });
    expect(result.current.task?.status).toBe('completed');
    expect(
      mocks.invoke.mock.calls.filter((c) => c[0] === 'execute_action'),
    ).toHaveLength(1);
    expect(
      mocks.invoke.mock.calls.filter((c) => c[0] === 'prepare_action'),
    ).toHaveLength(1);
    expect(result.current.task?.receipts[0].expected).toContain(
      'Input was interrupted',
    );
    expect(result.current.task?.receipts[0].outcome).toBe('succeeded');
    const prompt = mocks.invoke.mock.calls.filter(
      (c) => c[0] === 'process_computer_use',
    )[1][1].query;
    expect(prompt).toContain('Some input may have been sent');
    expect(prompt).toContain('Do not blindly repeat');
  });

  it('bounds repeated window-change recovery without executing stale proposals', async () => {
    responses = Array.from({ length: 4 }, () =>
      reply('click', { coordinate: [100, 900] }),
    );
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((cmd, args) =>
      cmd === 'prepare_action'
        ? Promise.reject(screenChanged())
        : original(cmd, args),
    );
    const { result } = renderHook(() => useAgent());
    await act(async () => {
      await result.current.runTask('Open Chrome', settings, false);
    });
    expect(result.current.task?.status).toBe('needs_user');
    expect(result.current.error).toContain('after automatic recovery attempts');
    expect(observationNumber).toBe(4);
    expect(result.current.task?.receipts).toHaveLength(0);
    expect(mocks.invoke.mock.calls.some((c) => c[0] === 'execute_action')).toBe(
      false,
    );
  });

  it('Stop during recovery prevents another capture or input', async () => {
    responses = [reply('click', { coordinate: [100, 900] })];
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((cmd, args) =>
      cmd === 'prepare_action'
        ? Promise.reject(screenChanged())
        : original(cmd, args),
    );
    const { result } = renderHook(() => useAgent());
    let task!: Promise<void>;
    act(() => {
      task = result.current.runTask('Open Chrome', settings, false);
    });
    await waitFor(() =>
      expect(
        result.current.messages.some((m) =>
          m.content.includes('Taking a fresh screenshot'),
        ),
      ).toBe(true),
    );
    await act(async () => {
      result.current.stopTask();
      await task;
    });
    expect(result.current.task?.status).toBe('stopped');
    expect(observationNumber).toBe(1);
    expect(mocks.invoke.mock.calls.some((c) => c[0] === 'execute_action')).toBe(
      false,
    );
  });

  it('resets consecutive retries after input but still bounds total recovery for the run', async () => {
    responses = Array.from({ length: 13 }, (_, i) =>
      reply(
        'click',
        { coordinate: [100 + i, 900] },
        i > 0 && i % 2 === 0
          ? {
              outcome: {
                status: 'succeeded',
                evidence: 'Previous input reached its target',
              },
            }
          : undefined,
      ),
    );
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((cmd, args) =>
      cmd === 'prepare_action' && observationNumber % 2 === 1
        ? Promise.reject(screenChanged())
        : original(cmd, args),
    );
    const { result } = renderHook(() => useAgent());
    await act(async () => {
      await result.current.runTask(
        'Open Chrome',
        { ...settings, maxTurns: 30 },
        false,
      );
    });
    expect(result.current.task?.status).toBe('needs_user');
    expect(result.current.error).toContain('after automatic recovery attempts');
    expect(observationNumber).toBe(13);
    expect(
      mocks.invoke.mock.calls.filter((c) => c[0] === 'execute_action'),
    ).toHaveLength(6);
  });

  it('does not reuse Allow once for a newly targeted action after recovery', async () => {
    responses = [
      reply('click', { coordinate: [100, 900] }),
      reply('click', { coordinate: [600, 400] }),
    ];
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((cmd, args) =>
      cmd === 'execute_action'
        ? Promise.reject(screenChanged())
        : original(cmd, args),
    );
    const { result } = renderHook(() => useAgent());
    let task!: Promise<void>;
    act(() => {
      task = result.current.runTask('Open Chrome', settings);
    });
    await waitFor(() =>
      expect(result.current.pendingConfirmation).not.toBeNull(),
    );
    act(() => {
      result.current.pendingConfirmation!.onConfirm();
    });
    await waitFor(() =>
      expect(result.current.pendingConfirmation?.message).toContain('600, 400'),
    );
    expect(
      mocks.invoke.mock.calls.filter((c) => c[0] === 'approve_action'),
    ).toHaveLength(1);
    expect(
      mocks.invoke.mock.calls.filter((c) => c[0] === 'execute_action'),
    ).toHaveLength(1);
    await act(async () => {
      result.current.pendingConfirmation!.onDeny();
      await task;
    });
    expect(result.current.task?.status).toBe('needs_user');
    expect(result.current.error).toContain('denied by user');
  });

  it.each([
    'Target window changed since the screenshot; capture again',
    {
      code: 'action_rejected',
      message: 'The agent cannot control its own window',
      input_may_have_been_sent: false,
    },
  ])(
    'does not retry unclassified or forbidden native errors: %j',
    async (failure) => {
      responses = [reply('click', { coordinate: [100, 900] })];
      const original = mocks.invoke.getMockImplementation()!;
      mocks.invoke.mockImplementation((cmd, args) =>
        cmd === 'prepare_action'
          ? Promise.reject(failure)
          : original(cmd, args),
      );
      const { result } = renderHook(() => useAgent());
      await act(async () => {
        await result.current.runTask('Open Chrome', settings, false);
      });
      expect(result.current.task?.status).toBe('needs_user');
      expect(observationNumber).toBe(1);
      expect(result.current.error).not.toContain('[object Object]');
    },
  );

  it('allows the rest of a task from one prompt, but new runs still require approval', async () => {
    const observed = {
      status: 'succeeded' as const,
      evidence: 'New page visible',
    };
    responses = [
      reply('key', { key: 'enter' }),
      reply('key', { key: 'tab' }, { outcome: observed }),
      reply('done', { text: 'Requested page visible' }, { outcome: observed }),
      reply('done', { text: 'Requested page still visible' }),
    ];
    const { result } = renderHook(() => useAgent());
    let task!: Promise<void>;
    act(() => {
      task = result.current.runTask('Open page', settings);
    });
    await waitFor(() =>
      expect(result.current.pendingConfirmation?.onAllowTask).toBeDefined(),
    );
    await act(async () => {
      result.current.pendingConfirmation!.onAllowTask!();
      await task;
    });
    expect(
      mocks.invoke.mock.calls.filter((c) => c[0] === 'approve_action'),
    ).toHaveLength(1);
    expect(
      mocks.invoke.mock.calls.find((c) => c[0] === 'approve_action')![1]
        .allowForTask,
    ).toBe(true);
    expect(
      mocks.invoke.mock.calls.filter((c) => c[0] === 'execute_action'),
    ).toHaveLength(2);
    expect(result.current.task?.status).toBe('completed');
    expect(result.current.isDirectControl).toBe(false);
    responses = [reply('key', { key: 'enter' })];
    act(() => {
      task = result.current.runTask('Another task', settings);
    });
    await waitFor(() =>
      expect(result.current.pendingConfirmation?.onAllowTask).toBeDefined(),
    );
    const lateAllow = result.current.pendingConfirmation!.onAllowTask!;
    await act(async () => {
      result.current.stopTask();
      lateAllow();
      await task;
    });
    expect(
      mocks.invoke.mock.calls.filter((c) => c[0] === 'approve_action'),
    ).toHaveLength(1);
  });

  it('does not offer task-wide permission for a model question', async () => {
    responses = [reply('confirm', { text: 'Which report should I open?' })];
    const { result } = renderHook(() => useAgent());
    let task!: Promise<void>;
    act(() => {
      task = result.current.runTask('Open report', settings, false);
    });
    await waitFor(() =>
      expect(result.current.pendingConfirmation).not.toBeNull(),
    );
    expect(result.current.pendingConfirmation?.onAllowTask).toBeUndefined();
    await act(async () => {
      result.current.pendingConfirmation!.onDeny();
      await task;
    });
    expect(mocks.invoke.mock.calls.some((c) => c[0] === 'approve_action')).toBe(
      false,
    );
  });

  it('refines the same observation using task context and executes only the corrected point', async () => {
    responses = [
      reply(
        'click',
        { coordinate: [146, 900] },
        { expected_outcome: 'Chrome opens' },
      ),
    ];
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((cmd, args) =>
      cmd === 'refine_coordinate'
        ? Promise.resolve({
            coordinate: [146, 980],
            crop_image: 'zoom',
            crop_coordinate: [487, 934],
            crop_box: [],
            refined: true,
          })
        : original(cmd, args),
    );
    const { result } = renderHook(() => useAgent());
    let task!: Promise<void>;
    act(() => {
      task = result.current.runTask('Find weather in Philadelphia', {
        ...settings,
        zoomRefine: true,
        maxTurns: 1,
      });
    });
    await waitFor(() =>
      expect(result.current.pendingConfirmation).not.toBeNull(),
    );
    const refinement = mocks.invoke.mock.calls.find(
      (c) => c[0] === 'refine_coordinate',
    )![1];
    expect(refinement.observationId).toBe('obs-1');
    expect(refinement.query).toContain('Find weather in Philadelphia');
    expect(refinement.query).toContain('Chrome opens');
    expect(result.current.pendingConfirmation!.preview).toEqual({
      image: 'zoom',
      coordinate: [487, 934],
    });
    await act(async () => {
      result.current.pendingConfirmation!.onAllowTask!();
      await task;
    });
    const prepared = mocks.invoke.mock.calls.find(
      (c) => c[0] === 'prepare_action',
    )![1];
    expect(JSON.parse(prepared.action).arguments.coordinate).toEqual([
      146, 980,
    ]);
    expect(
      mocks.invoke.mock.calls.filter((c) => c[0] === 'execute_action'),
    ).toHaveLength(1);
  });

  it('repairs a rejected wire response with its exact error and output before preparing input', async () => {
    const rejected =
      '<tool_call>{"name":"computer","arguments":{"action":"key","keys":["enter"]}}</tool_call>';
    responses = [
      {
        ...reply('none'),
        success: false,
        output_text: rejected,
        error:
          'Failed to parse response: Invalid computer tool call: unknown field `keys`, expected `key`',
      },
      reply('key', { key: 'enter' }),
    ];
    const { result } = renderHook(() => useAgent());
    let task!: Promise<void>;
    act(() => {
      task = result.current.runTask('Open the selected item', {
        ...settings,
        maxTurns: 2,
      });
    });
    await waitFor(() =>
      expect(result.current.pendingConfirmation).not.toBeNull(),
    );
    expect(
      mocks.invoke.mock.calls.filter((c) => c[0] === 'prepare_action'),
    ).toHaveLength(1);
    expect(mocks.invoke.mock.calls.some((c) => c[0] === 'execute_action')).toBe(
      false,
    );
    const requests = mocks.invoke.mock.calls.filter(
      (c) => c[0] === 'process_computer_use',
    );
    expect(requests[1][1].query).toContain('unknown field `keys`');
    expect(requests[1][1].priorTurns[0].assistant_content).toContain(rejected);
    expect(
      result.current.messages.find((m) => m.modelResponse)?.modelResponse,
    ).toBe(rejected);
    expect(result.current.messages.find((m) => m.modelResponse)?.content)
      .toContain('unknown field `keys`');
    await act(async () => {
      result.current.pendingConfirmation!.onConfirm();
      await task;
    });
    expect(
      mocks.invoke.mock.calls.filter((c) => c[0] === 'execute_action'),
    ).toHaveLength(1);
  });

  it('pauses after bounded format repairs without executing or discarding the diagnostics', async () => {
    const invalid = {
      ...reply('none'),
      success: false,
      output_text: '{"bad":"response"}',
      error: 'Failed to parse response: missing field action',
    };
    responses = [invalid, invalid, invalid];
    const { result } = renderHook(() => useAgent());
    await act(async () => {
      await result.current.runTask('Open browser', settings);
    });
    expect(result.current.task?.status).toBe('needs_user');
    expect(result.current.messages.filter((m) => m.modelResponse)).toHaveLength(
      3,
    );
    expect(
      mocks.invoke.mock.calls.filter((c) => c[0] === 'process_computer_use'),
    ).toHaveLength(3);
    expect(mocks.invoke.mock.calls.some((c) => c[0] === 'prepare_action')).toBe(
      false,
    );
  });

  it('displays unsupported schema warnings and errors even when final output is empty', async () => {
    responses = Array.from({ length: 3 }, () => ({
      ...reply('none'),
      success: false,
      output_text: '',
      format_warning: 'Server does not support schema-constrained output.',
      error: 'Failed to parse response: The model returned no final answer or action',
    }));
    const { result } = renderHook(() => useAgent());
    await act(async () => {
      await result.current.runTask('Open browser', settings);
    });
    expect(result.current.messages.some((m) => m.content.includes('Server does not support'))).toBe(true);
    expect(result.current.messages.some((m) => m.content.includes('Model response rejected.') && m.content.includes('no final answer'))).toBe(true);
    expect(mocks.invoke.mock.calls.some((c) => c[0] === 'prepare_action')).toBe(false);
  });

  it('executes a first input whose progress wrongly reports an outcome (regression)', async () => {
    responses = [
      reply('plan', {
        text: JSON.stringify({
          steps: [
            { title: 'Open Chrome', success_criteria: 'Chrome window visible' },
          ],
        }),
      }),
      reply(
        'left_click',
        { coordinate: [150, 984] },
        {
          next_milestone_id: 'm1-1',
          outcome: {
            status: 'succeeded',
            evidence: 'Desktop is visible with no browser window open yet',
          },
        },
      ),
      reply('none', { text: 'Stopping here' }),
    ];
    const { result } = renderHook(() => useAgent());
    await act(async () => {
      await result.current.runTask(
        'What is the weather in Philadelphia?',
        { ...settings, enablePlanning: true },
        false,
      );
    });
    expect(
      mocks.invoke.mock.calls.filter((c) => c[0] === 'execute_action'),
    ).toHaveLength(1);
    expect(
      result.current.messages.some((m) =>
        m.content.includes('fresh observation'),
      ),
    ).toBe(false);
    expect(result.current.task?.receipts[0]).toMatchObject({
      milestoneId: 'm1-1',
      outcome: 'unverified',
    });
  });

  it('executes a click whose progress resolves an invented question ID (regression)', async () => {
    responses = [
      reply('plan', {
        text: JSON.stringify({
          steps: [
            { title: 'Open Chrome', success_criteria: 'Chrome window visible' },
          ],
        }),
      }),
      reply(
        'click',
        { coordinate: [151, 975] },
        {
          next_milestone_id: 'm1-1',
          outcome: {
            status: 'succeeded',
            evidence: 'Desktop is visible with Chrome icon in the taskbar',
          },
          resolve_questions: [
            {
              id: 'browser_location',
              answer: 'Chrome browser icon is visible in the taskbar',
              evidence: 'Chrome icon visible in taskbar',
            },
          ],
        },
      ),
      reply('none', { text: 'Stopping here' }),
    ];
    const { result } = renderHook(() => useAgent());
    await act(async () => {
      await result.current.runTask(
        "What's the weather in philadelphia like?",
        { ...settings, enablePlanning: true },
        false,
      );
    });
    expect(
      mocks.invoke.mock.calls.filter((c) => c[0] === 'execute_action'),
    ).toHaveLength(1);
    expect(
      result.current.messages.some((m) => m.content.includes('invalid response')),
    ).toBe(false);
  });

  it('simple format: runs a flat tool-call task without any progress object', async () => {
    const flat = (
      action: string,
      args: object,
      report?: AgentResponse['action']['report'],
    ): AgentResponse => ({
      ...reply(action, args),
      action: { action, arguments: args, ...(report ? { report } : {}) },
    });
    responses = [
      reply('plan', {
        text: JSON.stringify({
          steps: [
            { title: 'Open Chrome', success_criteria: 'Chrome window visible' },
            { title: 'Search', success_criteria: 'Weather results visible' },
          ],
        }),
      }),
      flat('click', { coordinate: [151, 975] }, { screen: 'Desktop' }),
      // No last_action and no step flag: previously a hard failure.
      flat('key', { key: 'ctrl+l' }),
      flat(
        'type',
        { text: 'weather philadelphia' },
        { screen: 'Chrome open', last_action: 'worked', step_done: true },
      ),
      flat('done', { text: 'Weather for Philadelphia is shown' }),
      flat('done', { text: 'Weather still shown' }),
    ];
    const { result } = renderHook(() => useAgent());
    await act(async () => {
      await result.current.runTask(
        'Weather in Philadelphia',
        { ...settings, simpleToolFormat: true, enablePlanning: true },
        false,
      );
    });
    expect(result.current.error).toBeNull();
    expect(result.current.task?.status).toBe('completed');
    expect(
      mocks.invoke.mock.calls.filter((c) => c[0] === 'execute_action'),
    ).toHaveLength(3);
    expect(result.current.task?.receipts.map((r) => r.outcome)).toEqual([
      'uncertain',
      'succeeded',
      'succeeded',
    ]);
    expect(result.current.task?.plan.map((s) => s.status)).toEqual([
      'completed',
      'completed',
    ]);
    const calls = mocks.invoke.mock.calls.filter(
      (c) => c[0] === 'process_computer_use',
    );
    expect(calls[0][1].simpleTools).toBe(true);
    expect(calls[0][1].systemPrompt).toContain('step_done');
    expect(calls[0][1].systemPrompt).not.toContain('resolve_questions');
    expect(calls[2][1].query).toContain('Set last_action from THIS screenshot');
    expect(calls[2][1].query).not.toContain('progress.outcome');
  });

  it('tracks two milestones through observed outcomes and keeps metadata out of native input', async () => {
    responses = [
      reply('plan', {
        text: JSON.stringify({
          steps: [
            { title: 'Open report', success_criteria: 'Report visible' },
            {
              title: 'Save report',
              success_criteria: 'Saved label visible',
            },
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
          outcome: {
            status: 'succeeded',
            evidence: 'Saved indicator visible',
          },
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
      await result.current.runTask(
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
      await result.current.runTask(
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
      await result.current.runTask(
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
      outcome: {
        status: 'uncertain' as const,
        evidence: 'Screen unchanged',
      },
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
          outcome: {
            status: 'succeeded',
            evidence: 'Report text visible',
          },
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
      await result.current.runTask(
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
      task = result.current.runTask(
        'Open report',
        { ...settings, enablePlanning: true },
        false,
      );
    });
    await waitFor(() => expect(resolveReview).toBeDefined());
    await act(async () => {
      result.current.stopTask();
      resolveReview(
        reply(
          'done',
          { text: 'Done' },
          {
            milestones: [
              {
                id: 'm1-1',
                status: 'completed',
                evidence: 'Late evidence',
              },
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
      task = result.current.runTask('Click the editor', settings);
    });
    await waitFor(() =>
      expect(result.current.pendingConfirmation).not.toBeNull(),
    );
    const lateAllow = result.current.pendingConfirmation!.onConfirm;
    await act(async () => {
      result.current.stopTask();
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
      task = result.current.runTask('Test', settings);
    });
    await waitFor(() => expect(captureResolve).toBeDefined());
    await act(async () => {
      result.current.stopTask();
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
        {
          outcome: {
            status: 'succeeded',
            evidence: 'Saved label visible',
          },
        },
      ),
      reply('done', { text: 'Saved label still visible' }),
    ];
    const { result } = renderHook(() => useAgent());
    let task!: Promise<void>;
    act(() => {
      task = result.current.runTask('Save', settings);
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

  it('keeps a debug preview isolated and revokes its run even when it proposes input', async () => {
    responses = [
      reply('plan', { text: 'Open Notepad' }),
      reply('click', { coordinate: [200, 400] }),
    ];
    const { result } = renderHook(() => useAgent());
    await act(async () => {
      await result.current.runTask('Open Notepad', settings, true, false, true);
    });
    const checkpoint = structuredClone(result.current.task);
    await act(async () => {
      await result.current.previewAction('Preview the browser icon', settings);
    });
    expect(result.current.task).toEqual(checkpoint);
    expect(result.current.messages.at(-1)?.content).toContain(
      'Preview only — no input executed.',
    );
    expect(mocks.invoke.mock.calls.some((c) => c[0] === 'prepare_action')).toBe(
      false,
    );
    expect(mocks.invoke.mock.calls.at(-1)?.[0]).toBe('stop_run');
    expect(
      mocks.invoke.mock.calls
        .filter((c) => c[0] === 'process_computer_use')
        .at(-1)![1].priorTurns,
    ).toEqual([]);
  });

  it('stops unchanged action/screen repetition before a third execution', async () => {
    responses = Array.from({ length: 3 }, (_, i) =>
      reply(
        'key',
        { key: 'enter' },
        i
          ? {
              outcome: {
                status: 'uncertain',
                evidence: 'Screen unchanged',
              },
            }
          : undefined,
      ),
    );
    const { result } = renderHook(() => useAgent());
    await act(async () => {
      await result.current.runTask('Test', { ...settings, maxTurns: 3 }, false);
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
      await result.current.runTask(
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
      await result.current.runTask('Continue', settings, true, true);
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
      await result.current.runTask(
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
