import { useState, useCallback, useRef } from 'react';
import { flushSync } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { Settings, AgentResponse, Message, ScreenshotWithMetadata } from '../types';

const MAX_TURNS = 20; // Maximum number of turns to prevent infinite loops

export interface ConfirmationRequest {
  message: string;
  onConfirm: () => void;
  onDeny: () => void;
}

// Screenshot capture result with dimensions
interface ScreenshotCapture {
  base64: string;
  imageWidth: number;
  imageHeight: number;
  screenWidth: number;
  screenHeight: number;
}

export function useAgent() {
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentScreenshot, setCurrentScreenshot] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [currentTurn, setCurrentTurn] = useState(0);
  const [isMultiTurnRunning, setIsMultiTurnRunning] = useState(false);
  const [pendingConfirmation, setPendingConfirmation] = useState<ConfirmationRequest | null>(null);
  const stopRequestedRef = useRef(false);
  const confirmationResolveRef = useRef<((confirmed: boolean) => void) | null>(null);
  const screenshotHistoryRef = useRef<string[]>([]); // Track screenshots for current task

  // Capture screenshot with metadata (dimensions)
  const captureScreenshotWithMetadata = useCallback(async (): Promise<ScreenshotCapture | null> => {
    try {
      const result = await invoke<ScreenshotWithMetadata>('capture_screenshot_with_metadata');
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

  const captureScreenshot = useCallback(async (): Promise<string | null> => {
    try {
      const screenshot = await invoke<string>('capture_screenshot');
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
    screenshotHistory?: string[]
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

      // Send to backend with screenshot history for context
      // Pass IMAGE dimensions (not screen dimensions) so model's coordinate system matches
      const response = await invoke<AgentResponse>('process_computer_use', {
        screenshotBase64: screenshot,
        query,
        apiEndpoint: settings.apiEndpoint,
        modelId: settings.modelId,
        displayWidth: imageWidth,
        displayHeight: imageHeight,
        systemPrompt: settings.systemPrompt,
        screenshotHistory: screenshotHistory && screenshotHistory.length > 0 ? screenshotHistory : null,
      });

      // Add assistant message - include screenshot so user can see what model saw
      const assistantMessage: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: response.output_text,
        timestamp: new Date(),
        action: response.action,
        screenshot, // Always include screenshot so user can see what model analyzed
        stepNumber, // Track which step this is in multi-turn
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
      const capture = await captureScreenshotWithMetadata();
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
    settings: Settings
  ): Promise<void> => {
    setIsProcessing(true);
    setIsMultiTurnRunning(true);
    setError(null);
    setCurrentTurn(0);
    stopRequestedRef.current = false;
    screenshotHistoryRef.current = []; // Clear screenshot history for new task

    try {
      let turn = 0;
      let currentQuery = query;
      let isFollowUp = false;
      const actionHistory: string[] = []; // Track ALL actions taken

      while (turn < MAX_TURNS && !stopRequestedRef.current) {
        setCurrentTurn(turn + 1);

        // Capture fresh screenshot with metadata (includes image dimensions)
        const capture = await captureScreenshotWithMetadata();
        if (!capture) {
          throw new Error('Failed to capture screenshot');
        }

        // Build the query for follow-up turns - include FULL action history
        if (isFollowUp && actionHistory.length > 0) {
          const historyStr = actionHistory.map((a, i) => `${i + 1}. ${a}`).join('\n');
          currentQuery = `Goal: "${query}"

Actions already completed:
${historyStr}

This screenshot shows the CURRENT state AFTER all these actions.
If the goal is achieved, use "done". Otherwise, what's the NEXT action?`;
        }

        // Process single turn with screenshot history for context
        // Pass IMAGE dimensions so model's coordinates match the image it sees
        const response = await processSingleTurn(
          currentQuery, 
          settings, 
          capture.base64, 
          capture.imageWidth, 
          capture.imageHeight, 
          isFollowUp,
          turn + 1, // Step number for display
          screenshotHistoryRef.current // Pass screenshot history for context
        );
        
        // Add current screenshot to history for next turn
        screenshotHistoryRef.current.push(capture.base64);

        if (!response?.success) {
          throw new Error(response?.error || 'Failed to get response');
        }

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

        // Check if confirmation is needed
        if (response.action.action === 'confirm') {
          const confirmMessage = response.action.arguments?.text || 'The AI wants to perform a potentially risky action. Proceed?';
          
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
          
          // Don't add confirm to action history, just continue to get next action
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

        // Wait for UI to update after action
        await delay(settings.actionDelayMs);

        turn++;
        isFollowUp = true;
      }

      if (turn >= MAX_TURNS) {
        const maxTurnsMessage: Message = {
          id: crypto.randomUUID(),
          role: 'system',
          content: `⚠ Reached maximum of ${MAX_TURNS} turns. Task may not be complete.`,
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
      setError(errorMessage);
      
      const errorAssistantMessage: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: `Error: ${errorMessage}`,
        timestamp: new Date(),
      };
      setMessages(prev => [...prev, errorAssistantMessage]);
    } finally {
      setIsProcessing(false);
      setIsMultiTurnRunning(false);
      setCurrentTurn(0);
    }
  }, [captureScreenshotWithMetadata, executeAction, processSingleTurn]);

  // Stop multi-turn execution
  const stopMultiTurn = useCallback(() => {
    stopRequestedRef.current = true;
  }, []);

  const clearMessages = useCallback(() => {
    setMessages([]);
    setCurrentScreenshot(null);
    setCurrentTurn(0);
    screenshotHistoryRef.current = []; // Clear screenshot history
  }, []);

  const testConnection = useCallback(async (settings: Settings): Promise<boolean> => {
    try {
      const result = await invoke<boolean>('test_api_connection', {
        apiEndpoint: settings.apiEndpoint,
        modelId: settings.modelId,
      });
      return result;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(`Connection test failed: ${errorMessage}`);
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
