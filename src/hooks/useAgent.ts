import { buildSystemPrompt } from '../agent/protocol';
import { errorMessage, isScreenChanged } from '../agent/controlError';
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
  actionSignature,
  isInput,
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

  const stopTask = useCallback(() => {
    stopped.current = true;
    if (busy.current) setIsStopping(true);
    confirmation.current?.(false);
    confirmation.current = null;
    setPendingConfirmation(null);
    if (runId.current)
      void invoke('stop_run', { runId: runId.current }).catch(() => {});
  }, []);

  useEffect(() => {
    const unlisten = listen('agent-stopped', stopTask);
    return () => {
      stopTask();
      void unlisten.then((fn) => fn()).catch(() => {});
    };
  }, [stopTask]);

  const start = useCallback(async (supervised: boolean) => {
    stopped.current = false;
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
        },
      );
      assertRunning();
      observation.current = result.observation_id;
      memory.current.observe(result.observation_id);
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
        apiEndpoint: settings.apiEndpoint,
        modelId: settings.modelId,
        displayWidth: shot.image_width,
        displayHeight: shot.image_height,
        systemPrompt:
          buildSystemPrompt(settings.systemPrompt) +
          (boxFirst
            ? '\nFor click actions, coordinate must be a tight [x0,y0,x1,y1] bounding box in 0–1000 space.'
            : ''),
        enableThinking: settings.enableThinking,
        priorTurns: memory.current.context(),
      });
      assertRunning();
      if (!response.success) {
        if (response.output_text) {
          message('system', 'Model response rejected. No input was executed.', {
            modelResponse: response.output_text,
          });
          memory.current.record(
            query,
            'Rejected output (not executed; correct its format):\n' +
              response.output_text,
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
          plan.find(
            (s) => s.id === response.action.progress?.next_milestone_id,
          ) ||
          plan.find((s) => s.status === 'in_progress') ||
          plan.find((s) => s.status === 'pending');
        const targetContext = [
          'Original task: ' + (memory.current.task?.goal || query),
          target ? 'Current milestone: ' + target.title : '',
          'Expected result of this click: ' +
            (response.action.progress?.expected_outcome ||
              target?.successCriteria ||
              query),
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
          apiEndpoint: settings.apiEndpoint,
          modelId: settings.modelId,
          coarseX: point[0],
          coarseY: point[1],
          actionType: response.action.action,
          query: targetContext,
          cropFraction: settings.zoomCropFraction,
          maxDimension: settings.screenshotMaxDimension,
          enableThinking: settings.enableThinking,
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
      const context = memory.current.actionContext(action, action.progress);
      // Model-authored memory is never part of an executable proposal/approval.
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
      let turn = 0,
        repeat = 0,
        previous = '',
        repair = 0,
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
      const timer = setTimeout(stopTask, 20 * 60 * 1000);
      try {
        await start(supervised);
        const maxTurns = Math.min(100, Math.max(1, settings.maxTurns || 20));
        while (turn < maxTurns) {
          assertRunning();
          setCurrentTurn(turn + 1);
          const shot = await capture(settings);
          const planning =
            memory.current.task?.status === 'planning' || requireReplan;
          const phasePrompt = requireReplan
            ? 'The previous approach repeated without progress. Return ONLY a plan action with a reason and a different approach for unfinished milestones. Preserve completed milestones and original constraints. Do not propose input.'
            : planning
              ? 'Make a short plan for the original task. Return only a plan action with text JSON containing one to seven steps, each with title and observable success_criteria. Do not act yet.'
              : verifying
                ? 'Verify completion against every requirement of the original task using this NEW screenshot. Return done with observed evidence only if all requirements are met; otherwise take the next necessary action or explain what is missing.'
                : next;
          const prompt =
            phasePrompt +
            (repair > 0 && phasePrompt !== next ? '\n' + next : '');
          let response: AgentResponse;
          try {
            response = await processTurn(prompt, settings, shot, turn + 1);
            if (planning && response.action.action !== 'plan')
              throw new TaskUpdateError(
                'return a plan before attempting input',
              );
            if (response.action.progress)
              memory.current.applyProgress(response.action.progress);
            if (response.action.action === 'plan')
              memory.current.setPlan(response.action.arguments.text || '');
            if (isInput(response.action))
              memory.current.actionContext(
                response.action,
                response.action.progress,
              );
            publishTask();
            repair = 0;
          } catch (err) {
            assertRunning();
            if (
              (String(err).includes('Failed to parse response') ||
                err instanceof TaskUpdateError) &&
              repair++ < 1
            ) {
              message(
                'system',
                'The model returned an invalid format. Asking it to correct the response once.',
              );
              next =
                'Your last output was invalid: ' +
                String(err) +
                '. Return exactly one complete final computer tool_call with valid progress/arguments. No input was executed for that proposal.';
              turn++;
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
            turn++;
            continue;
          }
          if (action.action === 'done') {
            if (!memory.current.canComplete()) {
              if (completionRepair++ >= 1)
                throw new Error(
                  'Completion is blocked by unfinished milestones or unresolved memory:\n' +
                    memory.current.completionGaps(),
                );
              verifying = false;
              next =
                'Completion is not yet supported. Review the current screen, update progress and resolve these gaps, or explain what is blocked:\n' +
                memory.current.completionGaps();
              turn++;
              continue;
            }
            if (!verifying) {
              verifying = true;
              turn++;
              continue;
            }
            memory.current.task!.status = 'completed';
            message(
              'system',
              `✓ Task completed — model checked a fresh screen: ${action.arguments.text}`,
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
            turn++;
            continue;
          }
          const signature = actionSignature(action, shot.base64_image);
          repeat = signature === previous ? repeat + 1 : 1;
          previous = signature;
          const recovery =
            repeat >= 3
              ? 'The same action and screen repeated without progress.'
              : memory.current.recoveryReason();
          if (recovery) {
            memory.current.blocked(
              recovery,
              action.progress?.next_milestone_id,
            );
            publishTask();
            if (replans++ >= 1)
              throw new Error(
                'Repeated input still makes no progress after replanning. Task paused.',
              );
            requireReplan = true;
            verifying = false;
            turn++;
            continue;
          }
          try {
            await performAction(action);
          } catch (err) {
            assertRunning();
            if (isScreenChanged(err)) {
              const outcome = err.input_may_have_been_sent
                ? 'Some input may have been sent. Inspect the new screen and report progress.outcome before any further input. Do not blindly repeat the previous action.'
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
              turn++;
              continue;
            }
            if (!stopped.current)
              memory.current.blocked(
                'Input outcome not confirmed: ' + errorMessage(err),
                action.progress?.next_milestone_id,
              );
            throw err;
          }
          screenRetries = 0;
          completionRepair = 0;
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
          turn++;
        }
        if (
          memory.current.task?.status === 'running' ||
          memory.current.task?.status === 'planning'
        ) {
          memory.current.task.status = 'stopped';
          message(
            'system',
            `Reached the turn limit (${Math.min(100, settings.maxTurns)}). Completion was not verified.`,
          );
        }
      } catch (err) {
        if (memory.current.task)
          memory.current.task.status = stopped.current
            ? 'stopped'
            : 'needs_user';
        const text = stopped.current
          ? 'Execution stopped by user or emergency/time limit.'
          : errorMessage(err);
        if (!stopped.current) setError(text);
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
      stopTask,
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
