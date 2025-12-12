import { useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Settings, AgentResponse, Message } from '../types';

export function useAgent() {
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentScreenshot, setCurrentScreenshot] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);

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
      setCurrentScreenshot(screenshot);
      return screenshot;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(`Failed to capture screenshot: ${errorMessage}`);
      return null;
    }
  }, []);

  const processQuery = useCallback(async (
    query: string,
    settings: Settings
  ): Promise<AgentResponse | null> => {
    setIsProcessing(true);
    setError(null);

    try {
      // Get actual screen dimensions
      const [screenWidth, screenHeight] = await getScreenSize();
      
      // Capture screenshot first
      const screenshot = await captureScreenshot();
      if (!screenshot) {
        throw new Error('Failed to capture screenshot');
      }

      // Add user message
      const userMessage: Message = {
        id: crypto.randomUUID(),
        role: 'user',
        content: query,
        timestamp: new Date(),
        screenshot,
      };
      setMessages(prev => [...prev, userMessage]);

      // Send to backend - use actual screen dimensions, not settings
      const response = await invoke<AgentResponse>('process_computer_use', {
        screenshotBase64: screenshot,
        query,
        apiEndpoint: settings.apiEndpoint,
        modelId: settings.modelId,
        displayWidth: screenWidth,
        displayHeight: screenHeight,
        maxTokens: settings.maxTokens,
      });

      // Add assistant message
      const assistantMessage: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: response.output_text,
        timestamp: new Date(),
        action: response.action,
      };
      setMessages(prev => [...prev, assistantMessage]);

      return response;
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
  }, [captureScreenshot, getScreenSize]);

  const executeAction = useCallback(async (action: AgentResponse['action']): Promise<boolean> => {
    try {
      await invoke('execute_action', { action: JSON.stringify(action) });
      return true;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(`Failed to execute action: ${errorMessage}`);
      return false;
    }
  }, []);

  const clearMessages = useCallback(() => {
    setMessages([]);
    setCurrentScreenshot(null);
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
    captureScreenshot,
    processQuery,
    executeAction,
    clearMessages,
    testConnection,
    setError,
  };
}
