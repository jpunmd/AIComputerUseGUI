import { useState, useCallback, useRef } from 'react';
import { flushSync } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { Settings, AgentResponse, Message, ScreenshotWithMetadata } from '../types';

export interface ConfirmationRequest {
  message: string;
  onConfirm: () => void;
  onDeny: () => void;
  onAlwaysAllow: () => void;
}

// Screenshot capture result with dimensions
interface ScreenshotCapture {
  base64: string;
  imageWidth: number;
  imageHeight: number;
  screenWidth: number;
  screenHeight: number;
}

// A previously executed turn — sent back to the backend so the model gets
// real conversation continuity (and prior thinking when preserve_thinking is on)
interface PriorTurn {
  user_query: string;
  assistant_content: string;
  assistant_thinking?: string;
}

// Appended to the system prompt when bounding-box clicks are on but zoom refine
// is off, so the single grounding pass returns a box we click the center of.
// (With zoom refine on, pass 2 carries the box instructions instead — see
// refine_coordinate in the backend.)
const BOX_CLICK_ADDENDUM = `

# Bounding Box Click Targeting
- For click actions (click, left_click, right_click, double_click), return "coordinate" as a TIGHT bounding box [x0, y0, x1, y1] around the clickable element itself — top-left corner then bottom-right corner, in the same normalized 0-1000 space
- Box only the clickable element (icon glyph, button, or input field); do NOT include a text label or caption beside or beneath an icon
- The click will be performed at the center of your box
- All other actions keep their normal arguments`;

