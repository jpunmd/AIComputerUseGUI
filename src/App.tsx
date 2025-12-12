import { useState } from 'react';
import { Settings, Sparkles, Trash2, Play, Square, MousePointer } from 'lucide-react';
import {
  SettingsPanel,
  ChatHistory,
  CommandInput,
  ScreenshotViewer,
  StatusBar,
} from './components';
import { useAgent } from './hooks/useAgent';
import { useSettings } from './hooks/useSettings';
import { ActionResult } from './types';

function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [autoExecute, setAutoExecute] = useState(false);
  const [lastAction, setLastAction] = useState<ActionResult | null>(null);
  const [isExecuting, setIsExecuting] = useState(false);

  const { settings, updateSettings, resetSettings } = useSettings();
  const {
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
  } = useAgent();

  const handleTestConnection = async (): Promise<boolean> => {
    const result = await testConnection(settings);
    setIsConnected(result);
    return result;
  };

  const handleSubmit = async (query: string) => {
    setError(null);
    setLastAction(null);
    const response = await processQuery(query, settings);
    
    if (response?.success && response.action) {
      setLastAction(response.action);
      if (autoExecute) {
        await handleExecuteAction(response.action);
      }
    }
  };

  const handleExecuteAction = async (action: ActionResult) => {
    setIsExecuting(true);
    try {
      await executeAction(action);
      setLastAction(null);
    } finally {
      setIsExecuting(false);
    }
  };

  const handleCaptureScreenshot = async () => {
    await captureScreenshot();
  };

  return (
    <div className="h-screen flex flex-col bg-dark-950">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-dark-800 bg-dark-900/80 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-gradient-to-br from-primary-500 to-primary-600 shadow-lg shadow-primary-500/25">
            <Sparkles className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold gradient-text">AI Computer Use</h1>
            <p className="text-xs text-dark-400">Powered by Qwen3-VL</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Auto-execute toggle */}
          <button
            onClick={() => setAutoExecute(!autoExecute)}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg transition-all ${
              autoExecute
                ? 'bg-primary-500/20 text-primary-400 border border-primary-500/50'
                : 'bg-dark-800 text-dark-400 border border-dark-600 hover:border-dark-500'
            }`}
            title={autoExecute ? 'Auto-execute enabled' : 'Auto-execute disabled'}
          >
            {autoExecute ? (
              <Play className="w-4 h-4" />
            ) : (
              <Square className="w-4 h-4" />
            )}
            <span className="text-sm">Auto-execute</span>
          </button>

          {/* Clear chat */}
          <button
            onClick={clearMessages}
            disabled={messages.length === 0}
            className="p-2 rounded-lg bg-dark-800 hover:bg-dark-700 text-dark-400 hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Clear chat"
          >
            <Trash2 className="w-5 h-5" />
          </button>

          {/* Settings button */}
          <button
            onClick={() => setSettingsOpen(true)}
            className="p-2 rounded-lg bg-dark-800 hover:bg-dark-700 text-dark-400 hover:text-white transition-colors"
            title="Settings"
          >
            <Settings className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 flex overflow-hidden">
        {/* Left panel - Chat */}
        <div className="w-[400px] flex flex-col border-r border-dark-800 bg-dark-900/50">
          <ChatHistory messages={messages} />
          
          {/* Execute Action Button */}
          {lastAction && !autoExecute && (
            <div className="px-4 py-2 border-t border-dark-700">
              <button
                onClick={() => handleExecuteAction(lastAction)}
                disabled={isExecuting}
                className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg bg-gradient-to-r from-green-500 to-green-600 hover:from-green-400 hover:to-green-500 text-white font-medium transition-all shadow-lg shadow-green-500/25 disabled:opacity-50"
              >
                <MousePointer className="w-4 h-4" />
                {isExecuting ? 'Executing...' : `Execute: ${lastAction.action}`}
              </button>
            </div>
          )}
          
          <CommandInput
            onSubmit={handleSubmit}
            onCaptureScreenshot={handleCaptureScreenshot}
            isProcessing={isProcessing}
          />
        </div>

        {/* Right panel - Screenshot viewer */}
        <div className="flex-1 flex flex-col bg-dark-950">
          <ScreenshotViewer
            screenshot={currentScreenshot}
            isLoading={isProcessing}
          />
        </div>
      </main>

      {/* Error toast */}
      {error && (
        <div className="fixed bottom-20 left-1/2 -translate-x-1/2 px-6 py-3 bg-red-500/20 border border-red-500/50 text-red-400 rounded-xl backdrop-blur-sm">
          {error}
          <button
            onClick={() => setError(null)}
            className="ml-4 text-red-300 hover:text-white"
          >
            ×
          </button>
        </div>
      )}

      {/* Status bar */}
      <StatusBar
        isConnected={isConnected}
        isProcessing={isProcessing}
        apiEndpoint={settings.apiEndpoint}
        modelId={settings.modelId}
      />

      {/* Settings panel */}
      <SettingsPanel
        settings={settings}
        onUpdateSettings={updateSettings}
        onResetSettings={resetSettings}
        onTestConnection={handleTestConnection}
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}

export default App;
