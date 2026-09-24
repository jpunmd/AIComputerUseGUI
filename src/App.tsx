import { useState, useEffect, useRef } from 'react';
import {
  Settings,
  Sparkles,
  Trash2,
  StopCircle,
  Save,
  History,
  MessageCircle,
  Crosshair,
} from 'lucide-react';
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
import { ActionConfirmation } from './components/ActionConfirmation';
import { TaskPanel } from './components/TaskPanel';

function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [supervised, setSupervised] = useState(true);
  const [planOnly, setPlanOnly] = useState(false);
  // Dry run: ask the model for one action and draw a crosshair where it would
  // click, without moving the mouse. For calibrating coordinate accuracy.
  const [dryRun, setDryRun] = useState(false);
  const [activeTab, setActiveTab] = useState<'chat' | 'history'>('chat');

  const { settings, updateSettings, resetSettings } = useSettings();
  const {
    isProcessing,
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

  // Save every finished task checkpoint, including stopped/failed tasks.
  const prevIsTaskRunning = useRef(isTaskRunning);
  useEffect(() => {
    // Detect when task just finished (was running, now not running)
    if (prevIsTaskRunning.current && !isTaskRunning && messages.length > 0) {
      // Structured checkpoints do not depend on model-authored completion prose.
      const lastMessage = messages[messages.length - 1];
      if (lastMessage.task) {
        (async () => {
          const result = await saveSession(messages, {
            includeScreenshots: settingsRef.current.saveScreenshotsInSessions,
          });
          if (!result.session) {
            setError(
              'Failed to auto-save session — see the console for details.',
            );
          } else if (result.slimmed) {
            setError(
              'Session auto-saved without screenshots — storage is nearly full.',
            );
          }
        })();
      }
    }
    prevIsTaskRunning.current = isTaskRunning;
  }, [isTaskRunning, messages, saveSession, setError]);

  const handleTestConnection = async (): Promise<boolean> => {
    const result = await testConnection(settings);
    setIsConnected(result);
    return result;
  };

  const handleSubmit = async (query: string) => {
    setError(null);
    setActiveTab('chat');
    if (dryRun && settings.debugMode) {
      await previewAction(query, settings);
      return;
    }
    try {
      await runTask(query, settings, supervised, false, planOnly);
    } finally {
      setSupervised(true);
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
          {currentTurn > 0 && (
            <span className="text-sm text-primary-400">Step {currentTurn}</span>
          )}

          {/* Dry-run toggle - preview clicks without executing (debug only) */}
          {settings.debugMode && (
            <button
              disabled={isProcessing}
              onClick={() => setDryRun(!dryRun)}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg transition-all ${
                dryRun
                  ? 'bg-amber-500/20 text-amber-400 border border-amber-500/50'
                  : 'bg-dark-800 text-dark-400 border border-dark-600 hover:border-dark-500'
              }`}
              title={
                dryRun
                  ? 'Dry run ON: preview the predicted click as a crosshair, do not move the mouse'
                  : 'Dry run OFF: actions execute normally'
              }
            >
              <Crosshair className="w-4 h-4" />
              <span className="text-sm">Dry run</span>
            </button>
          )}

          {/* Stop covers preview, inference, and task execution. */}
          {isProcessing && (
            <button
              onClick={stopTask}
              disabled={isStopping}
              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/20 text-red-400 border border-red-500/50 hover:bg-red-500/30 transition-all disabled:opacity-60 disabled:cursor-wait"
              title="Stop execution (Ctrl+Alt+F12 works outside this window)"
            >
              <StopCircle
                className={`w-4 h-4 ${isStopping ? 'animate-pulse' : ''}`}
              />
              <span className="text-sm">
                {isStopping ? 'Stopping…' : 'Stop'}
              </span>
            </button>
          )}

          {/* Clear chat */}
          <button
            onClick={() => {
              clearMessages();
            }}
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
                  setError(
                    'Failed to save session — see the console for details.',
                  );
                  return;
                }
                if (result.slimmed) {
                  setError(
                    'Session saved without screenshots — storage is nearly full.',
                  );
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
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={isProcessing ? !isDirectControl : supervised}
              disabled={isProcessing}
              onChange={(e) => setSupervised(e.target.checked)}
            />
            Review each action
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={planOnly}
              disabled={isProcessing}
              onChange={(e) => setPlanOnly(e.target.checked)}
            />
            Plan only
          </label>
          <label
            className="flex items-center gap-2"
            title="Check a magnified view of the target before each click"
          >
            <input
              type="checkbox"
              checked={settings.zoomRefine}
              disabled={isProcessing}
              onChange={(e) => updateSettings({ zoomRefine: e.target.checked })}
            />
            Precision clicks
          </label>
          <span className="text-xs text-dark-400">
            Emergency stop: Ctrl+Alt+F12
          </span>
          {task && task.status !== 'completed' && (
            <button
              disabled={isProcessing}
              className="px-3 py-1 rounded bg-primary-500/20 text-primary-300 disabled:opacity-50"
              onClick={async () => {
                setPlanOnly(false);
                try {
                  await runTask(
                    'Continue the original task from the current screen.',
                    settings,
                    supervised,
                    true,
                  );
                } finally {
                  setSupervised(true);
                }
              }}
            >
              Continue task
            </button>
          )}
        </div>
        {((isProcessing && isDirectControl) ||
          (!isProcessing && !supervised)) && (
          <p className="text-sm text-amber-400">
            Direct control for this run: mouse and keyboard actions execute
            without review.
          </p>
        )}
        {task && <TaskPanel task={task} expanded={planOnly} />}
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
              <ChatHistory
                messages={messages}
                expandThinkingByDefault={settings.expandThinkingByDefault}
                debugMode={settings.debugMode}
              />

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

      {pendingConfirmation && (
        <ActionConfirmation request={pendingConfirmation} onStop={stopTask} />
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
