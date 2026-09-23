import { useState, useEffect, useRef } from 'react';
import { Settings, Sparkles, Trash2, Play, Square, MousePointer, StopCircle, Repeat, AlertTriangle, Check, X, Save, History, MessageCircle, Crosshair } from 'lucide-react';
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
  const [supervised, setSupervised] = useState(true);
  const [planOnly, setPlanOnly] = useState(false);
  // Dry run: ask the model for one action and draw a crosshair where it would
  // click, without moving the mouse. For calibrating coordinate accuracy.
  const [dryRun, setDryRun] = useState(false);
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
    isStopping,
    pendingConfirmation,
    task,
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

  // Re-test when the endpoint/model changes — debounced so typing in the
  // settings panel doesn't fire a request per keystroke; the check runs once
  // the user pauses. (Settings themselves still save live.)
  useEffect(() => {
    const timer = setTimeout(async () => {
      const result = await testConnection(settingsRef.current);
      setIsConnected(result);
    }, 800);
    return () => clearTimeout(timer);
  }, [settings.apiEndpoint, settings.modelId, testConnection]);

  // Save every finished multi-turn checkpoint, including stopped/failed tasks.
  const prevIsMultiTurnRunning = useRef(isMultiTurnRunning);
  useEffect(() => {
    // Detect when multi-turn just finished (was running, now not running)
    if (prevIsMultiTurnRunning.current && !isMultiTurnRunning && messages.length > 0) {
      // Structured checkpoints do not depend on model-authored completion prose.
      const lastMessage = messages[messages.length - 1];
      if (lastMessage.task) {
        (async () => {
          const result = await saveSession(messages, {
            includeScreenshots: settingsRef.current.saveScreenshotsInSessions,
          });
          if (!result.session) {
            setError('Failed to auto-save session — see the console for details.');
          } else if (result.slimmed) {
            setError('Session auto-saved without screenshots — storage is nearly full.');
          }
        })();
      }
    }
    prevIsMultiTurnRunning.current = isMultiTurnRunning;
  }, [isMultiTurnRunning, messages, saveSession, setError]);

  const handleTestConnection = async (): Promise<boolean> => {
    const result = await testConnection(settings);
    setIsConnected(result);
    return result;
  };

  const handleSubmit = async (query: string) => {
    setError(null);
    setLastAction(null);

    // Dry run is a debug-only mode; ignore stale state if debug mode is off.
    if (dryRun && settings.debugMode) {
      // Dry run: predict a single action and draw the crosshair on the
      // screenshot the model saw, but never execute. Ignores multi-turn so the
      // preview is a single, inspectable step.
      const response = await processQuery(query, settings);
      if (response?.success) {
        setIsConnected(true);
      } else if (response === null) {
        setIsConnected(false);
      }
      return;
    }

    if (multiTurnMode || planOnly) {
      // Multi-turn mode: run until task is complete. Connection status is
      // handled by the periodic check — a failed run shouldn't show Connected.
      try {
        await runMultiTurn(query, settings, supervised, false, planOnly);
      } finally {
        setSupervised(true);
      }
    } else {
      // Single-turn mode: just get one action
      const response = await processQuery(query, settings);

      if (response?.success && response.action) {
        setIsConnected(true);
        // "none" (conversational reply) and "done" have nothing to execute —
        // don't offer an Execute button that would just error.
        if (!['none', 'done', 'confirm', 'plan'].includes(response.action.action)) {
          setLastAction(response.action);
          if (autoExecute) {
            await handleExecuteAction(response.action);
          }
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
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Multi-turn mode toggle */}
          <button
            disabled={isProcessing}
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

          {/* Dry-run toggle - preview clicks without executing (debug only) */}
          {settings.debugMode && (
            <button
              onClick={() => setDryRun(!dryRun)}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg transition-all ${
                dryRun
                  ? 'bg-amber-500/20 text-amber-400 border border-amber-500/50'
                  : 'bg-dark-800 text-dark-400 border border-dark-600 hover:border-dark-500'
              }`}
              title={dryRun ? 'Dry run ON: preview the predicted click as a crosshair, do not move the mouse' : 'Dry run OFF: actions execute normally'}
            >
              <Crosshair className="w-4 h-4" />
              <span className="text-sm">Dry run</span>
            </button>
          )}

          {/* Stop covers single-turn inference, input, and multi-turn execution. */}
          {isProcessing && (
            <button
              onClick={stopMultiTurn}
              disabled={isStopping}
              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/20 text-red-400 border border-red-500/50 hover:bg-red-500/30 transition-all disabled:opacity-60 disabled:cursor-wait"
              title="Stop execution (Ctrl+Alt+F12 works outside this window)"
            >
              <StopCircle className={`w-4 h-4 ${isStopping ? 'animate-pulse' : ''}`} />
              <span className="text-sm">{isStopping ? 'Stopping…' : 'Stop'}</span>
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
            onClick={() => { setLastAction(null); clearMessages(); }}
            disabled={messages.length === 0 || isProcessing}
            className="p-2 rounded-lg bg-dark-800 hover:bg-dark-700 text-dark-400 hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Clear chat"
          >
            <Trash2 className="w-5 h-5" />
          </button>

          {/* Save session */}
          <button
            onClick={async () => {
              if (messages.length > 0) {
                const result = await saveSession(messages, {
                  includeScreenshots: settings.saveScreenshotsInSessions,
                });
                if (!result.session) {
                  setError('Failed to save session — see the console for details.');
                  return;
                }
                if (result.slimmed) {
                  setError('Session saved without screenshots — storage is nearly full.');
                }
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

      <div className="px-6 py-3 border-b border-dark-700 bg-dark-900 space-y-2">
        <div className="flex flex-wrap items-center gap-5 text-sm text-dark-200">
          <label className="flex items-center gap-2"><input type="checkbox" checked={supervised} disabled={isProcessing} onChange={e=>setSupervised(e.target.checked)} />Review each action</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={planOnly} disabled={isProcessing} onChange={e=>setPlanOnly(e.target.checked)} />Plan only</label>
          <span className="text-xs text-dark-400">Emergency stop: Ctrl+Alt+F12</span>
          {task && task.status !== 'completed' && <button disabled={isProcessing} className="px-3 py-1 rounded bg-primary-500/20 text-primary-300 disabled:opacity-50" onClick={async()=>{
            setLastAction(null); setPlanOnly(false);
            try { await runMultiTurn('Continue the original task from the current screen.',settings,supervised,true); } finally { setSupervised(true); }
          }}>Continue task</button>}
        </div>
        {!supervised && <p className="text-sm text-amber-400">Direct control for this run: mouse and keyboard actions execute without review.</p>}
        {task && <details className="text-sm text-dark-300" open={task.status==='planning' || planOnly}>
          <summary className="cursor-pointer">Task: {task.status.replace('_',' ')} — {task.goal.slice(0,100)}</summary>
          <ol className="list-decimal ml-5 mt-2 max-h-32 overflow-y-auto">{task.plan.map((step,i)=><li key={i}>{step}</li>)}</ol>
        </details>}
      </div>

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
              disabled={isProcessing}
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
              <ChatHistory messages={messages} expandThinkingByDefault={settings.expandThinkingByDefault} debugMode={settings.debugMode} />
              
              {/* Execute Action Button */}
              {lastAction && !autoExecute && (
                <div className="px-4 py-2 border-t border-dark-700">
                  <button
                    onClick={() => handleExecuteAction(lastAction)}
                    disabled={isExecuting || isProcessing}
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
                setLastAction(null);
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
              <p className="text-dark-200 leading-relaxed whitespace-pre-wrap break-words max-h-72 overflow-y-auto">
                {pendingConfirmation.message}
              </p>
            </div>
            
            {/* Actions */}
            <div className="flex flex-col gap-2 px-6 py-4 bg-dark-800/50 border-t border-dark-700">
              <div className="flex gap-3">
                <button
                  onClick={pendingConfirmation.onDeny}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-dark-700 hover:bg-dark-600 text-dark-300 hover:text-white transition-all border border-dark-600"
                >
                  <X className="w-4 h-4" />
                  <span>Reject</span>
                </button>
                <button
                  onClick={pendingConfirmation.onConfirm}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-gradient-to-r from-green-500 to-green-600 hover:from-green-400 hover:to-green-500 text-white font-medium transition-all shadow-lg shadow-green-500/25"
                >
                  <Check className="w-4 h-4" />
                  <span>Allow Once</span>
                </button>
              </div>
              <button
                onClick={stopMultiTurn}
                className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-dark-700/60 hover:bg-dark-700 text-dark-300 hover:text-white text-sm transition-all border border-dark-600"
                title="Cancel the task and this approval"
              >
                <StopCircle className="w-3.5 h-3.5" />
                <span>Stop task (Ctrl+Alt+F12)</span>
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
