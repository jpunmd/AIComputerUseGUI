import { useState, useCallback, useRef } from 'react';
import { flushSync } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { Settings, AgentResponse, Message } from '../types';

const MAX_TURNS = 20; // Maximum number of turns to prevent infinite loops
const ACTION_DELAY_MS = 1500; // Delay between action and next screenshot (increased for UI to update)

export function useAgent() {
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentScreenshot, setCurrentScreenshot] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [currentTurn, setCurrentTurn] = useState(0);
  const [isMultiTurnRunning, setIsMultiTurnRunning] = useState(false);
  const stopRequestedRef = useRef(false);

  const getScreenSize = useCallback(async (): Promise<[number, number]> => {
    try {
      const size = await invoke<[number, number]>('get_screen_size');
      return size;
    } catch {
      // Fallback to window dimensions
      return [window.screen.width, window.screen.height];
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
  const processSingleTurn = useCallback(async (
    query: string,
    settings: Settings,
    screenshot: string,
    screenWidth: number,
    screenHeight: number,
    isFollowUp: boolean = false,
    stepNumber?: number
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

      // Send to backend
      const response = await invoke<AgentResponse>('process_computer_use', {
        screenshotBase64: screenshot,
        query,
        apiEndpoint: settings.apiEndpoint,
        modelId: settings.modelId,
        displayWidth: screenWidth,
        displayHeight: screenHeight,
        maxTokens: settings.maxTokens,
        verbosity: settings.verbosity,
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
      const [screenWidth, screenHeight] = await getScreenSize();
      const screenshot = await captureScreenshot();
      if (!screenshot) {
        throw new Error('Failed to capture screenshot');
      }

      return await processSingleTurn(query, settings, screenshot, screenWidth, screenHeight);
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
  }, [captureScreenshot, getScreenSize, processSingleTurn]);

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

    try {
      const [screenWidth, screenHeight] = await getScreenSize();
      let turn = 0;
      let currentQuery = query;
      let isFollowUp = false;
      const actionHistory: string[] = []; // Track ALL actions taken

      while (turn < MAX_TURNS && !stopRequestedRef.current) {
        setCurrentTurn(turn + 1);

        // Capture fresh screenshot
        const screenshot = await captureScreenshot();
        if (!screenshot) {
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

        // Process single turn
        const response = await processSingleTurn(
          currentQuery, 
          settings, 
          screenshot, 
          screenWidth, 
          screenHeight, 
          isFollowUp,
          turn + 1 // Step number for display
        );

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
        await delay(ACTION_DELAY_MS);

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
  }, [captureScreenshot, executeAction, getScreenSize, processSingleTurn]);

  // Stop multi-turn execution
  const stopMultiTurn = useCallback(() => {
    stopRequestedRef.current = true;
  }, []);

  const clearMessages = useCallback(() => {
    setMessages([]);
    setCurrentScreenshot(null);
    setCurrentTurn(0);
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
    captureScreenshot,
    processQuery,
    executeAction,
    runMultiTurn,
    stopMultiTurn,
    clearMessages,
    testConnection,
    setError,
  };
}
