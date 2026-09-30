import { buildSystemPrompt } from '../agent/protocol';
import {
  errorMessage,
  isInvalidProposal,
  isScreenChanged,
} from '../agent/controlError';
import { useState, useCallback, useRef, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  Settings,
  AgentResponse,
  Message,
  ScreenshotWithMetadata,
  ActionResult,
  TaskRecord,
} from '../types';
import {
  TaskMemory,
  TaskUpdateError,
  actionKey,
  isInput,
  isUnchanged,
} from '../agent/memory';

export interface ConfirmationRequest {
  message: string;
  onConfirm: () => void;
  onDeny: () => void;
  onAllowTask?: () => void;
  preview?: { image: string; coordinate: number[] };
}
type Approval = false | 'once' | 'task';
interface Proposal {
  id: string;
  action: ActionResult;
  requires_approval: boolean;
}
function describeAction(action: ActionResult): string {
  const a = action.arguments;
  if (action.action === 'type') return `Type this text:\n${a.text}`;
  if (action.action === 'key') return `Press ${a.key}`;
  if (action.action === 'scroll')
    return `Scroll ${a.direction} by ${a.amount ?? 5} at ${a.coordinate?.join(', ')}`;
  if (action.action === 'left_click_drag')
    return `Drag from ${a.start_coordinate?.join(', ')} to ${a.end_coordinate?.join(', ')}`;
  return `${action.action.replace(/_/g, ' ')} at ${a.coordinate?.join(', ')}`;
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// Local models occasionally need more than one nudge to fix their wire format.
export const MAX_FORMAT_REPAIRS = 2;
// Consecutive proposals the controller may reject (before any input) and
// send back to the model for a different action.
export const MAX_REJECTED_PROPOSALS = 2;
// Characters of a rejected response replayed to the model for its repair.
export const MAX_REJECTED_REPLAY = 600;
// Model calls allowed per permitted action, plus a few for planning,
// verification and repairs, so bookkeeping never ends a run early.
export const modelCallLimit = (maxActions: number) => 2 * maxActions + 5;

type StopReason = 'user' | 'emergency' | 'time_limit';

const modelConfig = (settings: Settings) => ({
  apiEndpoint: settings.apiEndpoint,
  modelId: settings.modelId,
  enableThinking: settings.enableThinking,
  maxTokens: settings.maxTokens,
});

export function useAgent() {
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentScreenshot, setCurrentScreenshot] = useState<string | null>(
    null,
  );
  const [messages, updateMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [currentTurn, setCurrentTurn] = useState(0);
  const [isTaskRunning, setIsTaskRunning] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isDirectControl, setIsDirectControl] = useState(false);
  const [pendingConfirmation, setPendingConfirmation] =
    useState<ConfirmationRequest | null>(null);
  const [task, setTask] = useState<TaskRecord | null>(null);
  const busy = useRef(false);
  const stopped = useRef(false);
  const stopReason = useRef<StopReason>('user');
  const runId = useRef<string | null>(null);
  const observation = useRef<string | null>(null);
  const confirmation = useRef<((value: Approval) => void) | null>(null);
  const actionPreview = useRef<ConfirmationRequest['preview']>();
  const memory = useRef(new TaskMemory());

  const publishTask = useCallback(
    () =>
      setTask(
        memory.current.task ? structuredClone(memory.current.task) : null,
      ),
    [],
  );
  const message = useCallback(
    (role: Message['role'], content: string, extra: Partial<Message> = {}) => {
      updateMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role,
          content,
          timestamp: new Date(),
          ...extra,
        },
      ]);
    },
    [],
  );
  const assertRunning = useCallback(() => {
    if (stopped.current || !runId.current) throw new Error('Run stopped');
    return runId.current;
  }, []);

  const halt = useCallback((reason: StopReason) => {
    // The first reason wins: a time limit after a user stop is still a user stop.
    if (!stopped.current) stopReason.current = reason;
    stopped.current = true;
    if (busy.current) setIsStopping(true);
    confirmation.current?.(false);
    confirmation.current = null;
    setPendingConfirmation(null);
    if (runId.current)
      void invoke('stop_run', { runId: runId.current }).catch(() => {});
  }, []);
  const stopTask = useCallback(() => halt('user'), [halt]);

  useEffect(() => {
    const unlisten = listen('agent-stopped', () => halt('emergency'));
    return () => {
      halt('user');
      void unlisten.then((fn) => fn()).catch(() => {});
    };
  }, [halt]);

  const start = useCallback(async (supervised: boolean) => {
    stopped.current = false;
    stopReason.current = 'user';
    setIsStopping(false);
    setIsDirectControl(!supervised);
    observation.current = null;
    const previous = runId.current;
    if (previous) await invoke('stop_run', { runId: previous });
    const id = await invoke<string>('start_run', { supervised });
    runId.current = id;
    if (stopped.current) {
      await invoke('stop_run', { runId: id });
      throw new Error('Run stopped');
    }
    return id;
  }, []);

  const finishRun = useCallback(async () => {
    const id = runId.current;
    runId.current = null;
    observation.current = null;
    if (id) await invoke('stop_run', { runId: id }).catch(() => {});
    setIsDirectControl(false);
  }, []);

  const requestApproval = useCallback(
    (
      text: string,
      allowTask = false,
      preview?: ConfirmationRequest['preview'],
    ): Promise<Approval> => {
      assertRunning();
      return new Promise((resolve) => {
        let settled = false;
        const settle = (approved: Approval) => {
          if (settled) return;
          settled = true;
          confirmation.current = null;
          setPendingConfirmation(null);
          resolve(stopped.current ? false : approved);
        };
        confirmation.current = settle;
        setPendingConfirmation({
          message: text,
          onConfirm: () => settle('once'),
          onDeny: () => settle(false),
          ...(allowTask ? { onAllowTask: () => settle('task') } : {}),
          preview,
        });
      });
    },
    [assertRunning],
  );

  const capture = useCallback(
    async (settings: Settings) => {
      const result = await invoke<ScreenshotWithMetadata>(
        'capture_screenshot_with_metadata',
        {
          runId: assertRunning(),
          maxDimension: settings.screenshotMaxDimension,
          settleMs: settings.settleTimeoutMs,
        },
      );
      assertRunning();
      observation.current = result.observation_id;
      memory.current.observe(result.observation_id, result.screen_change);
      setCurrentScreenshot(result.base64_image);
      actionPreview.current = undefined;
      return result;
    },
    [assertRunning],
  );

  const processTurn = useCallback(
    async (
      query: string,
      settings: Settings,
      shot: ScreenshotWithMetadata,
      step?: number,
    ) => {
      const boxFirst = settings.boxRefine && !settings.zoomRefine;
      const prompt = memory.current.prompt(query);
      const response = await invoke<AgentResponse>('process_computer_use', {
        runId: assertRunning(),
        screenshotBase64: shot.base64_image,
        query: prompt,
        model: modelConfig(settings),
        displayWidth: shot.image_width,
        displayHeight: shot.image_height,
        systemPrompt: buildSystemPrompt(settings.extraInstructions, {
          boxClicks: boxFirst,
        }),
        priorTurns: memory.current.context(),
      });
      assertRunning();
      if (response.format_warning) message('system', response.format_warning);
      if (!response.success) {
        message(
          'system',
          'Model response rejected. No input was executed.\n' +
            (response.error || 'Model request failed'),
          response.output_text ? { modelResponse: response.output_text } : {},
        );
        if (response.output_text) {
          // The start is enough to correct a format error. Replaying a whole
          // runaway response would crowd out history and prime the same loop.
          const excerpt =
            response.output_text.length > MAX_REJECTED_REPLAY
              ? response.output_text.slice(0, MAX_REJECTED_REPLAY) +
                ' [… truncated]'
              : response.output_text;
          memory.current.record(
            query,
            'Rejected output (not executed; correct its format):\n' + excerpt,
          );
        }
        throw new Error(response.error || 'Model request failed');
      }
      const click = [
        'click',
        'left_click',
        'right_click',
        'double_click',
      ].includes(response.action.action);
      const coord = response.action.arguments.coordinate;
      const extras: Partial<Message> = {};
      if (boxFirst && click && coord?.length === 4) {
        extras.screenshotBox = [...coord];
        response.action.arguments.coordinate = [
          (coord[0] + coord[2]) / 2,
          (coord[1] + coord[3]) / 2,
        ];
      }
      const point = response.action.arguments.coordinate;
      if (settings.zoomRefine && click && point?.length === 2) {
        const plan = memory.current.task?.plan || [];
        const target =
          plan.find((s) => s.status === 'in_progress') ||
          plan.find((s) => s.status === 'pending');
        const targetContext = [
          'Original task: ' + (memory.current.task?.goal || query),
          target ? 'Current milestone: ' + target.title : '',
          'Expected result of this click: ' +
            (target?.successCriteria || query),
        ]
          .filter(Boolean)
          .join('\n');
        const refined = await invoke<{
          coordinate: number[];
          crop_image: string;
          crop_coordinate: number[];
          crop_box: number[];
          refined: boolean;
        }>('refine_coordinate', {
          runId: assertRunning(),
          observationId: shot.observation_id,
          model: modelConfig(settings),
          coarseX: point[0],
          coarseY: point[1],
          actionType: response.action.action,
          query: targetContext,
          cropFraction: settings.zoomCropFraction,
          maxDimension: settings.screenshotMaxDimension,
          boxMode: settings.boxRefine,
        });
        assertRunning();
        if (!refined.refined)
          throw new Error(
            'Zoom targeting was inconclusive; no action executed',
          );
        response.action.arguments.coordinate = refined.coordinate;
        extras.zoomCrop = refined.crop_image;
        extras.zoomCropCoordinate = refined.crop_coordinate;
        extras.zoomCropBox = refined.crop_box;
      }
      actionPreview.current =
        extras.zoomCrop && extras.zoomCropCoordinate
          ? { image: extras.zoomCrop, coordinate: extras.zoomCropCoordinate }
          : response.action.arguments.coordinate
            ? {
                image: shot.base64_image,
                coordinate: response.action.arguments.coordinate,
              }
            : undefined;
      message(
        'assistant',
        (step === undefined ? 'Preview only — no input executed.\n' : '') +
          (response.output_text || JSON.stringify(response.action)),
        {
          action: response.action,
          screenshot: shot.base64_image,
          stepNumber:
            step === undefined
              ? undefined
              : (memory.current.task?.lastStep ?? step),
          thinking: response.thinking,
          ...extras,
        },
      );
      memory.current.record(
        query,
        response.output_text || JSON.stringify(response.action),
      );
      return response;
    },
    [assertRunning, message],
  );

  const performAction = useCallback(
    async (action: ActionResult) => {
      const id = assertRunning();
      const context = memory.current.actionContext(action);
      // Model-authored reports are never part of an executable proposal/approval.
      const executable = {
        action: action.action,
        arguments: action.arguments,
      };
      if (!observation.current)
        throw new Error('Capture the screen before acting');
      const proposal = await invoke<Proposal>('prepare_action', {
        runId: id,
        observationId: observation.current,
        action: JSON.stringify(executable),
      });
      assertRunning();
      if (proposal.requires_approval) {
        const allowed = await requestApproval(
          `${describeAction(proposal.action)}\n\nApproval expires after 60 seconds.`,
          true,
          actionPreview.current,
        );
        assertRunning();
        if (!allowed) throw new Error('Action denied by user');
        await invoke('approve_action', {
          runId: id,
          proposalId: proposal.id,
          allowForTask: allowed === 'task',
        });
        assertRunning();
        if (allowed === 'task') setIsDirectControl(true);
      }
      assertRunning();
      try {
        await invoke('execute_action', {
          runId: id,
          proposalId: proposal.id,
        });
      } catch (err) {
        if (isScreenChanged(err) && err.input_may_have_been_sent) {
          // A double click, drag, or typing sequence may have partly executed.
          // Force outcome review on the next observation before more input.
          memory.current.submitted(executable, {
            ...context,
            expected:
              'Input was interrupted; verify the actual effect before repeating. ' +
              context.expected,
          });
        }
        throw err;
      }
      memory.current.submitted(executable, context);
      assertRunning();
      publishTask();
    },
    [assertRunning, requestApproval, publishTask],
  );

  const previewAction = useCallback(
    async (
      query: string,
      settings: Settings,
    ): Promise<AgentResponse | null> => {
      if (busy.current) return null;
      busy.current = true;
      setIsProcessing(true);
      setError(null);
      message('user', query);
      const taskMemory = memory.current;
      memory.current = new TaskMemory();
      try {
        await start(true);
        const shot = await capture(settings);
        const response = await processTurn(query, settings, shot);
        // Preview is read-only; it cannot update the task or retain an input capability.
        return response;
      } catch (err) {
        const text = stopped.current ? 'Run stopped' : errorMessage(err);
        if (!stopped.current) setError(text);
        message('system', text);
        await finishRun();
        return null;
      } finally {
        await finishRun();
        memory.current = taskMemory;
        busy.current = false;
        setIsProcessing(false);
        setIsStopping(false);
      }
    },
    [capture, processTurn, message, start, finishRun, publishTask],
  );

  const runTask = useCallback(
    async (
      query: string,
      settings: Settings,
      supervised = true,
      resume = false,
      planOnly = false,
    ) => {
      if (busy.current) return;
      busy.current = true;
      setIsProcessing(true);
      setIsTaskRunning(true);
      setError(null);
      if (!resume || !memory.current.task)
        memory.current.start(query, settings.enablePlanning || planOnly);
      else memory.current.task.status = 'running';
      publishTask();
      message('user', query);
      let calls = 0,
        actions = 0,
        repeat = 0,
        previous = '',
        repair = 0,
        rejected = 0,
        verifying = false,
        completionRepair = 0,
        screenRetries = 0,
        totalScreenRetries = 0,
        replans = 0,
        requireReplan = false;
      let next = resume
        ? query +
          '\nRecheck saved milestone evidence against this fresh screen. Historical facts are context, not current proof.'
        : query;
      const minutes = Math.min(240, Math.max(1, settings.maxRunMinutes || 20));
      const timer = setTimeout(() => halt('time_limit'), minutes * 60 * 1000);
      // Only executed input counts toward the action limit; planning,
      // verification and repairs are bounded separately by the call limit.
      const maxActions = Math.min(100, Math.max(1, settings.maxTurns || 20));
      const maxCalls = modelCallLimit(maxActions);
      try {
        await start(supervised);
        while (actions < maxActions && calls < maxCalls) {
          assertRunning();
          setCurrentTurn(actions + 1);
          const shot = await capture(settings);
          calls++;
          const planning =
            memory.current.task?.status === 'planning' || requireReplan;
          const phasePrompt = requireReplan
            ? 'The previous approach repeated without progress. Return ONLY a plan action: steps with a different approach for the work still to do, then reason (what went wrong). Finished steps are kept automatically. Keep the original constraints. Do not propose input.'
            : planning
              ? 'Make a short plan for the original task. Return only a plan action whose steps are one to seven short strings like "Open Chrome -> a Chrome window is visible". Each step must be something done on screen with a visible result; do not add steps for reading, checking or reporting the answer, because done does that. Do not act yet.'
              : verifying
                ? 'Verify completion against every requirement of the original task using this NEW screenshot. Return done again, with the complete answer or result for the user in text, only if all requirements are met; otherwise take the next necessary action or explain what is missing.'
                : next;
          const prompt =
            phasePrompt +
            (repair > 0 && phasePrompt !== next ? '\n' + next : '');
          let response: AgentResponse;
          try {
            response = await processTurn(prompt, settings, shot, calls);
            if (planning && response.action.action !== 'plan')
              throw new TaskUpdateError(
                'return a plan before attempting input',
              );
            if (memory.current.task)
              // The controller derives milestones/outcomes from the flat
              // report instead of asking the model for them.
              memory.current.applyProgress(
                memory.current.progressFromReport(
                  response.action.report,
                  response.action.action === 'done'
                    ? response.action.arguments.text || ''
                    : undefined,
                ),
              );
            if (response.action.action === 'plan') {
              const args = response.action.arguments;
              memory.current.setPlan(args.steps ?? args.text, args.reason);
            }
            if (isInput(response.action))
              memory.current.actionContext(response.action);
            publishTask();
            repair = 0;
          } catch (err) {
            assertRunning();
            if (
              (String(err).includes('Failed to parse response') ||
                err instanceof TaskUpdateError) &&
              repair++ < MAX_FORMAT_REPAIRS
            ) {
              message(
                'system',
                `The model returned an invalid response. Asking it to correct it (${repair}/${MAX_FORMAT_REPAIRS}).\n` +
                  errorMessage(err),
              );
              next =
                'Your last output was invalid: ' +
                String(err) +
                '. Return exactly one complete final computer tool_call with valid arguments. No input was executed for that proposal.';
              continue;
            }
            throw err;
          }
          const action = response.action;
          if (action.action === 'plan') {
            requireReplan = false;
            verifying = false;
            completionRepair = 0;
            previous = '';
            repeat = 0;
            publishTask();
            if (planOnly) {
              memory.current.task!.status = 'stopped';
              message(
                'system',
                'Plan ready. Use Continue task to execute it with a fresh screen.',
              );
              break;
            }
            next =
              'Carry out the first unfinished milestone, one action at a time.';
            continue;
          }
          if (action.action === 'done') {
            if (!memory.current.canComplete()) {
              if (completionRepair++ >= 1)
                throw new Error(
                  'Completion is blocked by unfinished milestones:\n' +
                    memory.current.completionGaps(),
                );
              verifying = false;
              next =
                'Completion is not yet supported. Review the current screen and finish these steps (set step_done when one is visibly done), or explain what is blocked:\n' +
                memory.current.completionGaps();
              continue;
            }
            if (!verifying) {
              verifying = true;
              continue;
            }
            memory.current.task!.status = 'completed';
            message(
              'system',
              `✓ Task completed (confirmed on a fresh screen):\n${action.arguments.text}`,
            );
            break;
          }
          verifying = false;
          if (action.action === 'none') {
            memory.current.task!.status = 'needs_user';
            message(
              'system',
              'Model returned text. Task completion was not verified; continue or clarify the request.',
            );
            break;
          }
          if (action.action === 'confirm') {
            const allowed = await requestApproval(
              action.arguments.text || 'Continue with this task?',
            );
            assertRunning();
            if (!allowed) throw new Error('Action denied by user');
            next =
              'The user agreed to continue. Propose the next exact action; executor approval is still required in supervised mode.';
            continue;
          }
          // The same action again on a screen the last one did not visibly change.
          const key = actionKey(action);
          repeat =
            key === previous && isUnchanged(shot.screen_change) ? repeat + 1 : 1;
          previous = key;
          const recovery =
            repeat >= 3
              ? 'The same action and screen repeated without progress.'
              : memory.current.recoveryReason();
          if (recovery) {
            memory.current.blocked(recovery);
            publishTask();
            if (replans++ >= 1)
              throw new Error(
                'Repeated input still makes no progress after replanning. Task paused.',
              );
            requireReplan = true;
            verifying = false;
            continue;
          }
          try {
            await performAction(action);
          } catch (err) {
            assertRunning();
            if (
              isInvalidProposal(err) &&
              !err.input_may_have_been_sent &&
              rejected < MAX_REJECTED_PROPOSALS
            ) {
              // Nothing was sent, so the model can simply pick another action.
              rejected++;
              const reason = 'Rejected before any input: ' + errorMessage(err);
              message(
                'system',
                `The controller rejected that action before any input was sent. Asking the model for a different action (${rejected}/${MAX_REJECTED_PROPOSALS}).\n` +
                  errorMessage(err),
              );
              memory.current.interrupted(reason);
              memory.current.record('Controller execution result', reason);
              publishTask();
              next =
                'Your last proposed action was rejected before any input was sent: ' +
                errorMessage(err) +
                ' Choose a different action from this screen.';
              previous = '';
              repeat = 0;
              verifying = false;
              continue;
            }
            if (isScreenChanged(err)) {
              const outcome = err.input_may_have_been_sent
                ? 'Some input may have been sent. Inspect the new screen and set last_action before any further input. Do not blindly repeat the previous action.'
                : 'The proposed action was NOT executed. Do not report an outcome for that rejected proposal.';
              const reason = errorMessage(err) + ' ' + outcome;
              memory.current.interrupted(reason);
              memory.current.record('Controller execution result', reason);
              publishTask();
              if (screenRetries >= 3 || totalScreenRetries >= 6)
                throw new Error(
                  'The screen kept changing after automatic recovery attempts. Task paused. Last reason: ' +
                    errorMessage(err),
                );
              screenRetries++;
              totalScreenRetries++;
              message(
                'system',
                `The screen changed. Taking a fresh screenshot and retrying (${screenRetries}/3).`,
              );
              next =
                'Recover from a screen/window transition while continuing the original goal. ' +
                reason +
                ' Use this NEW screenshot to choose the next action. If Task View, a window switcher, or another overlay is open, select the intended application or dismiss the overlay when appropriate, then continue. Retry the intended icon only if the fresh screen shows it is still needed.';
              // A rejected proposal is not an executed no-progress loop.
              previous = '';
              repeat = 0;
              verifying = false;
              completionRepair = 0;
              for (let waited = 0; waited < 500; waited += 100) {
                assertRunning();
                await delay(100);
              }
              assertRunning();
              continue;
            }
            if (!stopped.current)
              memory.current.blocked(
                'Input outcome not confirmed: ' + errorMessage(err),
              );
            throw err;
          }
          actions++;
          screenRetries = 0;
          completionRepair = 0;
          rejected = 0;
          next =
            'Check whether the previous input achieved its intended result. Continue the next unfinished milestone with one action. If stuck, change approach or ask for help.';
          for (
            let waited = 0;
            waited < Math.min(10000, settings.actionDelayMs);
            waited += 100
          ) {
            assertRunning();
            await delay(100);
          }
        }
        if (
          memory.current.task?.status === 'running' ||
          memory.current.task?.status === 'planning'
        ) {
          memory.current.task.status = 'stopped';
          message(
            'system',
            actions >= maxActions
              ? `Reached the action limit (${maxActions}). Completion was not verified.`
              : `Reached the model-call limit (${maxCalls}) after ${actions} actions. Completion was not verified.`,
          );
        }
      } catch (err) {
        if (memory.current.task)
          memory.current.task.status = stopped.current
            ? 'stopped'
            : 'needs_user';
        const timedOut = stopped.current && stopReason.current === 'time_limit';
        const text = !stopped.current
          ? errorMessage(err)
          : timedOut
            ? `Stopped: the ${minutes}-minute time limit was reached.`
            : stopReason.current === 'emergency'
              ? 'Stopped by the emergency hotkey (Ctrl+Alt+F12).'
              : 'Execution stopped by user.';
        if (!stopped.current || timedOut) setError(text);
        message('system', text);
      } finally {
        clearTimeout(timer);
        await finishRun();
        confirmation.current?.(false);
        confirmation.current = null;
        setPendingConfirmation(null);
        publishTask();
        message('system', 'Task checkpoint saved in this conversation.', {
          task: memory.current.task
            ? structuredClone(memory.current.task)
            : undefined,
        });
        busy.current = false;
        setIsProcessing(false);
        setIsTaskRunning(false);
        setIsStopping(false);
        setCurrentTurn(0);
      }
    },
    [
      assertRunning,
      capture,
      processTurn,
      performAction,
      requestApproval,
      halt,
      publishTask,
      message,
      start,
      finishRun,
    ],
  );

  const clearMessages = useCallback(() => {
    if (busy.current) return;
    void finishRun();
    memory.current = new TaskMemory();
    updateMessages([]);
    setTask(null);
    setCurrentScreenshot(null);
  }, [finishRun]);
  const setMessages = useCallback(
    (loaded: Message[]) => {
      if (busy.current) return;
      void finishRun();
      memory.current.restore(loaded);
      updateMessages(loaded);
      publishTask();
    },
    [finishRun, publishTask],
  );
  const testConnection = useCallback(async (settings: Settings) => {
    try {
      return await invoke<boolean>('test_api_connection', {
        apiEndpoint: settings.apiEndpoint,
      });
    } catch {
      return false;
    }
  }, []);
  return {
    isProcessing,
    currentScreenshot,
    messages,
    error,
    currentTurn,
    isTaskRunning,
    isStopping,
    isDirectControl,
    pendingConfirmation,
    task,
    previewAction,
    runTask,
    stopTask,
    clearMessages,
    testConnection,
    setError,
    setMessages,
  };
}
