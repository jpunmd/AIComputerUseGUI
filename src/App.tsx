import { useState, useEffect, useRef } from 'react';
import { Settings, Sparkles, Trash2, Play, Square, MousePointer, StopCircle, Repeat, AlertTriangle, Check, X, Save, History, MessageCircle } from 'lucide-react';
import {
  SettingsPanel,
  ChatHistory,
  CommandInput,
  StatusBar,
  SessionHistory,
} from './components';
import { useAgent } from './hooks/useAgent';
import { useSettings } from './hooks/useSettings';
import { useSessions } from './hooks/useSessions';
import { ActionResult } from './types';

function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [autoExecute, setAutoExecute] = useState(false);
  const [multiTurnMode, setMultiTurnMode] = useState(true);
  const [lastAction, setLastAction] = useState<ActionResult | null>(null);
  const [isExecuting, setIsExecuting] = useState(false);
  const [activeTab, setActiveTab] = useState<'chat' | 'history'>('chat');

  const { settings, updateSettings, resetSettings } = useSettings();
  const {
    isProcessing,
    messages,
    error,
    currentTurn,
    isMultiTurnRunning,
    pendingConfirmation,
    processQuery,
    executeAction,
    runMultiTurn,
    stopMultiTurn,
    clearMessages,
    testConnection,
    setError,
    setMessages,
  } = useAgent();

  const {
    sessions,
    saveSession,
    deleteSession,
    renameSession,
    exportSessions,
    importSessions,
    clearAllSessions,
  } = useSessions();

  // Auto-test connection on startup and periodically
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    const checkConnection = async () => {
      const result = await testConnection(settingsRef.current);
      setIsConnected(result);
    };

    // Test immediately on mount
    checkConnection();

    // Then test every 30 seconds
    const interval = setInterval(checkConnection, 30000);
    return () => clearInterval(interval);
  }, [testConnection]);

  // Re-test when settings change
  useEffect(() => {
    const checkConnection = async () => {
      const result = await testConnection(settings);
      setIsConnected(result);
    };
    checkConnection();
  }, [settings.apiEndpoint, settings.modelId, testConnection]);

  // Auto-save session when task completes (multi-turn mode finishes)
  const prevIsMultiTurnRunning = useRef(isMultiTurnRunning);
  useEffect(() => {
    // Detect when multi-turn just finished (was running, now not running)
    if (prevIsMultiTurnRunning.current && !isMultiTurnRunning && messages.length > 0) {
      // Check if the last message indicates completion (not an error)
      const lastMessage = messages[messages.length - 1];
      if (lastMessage.role === 'system' && 
          (lastMessage.content.includes('✓ Task completed') || 
           lastMessage.content.includes('stopped by user') ||
           lastMessage.content.includes('Action denied'))) {
        saveSession(messages);
      }
    }
    prevIsMultiTurnRunning.current = isMultiTurnRunning;
  }, [isMultiTurnRunning, messages, saveSession]);

  const handleTestConnection = async (): Promise<boolean> => {
    const result = await testConnection(settings);
    setIsConnected(result);
    return result;
  };

  const handleSubmit = async (query: string) => {
    setError(null);
    setLastAction(null);
    
    if (multiTurnMode) {
      // Multi-turn mode: run until task is complete
      await runMultiTurn(query, settings);
      setIsConnected(true);
    } else {
      // Single-turn mode: just get one action
      const response = await processQuery(query, settings);
      
      if (response?.success && response.action) {
        setIsConnected(true);
        setLastAction(response.action);
        if (autoExecute) {
          await handleExecuteAction(response.action);
        }
      } else if (response === null) {
        setIsConnected(false);
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
          {/* Multi-turn mode toggle */}
          <button
            onClick={() => setMultiTurnMode(!multiTurnMode)}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg transition-all ${
              multiTurnMode
                ? 'bg-primary-500/20 text-primary-400 border border-primary-500/50'
                : 'bg-dark-800 text-dark-400 border border-dark-600 hover:border-dark-500'
            }`}
            title={multiTurnMode ? 'Multi-turn mode: Will continue until task is done' : 'Single-turn mode: One action at a time'}
          >
            <Repeat className="w-4 h-4" />
            <span className="text-sm">Multi-turn</span>
            {currentTurn > 0 && (
              <span className="ml-1 px-1.5 py-0.5 text-xs bg-primary-500/30 rounded">
                Step {currentTurn}
              </span>
            )}
          </button>

          {/* Stop button - only show during multi-turn execution */}
          {isMultiTurnRunning && (
            <button
              onClick={stopMultiTurn}
              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/20 text-red-400 border border-red-500/50 hover:bg-red-500/30 transition-all"
              title="Stop multi-turn execution"
            >
              <StopCircle className="w-4 h-4" />
              <span className="text-sm">Stop</span>
            </button>
          )}

          {/* Auto-execute toggle - only relevant in single-turn mode */}
          {!multiTurnMode && (
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
          )}

          {/* Clear chat */}
          <button
            onClick={clearMessages}
            disabled={messages.length === 0}
            className="p-2 rounded-lg bg-dark-800 hover:bg-dark-700 text-dark-400 hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Clear chat"
          >
            <Trash2 className="w-5 h-5" />
          </button>

          {/* Save session */}
          <button
            onClick={() => {
              if (messages.length > 0) {
                saveSession(messages);
                setActiveTab('history');
              }
            }}
            disabled={messages.length === 0}
            className="p-2 rounded-lg bg-dark-800 hover:bg-dark-700 text-dark-400 hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Save session"
          >
            <Save className="w-5 h-5" />
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
        {/* Left panel - Chat/History */}
        <div className="flex-1 flex flex-col bg-dark-900/50">
          {/* Tab buttons */}
          <div className="flex border-b border-dark-700">
            <button
              onClick={() => setActiveTab('chat')}
              className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${
                activeTab === 'chat'
                  ? 'text-primary-400 border-b-2 border-primary-500 bg-dark-800/50'
                  : 'text-dark-400 hover:text-white hover:bg-dark-800/30'
              }`}
            >
              <MessageCircle className="w-4 h-4" />
              Current Chat
            </button>
            <button
              onClick={() => setActiveTab('history')}
              className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${
                activeTab === 'history'
                  ? 'text-primary-400 border-b-2 border-primary-500 bg-dark-800/50'
                  : 'text-dark-400 hover:text-white hover:bg-dark-800/30'
              }`}
            >
              <History className="w-4 h-4" />
              Saved Sessions
              {sessions.length > 0 && (
                <span className="px-1.5 py-0.5 text-xs bg-dark-700 rounded-full">
                  {sessions.length}
                </span>
              )}
            </button>
          </div>

          {/* Tab content */}
          {activeTab === 'chat' ? (
            <>
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
                isProcessing={isProcessing}
              />
            </>
          ) : (
            <SessionHistory
              sessions={sessions}
              onLoadSession={(loadedMessages) => {
                setMessages(loadedMessages);
                setActiveTab('chat');
              }}
              onDeleteSession={deleteSession}
              onRenameSession={renameSession}
              onExportSessions={exportSessions}
              onImportSessions={importSessions}
              onClearAllSessions={clearAllSessions}
            />
          )}
        </div>
      </main>

      {/* Confirmation Dialog */}
      {pendingConfirmation && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-dark-900 border border-dark-700 rounded-2xl shadow-2xl max-w-md w-full mx-4 overflow-hidden">
            {/* Header */}
            <div className="flex items-center gap-3 px-6 py-4 bg-yellow-500/10 border-b border-yellow-500/30">
              <div className="p-2 rounded-lg bg-yellow-500/20">
                <AlertTriangle className="w-5 h-5 text-yellow-400" />
              </div>
              <h3 className="text-lg font-semibold text-yellow-400">Confirmation Required</h3>
            </div>
            
            {/* Content */}
            <div className="px-6 py-5">
              <p className="text-dark-200 leading-relaxed">
                {pendingConfirmation.message}
              </p>
            </div>
            
            {/* Actions */}
            <div className="flex gap-3 px-6 py-4 bg-dark-800/50 border-t border-dark-700">
              <button
                onClick={pendingConfirmation.onDeny}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-dark-700 hover:bg-dark-600 text-dark-300 hover:text-white transition-all border border-dark-600"
              >
                <X className="w-4 h-4" />
                <span>Deny</span>
              </button>
              <button
                onClick={pendingConfirmation.onConfirm}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-gradient-to-r from-green-500 to-green-600 hover:from-green-400 hover:to-green-500 text-white font-medium transition-all shadow-lg shadow-green-500/25"
              >
                <Check className="w-4 h-4" />
                <span>Approve</span>
              </button>
            </div>
          </div>
        </div>
      )}

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
