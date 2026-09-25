import { useState, useEffect, useRef } from 'react';
import {
  Settings,
  Sparkles,
  Trash2,
  Save,
  PanelLeftClose,
  PanelLeftOpen,
  Crosshair,
  Monitor,
  Sun,
  Moon,
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
import type { ControlMode } from './components/CommandInput';
import { THEME_PREFERENCES, useTheme } from './theme';
import type { ThemePreference } from './types';

const THEME_LABELS: Record<ThemePreference, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};
const THEME_ICONS = { system: Monitor, light: Sun, dark: Moon };

function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [planOnly, setPlanOnly] = useState(false);
  // Dry run: ask the model for one action and draw a crosshair where it would
  // click, without moving the mouse. For calibrating coordinate accuracy.
  const [dryRun, setDryRun] = useState(false);
  // The saved session the chat was loaded from or last saved to (highlighted
  // in the sidebar); null for an unsaved chat.
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  const { settings, updateSettings, resetSettings } = useSettings();
  // Saved default from Settings; applied when each run starts.
  const supervised = settings.reviewEachAction;
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

  useTheme(settings.theme);
  const ThemeIcon = THEME_ICONS[settings.theme];

  // While running, the run's own mode wins: a supervised run becomes direct
  // once the user picks "Allow for this task".
  const controlMode: ControlMode = isProcessing
    ? isDirectControl
      ? supervised
        ? 'allowed-for-task'
        : 'direct'
      : 'supervised'
    : supervised
      ? 'supervised'
      : 'direct';

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
            return;
          }
          setActiveSessionId(result.session.id);
          if (result.slimmed) {
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
    if (dryRun && settings.debugMode) {
      await previewAction(query, settings);
      return;
    }
    await runTask(query, settings, supervised, false, planOnly);
  };

  return (
    <div className="h-screen flex flex-col bg-ink-950">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-ink-800 bg-ink-900/80 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <button
            onClick={() =>
              updateSettings({ showSessions: !settings.showSessions })
            }
            className="p-2 -ml-2 rounded-lg text-ink-400 hover:text-ink-50 hover:bg-ink-800 transition-colors"
            title={settings.showSessions ? 'Hide saved sessions' : 'Show saved sessions'}
            aria-label={settings.showSessions ? 'Hide saved sessions' : 'Show saved sessions'}
            aria-expanded={settings.showSessions}
          >
            {settings.showSessions ? (
              <PanelLeftClose className="w-5 h-5" />
            ) : (
              <PanelLeftOpen className="w-5 h-5" />
            )}
          </button>
          <div className="p-2 rounded-xl bg-primary-500">
            <Sparkles className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-ink-50">AI Computer Use</h1>
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
                  ? 'bg-warning/15 text-warning border border-warning/40'
                  : 'bg-ink-800 text-ink-400 border border-ink-600 hover:border-ink-500'
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

          {/* Theme: cycles System → Light → Dark */}
          <button
            onClick={() =>
              updateSettings({
                theme:
                  THEME_PREFERENCES[
                    (THEME_PREFERENCES.indexOf(settings.theme) + 1) %
                      THEME_PREFERENCES.length
                  ],
              })
            }
            className="p-2 rounded-lg bg-ink-800 hover:bg-ink-700 text-ink-400 hover:text-ink-50 transition-colors"
            title={`Theme: ${THEME_LABELS[settings.theme]} (click to change)`}
            aria-label={`Theme: ${THEME_LABELS[settings.theme]}`}
          >
            <ThemeIcon className="w-5 h-5" />
          </button>

          {/* Clear chat */}
          <button
            onClick={() => {
              clearMessages();
              setActiveSessionId(null);
            }}
            disabled={messages.length === 0 || isProcessing}
            className="p-2 rounded-lg bg-ink-800 hover:bg-ink-700 text-ink-400 hover:text-ink-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
                setActiveSessionId(result.session.id);
                updateSettings({ showSessions: true });
              }
            }}
            disabled={messages.length === 0}
            className="p-2 rounded-lg bg-ink-800 hover:bg-ink-700 text-ink-400 hover:text-ink-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Save session"
          >
            <Save className="w-5 h-5" />
          </button>

          {/* Settings button */}
          <button
            onClick={() => setSettingsOpen(true)}
            className="p-2 rounded-lg bg-ink-800 hover:bg-ink-700 text-ink-400 hover:text-ink-50 transition-colors"
            title="Settings"
          >
            <Settings className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 flex overflow-hidden">
        {/* Saved sessions sidebar */}
        {settings.showSessions && (
          <aside
            aria-label="Saved sessions"
            className="w-64 shrink-0 border-r border-ink-700 bg-ink-900"
          >
            <SessionHistory
              sessions={sessions}
              activeSessionId={activeSessionId}
              disabled={isProcessing}
              onLoadSession={(loadedMessages, sessionId) => {
                setMessages(loadedMessages);
                setActiveSessionId(sessionId);
              }}
              onDeleteSession={(sessionId) => {
                deleteSession(sessionId);
                if (sessionId === activeSessionId) setActiveSessionId(null);
              }}
              onRenameSession={renameSession}
              onExportSessions={exportSessions}
              onImportSessions={importSessions}
              onClearAllSessions={() => {
                clearAllSessions();
                setActiveSessionId(null);
              }}
            />
          </aside>
        )}

        {/* Chat column */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="px-6 py-3 border-b border-ink-700">
            <div className="max-w-3xl mx-auto space-y-2">
              <div className="flex flex-wrap items-center gap-5 text-sm text-ink-200">
                <label
                  className="flex items-center gap-2"
                  title="Ask before each mouse/keyboard action. Saved as the default (also in Settings)."
                >
                  <input
                    type="checkbox"
                    checked={isProcessing ? !isDirectControl : supervised}
                    disabled={isProcessing}
                    onChange={(e) =>
                      updateSettings({ reviewEachAction: e.target.checked })
                    }
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
                    onChange={(e) =>
                      updateSettings({ zoomRefine: e.target.checked })
                    }
                  />
                  Precision clicks
                </label>
                {task && task.status !== 'completed' && (
                  <button
                    disabled={isProcessing}
                    className="px-3 py-1 rounded bg-primary-500/20 text-primary-300 disabled:opacity-50"
                    onClick={async () => {
                      setPlanOnly(false);
                      await runTask(
                        'Continue the original task from the current screen.',
                        settings,
                        supervised,
                        true,
                      );
                    }}
                  >
                    Continue task
                  </button>
                )}
              </div>
              {task && <TaskPanel task={task} expanded={planOnly} />}
            </div>
          </div>

          <ChatHistory
            messages={messages}
            expandThinkingByDefault={settings.expandThinkingByDefault}
            debugMode={settings.debugMode}
          />

          <CommandInput
            onSubmit={handleSubmit}
            onStop={stopTask}
            isProcessing={isProcessing}
            isStopping={isStopping}
            controlMode={controlMode}
          />
        </div>
      </main>

      {pendingConfirmation && (
        <ActionConfirmation request={pendingConfirmation} onStop={stopTask} />
      )}

      {/* Error toast */}
      {error && (
        <div className="fixed bottom-20 left-1/2 -translate-x-1/2 px-6 py-3 bg-ink-900 border border-danger/40 text-danger rounded-xl shadow-lg">
          {error}
          <button
            onClick={() => setError(null)}
            className="ml-4 text-danger hover:text-ink-50"
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