export function useAgent() {
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentScreenshot, setCurrentScreenshot] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [currentTurn, setCurrentTurn] = useState(0);
  const [isMultiTurnRunning, setIsMultiTurnRunning] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [pendingConfirmation, setPendingConfirmation] = useState<ConfirmationRequest | null>(null);
  const stopRequestedRef = useRef(false);
  const confirmationResolveRef = useRef<((confirmed: boolean) => void) | null>(null);
  const priorTurnsRef = useRef<PriorTurn[]>([]); // Conversation history for thinking preservation

  // Capture screenshot with metadata (dimensions)
  const captureScreenshotWithMetadata = useCallback(async (maxDimension?: number): Promise<ScreenshotCapture | null> => {
    try {
      const result = await invoke<ScreenshotWithMetadata>('capture_screenshot_with_metadata', {
        maxDimension: maxDimension ?? null
      });
      // Use flushSync to ensure the screenshot is rendered immediately
      flushSync(() => {
        setCurrentScreenshot(result.base64_image);
      });
      return {
        base64: result.base64_image,
        imageWidth: result.image_width,
        imageHeight: result.image_height,
        screenWidth: result.actual_screen_width,
        screenHeight: result.actual_screen_height,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(`Failed to capture screenshot: ${errorMessage}`);
      return null;
    }
  }, []);

  const captureScreenshot = useCallback(async (maxDimension?: number): Promise<string | null> => {
    try {
      const screenshot = await invoke<string>('capture_screenshot', {
        maxDimension: maxDimension ?? null
      });
      // Use flushSync to ensure the screenshot is rendered immediately
      flushSync(() => {
        setCurrentScreenshot(screenshot);
      });
      return screenshot;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(`Failed to capture screenshot: ${errorMessage}`);
      return null;
    }
  }, []);

  // Helper function to delay execution
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  // Single turn processing - returns the response without executing
  // imageWidth/imageHeight = dimensions of the image the model sees
  // These should be passed to the API so the model's coordinate system matches the image
  const processSingleTurn = useCallback(async (
    query: string,
    settings: Settings,
    screenshot: string,
    imageWidth: number,
    imageHeight: number,
    isFollowUp: boolean = false,
    stepNumber?: number,
    priorTurns?: PriorTurn[],
    // The user's original task, for the zoom-refine pass. Follow-up turns wrap
    // the task in action history and meta-instructions that would only confuse
    // pass 2's "Goal:" prompt.
    originalGoal?: string
  ): Promise<AgentResponse | null> => {
    try {
      // Add user message only for initial query
      if (!isFollowUp) {
        const userMessage: Message = {
          id: crypto.randomUUID(),
          role: 'user',
          content: query,
          timestamp: new Date(),
          screenshot,
        };
        setMessages(prev => [...prev, userMessage]);
      }

      // Box mode applies to whichever pass does the final grounding: pass 2
      // when zoom refine is on, otherwise pass 1 via a system prompt addendum.
      const boxFirstPass = settings.boxRefine && !settings.zoomRefine;

      // Send to backend.
      // Pass IMAGE dimensions (not screen dimensions) so model's coordinate system matches
      const response = await invoke<AgentResponse>('process_computer_use', {
        screenshotBase64: screenshot,
        query,
        apiEndpoint: settings.apiEndpoint,
        modelId: settings.modelId,
        displayWidth: imageWidth,
        displayHeight: imageHeight,
        systemPrompt: boxFirstPass ? settings.systemPrompt + BOX_CLICK_ADDENDUM : settings.systemPrompt,
        enableThinking: settings.enableThinking,
        priorTurns: priorTurns && priorTurns.length > 0 ? priorTurns : null,
      });

      // Optional second pass: coarse-to-fine zoom. Re-click on a magnified crop
      // centered on the coarse prediction so a small/edge target spans many more
      // patches. Mutates the action's coordinate in place so execution and the
      // crosshair overlay both use the refined point.
      let zoomCrop: string | undefined;
      let zoomCropCoordinate: number[] | undefined;
      let zoomCropBox: number[] | undefined;
      const refinable = ['click', 'left_click', 'right_click', 'double_click'].includes(
        response.action?.action ?? ''
      );

      // Single-pass box mode: collapse the model's [x0,y0,x1,y1] box to its
      // center so execution and the crosshair overlay click one point. Keep the
      // raw box to draw on the screenshot in the chat history.
      let screenshotBox: number[] | undefined;
      const rawCoord = response.action?.arguments?.coordinate;
      if (boxFirstPass && refinable && rawCoord && rawCoord.length >= 4) {
        screenshotBox = rawCoord.slice(0, 4);
        response.action.arguments.coordinate = [
          (rawCoord[0] + rawCoord[2]) / 2,
          (rawCoord[1] + rawCoord[3]) / 2,
        ];
      }

      // Skip the second API call if the user already pressed Stop — the action
      // won't be executed anyway.
      const coord = response.action?.arguments?.coordinate;
      if (settings.zoomRefine && !stopRequestedRef.current && refinable && coord && coord.length >= 2) {
        try {
          const refined = await invoke<{ coordinate: number[]; crop_coordinate: number[]; crop_box: number[]; crop_image: string; refined: boolean }>(
            'refine_coordinate',
            {
              apiEndpoint: settings.apiEndpoint,
              modelId: settings.modelId,
              coarseX: coord[0],
              coarseY: coord[1],
              actionType: response.action.action,
              query: originalGoal ?? query,
              cropFraction: settings.zoomCropFraction,
              maxDimension: settings.screenshotMaxDimension,
              enableThinking: settings.enableThinking,
              boxMode: settings.boxRefine,
            }
          );
          if (refined.refined) {
            response.action.arguments.coordinate = refined.coordinate;
            zoomCropCoordinate = refined.crop_coordinate?.length >= 2 ? refined.crop_coordinate : undefined;
            zoomCropBox = refined.crop_box?.length >= 4 ? refined.crop_box : undefined;
          }
          zoomCrop = refined.crop_image;
        } catch (err) {
          console.error('[zoom] refine failed, using coarse coordinate', err);
        }
      }

      // Add assistant message - include screenshot so user can see what model saw
      const assistantMessage: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: response.output_text,
        timestamp: new Date(),
        action: response.action,
        screenshot, // Always include screenshot so user can see what model analyzed
        stepNumber, // Track which step this is in multi-turn
        thinking: response.thinking,
        zoomCrop,
        zoomCropCoordinate,
        zoomCropBox,
        screenshotBox,
      };
      setMessages(prev => [...prev, assistantMessage]);

      return response;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      throw new Error(errorMessage);
    }
  }, []);

  // Original single query process (for non-auto mode)
  const processQuery = useCallback(async (
    query: string,
    settings: Settings
  ): Promise<AgentResponse | null> => {
    setIsProcessing(true);
    setError(null);

    try {
      const capture = await captureScreenshotWithMetadata(settings.screenshotMaxDimension);
      if (!capture) {
        throw new Error('Failed to capture screenshot');
      }

      // Pass image dimensions so model's coordinate system matches the image
      return await processSingleTurn(query, settings, capture.base64, capture.imageWidth, capture.imageHeight);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(errorMessage);
      
      const errorAssistantMessage: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: `Error: ${errorMessage}`,
        timestamp: new Date(),
      };
      setMessages(prev => [...prev, errorAssistantMessage]);
      
      return null;
    } finally {
      setIsProcessing(false);
    }
  }, [captureScreenshotWithMetadata, processSingleTurn]);

  // Execute action
  const executeAction = useCallback(async (action: AgentResponse['action']): Promise<boolean> => {
    try {
      // Skip execution for "done" action
      if (action.action === 'done') {
        return true;
      }
      await invoke('execute_action', { action: JSON.stringify(action) });
      return true;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(`Failed to execute action: ${errorMessage}`);
      return false;
    }
  }, []);

  // Multi-turn processing - continues until done or max turns
  const runMultiTurn = useCallback(async (
    query: string,
    settings: Settings,
    onPersistAutoApprove?: () => void
  ): Promise<void> => {
    setIsProcessing(true);
    setIsMultiTurnRunning(true);
    setIsStopping(false);
    setError(null);
    setCurrentTurn(0);
    stopRequestedRef.current = false;
    priorTurnsRef.current = []; // Clear conversation history for new task

    // Local override so a mid-run "Always Allow" applies to subsequent confirms
    // in this same run (the settings prop is a snapshot taken at call time)
    let autoApprove = settings.autoApproveConfirmations;

    // Outside the try so the catch can report how many steps completed when a
    // stop aborts the in-flight inference call.
    let turn = 0;

    try {
      let currentQuery = query;
      let isFollowUp = false;
      const actionHistory: string[] = []; // Track executed actions only

      while (turn < settings.maxTurns && !stopRequestedRef.current) {
        setCurrentTurn(turn + 1);

        // Small additional delay before screenshot to ensure screen has updated
        // (the main delay happens after action execution, but this catches edge cases)
        if (isFollowUp) {
          await delay(100);
        }

        // Capture fresh screenshot with metadata (includes image dimensions)
        const capture = await captureScreenshotWithMetadata(settings.screenshotMaxDimension);
        if (!capture) {
          throw new Error('Failed to capture screenshot');
        }

        // Build the query for follow-up turns - include last 5 actions (executed actions only, no reasoning to avoid confusion)
        if (isFollowUp && actionHistory.length > 0) {
          // Get the last 5 actions (or all if less than 5)
          const recentActions = actionHistory.slice(-5);
          const historyStr = recentActions.map((action, i) => {
            const stepNum = actionHistory.length - recentActions.length + i + 1;
            return `${stepNum}. ${action}`;
          }).join('\n');
          
          currentQuery = `Goal: "${query}"

Actions completed (${actionHistory.length} total):
${historyStr}

The screenshot shows the CURRENT state. What is the single NEXT action to take?
Remember: Output exactly ONE action per response. If the goal is complete, use "done".`;
        }

        // Process single turn.
        // Pass IMAGE dimensions so model's coordinates match the image it sees
        const response = await processSingleTurn(
          currentQuery,
          settings,
          capture.base64,
          capture.imageWidth,
          capture.imageHeight,
          isFollowUp,
          turn + 1, // Step number for display
          priorTurnsRef.current, // Conversation history (with thinking) for continuity
          query // Original goal for the zoom-refine pass
        );

        if (!response?.success) {
          throw new Error(response?.error || 'Failed to get response');
        }

        // Stop pressed while inference was running: discard the action this
        // turn produced instead of executing it.
        if (stopRequestedRef.current) {
          break;
        }

        // Record this turn so the next call gets full conversation history
        // (including thinking, which Qwen3-VL preserves via preserve_thinking)
        priorTurnsRef.current.push({
          user_query: currentQuery,
          assistant_content: response.output_text,
          assistant_thinking: response.thinking,
        });

        // Check if done
        if (response.is_done || response.action.action === 'done') {
          const doneMessage: Message = {
            id: crypto.randomUUID(),
            role: 'system',
            content: `✓ Task completed in ${turn + 1} step${turn === 0 ? '' : 's'}`,
            timestamp: new Date(),
          };
          setMessages(prev => [...prev, doneMessage]);
          break;
        }

        // Conversational reply with no computer action (e.g. the model answered
        // an information question in text). There is nothing to execute — end
        // the run instead of erroring on an unknown action.
        if (response.action.action === 'none') {
          const answeredMessage: Message = {
            id: crypto.randomUUID(),
            role: 'system',
            content: `✓ Model answered in text — no action to execute`,
            timestamp: new Date(),
          };
          setMessages(prev => [...prev, answeredMessage]);
          break;
        }

        // Check if confirmation is needed
        if (response.action.action === 'confirm') {
          const confirmMessage = response.action.arguments?.text || 'The AI wants to perform a potentially risky action. Proceed?';

          // Auto-approved via the "Always Allow" setting — skip the dialog
          if (autoApprove) {
            const autoMessage: Message = {
              id: crypto.randomUUID(),
              role: 'system',
              content: `✓ Auto-approved (Always Allow): ${confirmMessage}`,
              timestamp: new Date(),
            };
            setMessages(prev => [...prev, autoMessage]);
            // Record the approval so the next turn's context tells the model to
            // proceed — otherwise it may just ask to confirm again.
            actionHistory.push(`confirm ("${confirmMessage}") — APPROVED by user, proceed with the action`);
            turn++;
            isFollowUp = true;
            continue;
          }

          // Show confirmation request in chat
          const confirmSystemMessage: Message = {
            id: crypto.randomUUID(),
            role: 'system',
            content: `⚠️ Confirmation needed: ${confirmMessage}`,
            timestamp: new Date(),
          };
          setMessages(prev => [...prev, confirmSystemMessage]);

          // Wait for user confirmation
          const confirmed = await new Promise<boolean>((resolve) => {
            confirmationResolveRef.current = resolve;
            setPendingConfirmation({
              message: confirmMessage,
              onConfirm: () => {
                resolve(true);
                setPendingConfirmation(null);
                confirmationResolveRef.current = null;
              },
              onDeny: () => {
                resolve(false);
                setPendingConfirmation(null);
                confirmationResolveRef.current = null;
              },
              onAlwaysAllow: () => {
                autoApprove = true;
                onPersistAutoApprove?.();
                resolve(true);
                setPendingConfirmation(null);
                confirmationResolveRef.current = null;
              },
            });
          });
          
          if (!confirmed) {
            const deniedMessage: Message = {
              id: crypto.randomUUID(),
              role: 'system',
              content: `⛔ Action denied by user. Task stopped.`,
              timestamp: new Date(),
            };
            setMessages(prev => [...prev, deniedMessage]);
            break;
          }
          
          const approvedMessage: Message = {
            id: crypto.randomUUID(),
            role: 'system',
            content: `✓ Action approved. Continuing...`,
            timestamp: new Date(),
          };
          setMessages(prev => [...prev, approvedMessage]);

          // Record the approval so the next turn's context tells the model to
          // proceed — otherwise it may just ask to confirm again.
          actionHistory.push(`confirm ("${confirmMessage}") — APPROVED by user, proceed with the action`);
          turn++;
          isFollowUp = true;
          continue;
        }

        // Format the action for context in next turn
        const action = response.action;
        let actionDescription = action.action;
        if (action.arguments?.coordinate) {
          actionDescription += ` at (${Math.round(action.arguments.coordinate[0])}, ${Math.round(action.arguments.coordinate[1])})`;
        }
        if (action.arguments?.text) {
          actionDescription += `: "${action.arguments.text}"`;
        }
        if (action.arguments?.key) {
          actionDescription += `: ${action.arguments.key}`;
        }
        if (action.arguments?.direction) {
          actionDescription += ` ${action.arguments.direction}`;
        }

        // Execute the action
        const success = await executeAction(response.action);
        if (!success) {
          throw new Error('Failed to execute action');
        }

        // Add to action history for context
        actionHistory.push(actionDescription);

        // Wait for UI to update after action — in short slices so a Stop press
        // takes effect within ~100ms instead of after the full delay
        for (let waited = 0; waited < settings.actionDelayMs && !stopRequestedRef.current; waited += 100) {
          await delay(Math.min(100, settings.actionDelayMs - waited));
        }

        turn++;
        isFollowUp = true;
      }

      // Only report hitting the turn cap when the run wasn't stopped by the
      // user — a stop on the final turn would otherwise show both messages.
      if (turn >= settings.maxTurns && !stopRequestedRef.current) {
        const maxTurnsMessage: Message = {
          id: crypto.randomUUID(),
          role: 'system',
          content: `⚠ Reached maximum of ${settings.maxTurns} turns. Task may not be complete.`,
          timestamp: new Date(),
        };
        setMessages(prev => [...prev, maxTurnsMessage]);
      }

      if (stopRequestedRef.current) {
        const stoppedMessage: Message = {
          id: crypto.randomUUID(),
          role: 'system',
          content: `⏹ Multi-turn execution stopped by user after ${turn} step${turn === 1 ? '' : 's'}`,
          timestamp: new Date(),
        };
        setMessages(prev => [...prev, stoppedMessage]);
      }

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      // A Stop press aborts the in-flight inference call, which surfaces here
      // as a rejected invoke ("inference cancelled") — report it as a stop,
      // not an error.
      if (stopRequestedRef.current) {
        const stoppedMessage: Message = {
          id: crypto.randomUUID(),
          role: 'system',
          content: `⏹ Multi-turn execution stopped by user after ${turn} step${turn === 1 ? '' : 's'}`,
          timestamp: new Date(),
        };
        setMessages(prev => [...prev, stoppedMessage]);
      } else {
        setError(errorMessage);

        const errorAssistantMessage: Message = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: `Error: ${errorMessage}`,
          timestamp: new Date(),
        };
        setMessages(prev => [...prev, errorAssistantMessage]);
      }
    } finally {
      setIsProcessing(false);
      setIsMultiTurnRunning(false);
      setIsStopping(false);
      setCurrentTurn(0);
    }
  }, [captureScreenshotWithMetadata, executeAction, processSingleTurn]);

  // Stop multi-turn execution. Besides setting the flag the loop polls, abort
  // any in-flight inference request on the backend so the stop takes effect
  // immediately instead of after the model finishes generating.
  const stopMultiTurn = useCallback(() => {
    stopRequestedRef.current = true;
    setIsStopping(true);
    invoke('cancel_inference').catch(() => {});
  }, []);

  const clearMessages = useCallback(() => {
    setMessages([]);
    setCurrentScreenshot(null);
    setCurrentTurn(0);
    priorTurnsRef.current = []; // Clear conversation history
  }, []);

  const testConnection = useCallback(async (settings: Settings): Promise<boolean> => {
    try {
      const result = await invoke<boolean>('test_api_connection', {
        apiEndpoint: settings.apiEndpoint,
      });
      return result;
    } catch {
      // Connection checks run on a timer and while the user edits the endpoint
      // in settings — don't raise the global error toast for them. The status
      // bar and the settings panel's Test button already surface failures.
      return false;
    }
  }, []);

  return {
    isProcessing,
    currentScreenshot,
    messages,
    error,
    currentTurn,
    isMultiTurnRunning,
    isStopping,
    pendingConfirmation,
    captureScreenshot,
    processQuery,
    executeAction,
    runMultiTurn,
    stopMultiTurn,
    clearMessages,
    testConnection,
    setError,
    setMessages,
  };
}
