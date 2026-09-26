import { useState, useEffect, useRef } from 'react';
import { Settings as SettingsIcon, X, RotateCcw, Check, Loader2, Server, RefreshCw, FileText } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { Settings } from '../types';
import { DEFAULT_SYSTEM_PROMPT, pickModel } from '../hooks/useSettings';

interface SettingsPanelProps {
  settings: Settings;
  onUpdateSettings: (updates: Partial<Settings>) => void;
  onResetSettings: () => void;
  onTestConnection: () => Promise<boolean>;
  isOpen: boolean;
  onClose: () => void;
}

export function SettingsPanel({
  settings,
  onUpdateSettings,
  onResetSettings,
  onTestConnection,
  isOpen,
  onClose,
}: SettingsPanelProps) {
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<boolean | null>(null);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [modelFetchError, setModelFetchError] = useState<string | null>(null);
  // Monotonic id per fetch so a slow response for an old endpoint can't
  // overwrite the results of a newer request.
  const fetchSeqRef = useRef(0);

  const handleTestConnection = async () => {
    setIsTesting(true);
    setTestResult(null);
    const result = await onTestConnection();
    setTestResult(result);
    setIsTesting(false);
    setTimeout(() => setTestResult(null), 3000);
  };

  const fetchModels = async () => {
    const seq = ++fetchSeqRef.current;
    setIsFetchingModels(true);
    setModelFetchError(null);
    try {
      const models = await invoke<string[]>('fetch_available_models', {
        apiEndpoint: settings.apiEndpoint,
      });
      if (seq !== fetchSeqRef.current) return; // Stale response — ignore
      setAvailableModels(models);
      // Default to a model the server actually serves (loaded ones are listed
      // first). A listed choice is kept; an unreachable server changes nothing.
      const model = pickModel(settings.modelId, models);
      if (model) onUpdateSettings({ modelId: model });
    } catch (err) {
      if (seq !== fetchSeqRef.current) return; // Stale response — ignore
      const errorMessage = err instanceof Error ? err.message : String(err);
      setModelFetchError(errorMessage);
      setAvailableModels([]);
    } finally {
      if (seq === fetchSeqRef.current) {
        setIsFetchingModels(false);
      }
    }
  };

  // Fetch models when the panel opens or the endpoint changes. Debounced so
  // typing in the endpoint field doesn't fire a request per keystroke.
  useEffect(() => {
    if (!isOpen || !settings.apiEndpoint) return;
    const timer = setTimeout(fetchModels, 400);
    return () => clearTimeout(timer);
  }, [isOpen, settings.apiEndpoint]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="glass w-full max-w-lg mx-4 rounded-2xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-ink-700">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary-500/20">
              <SettingsIcon className="w-5 h-5 text-primary-400" />
            </div>
            <h2 className="text-xl font-semibold text-ink-50">Settings</h2>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-ink-700 transition-colors"
          >
            <X className="w-5 h-5 text-ink-400" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6 max-h-[70vh] overflow-y-auto">
          {/* API Endpoint */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-ink-300">
              API Endpoint
            </label>
            <div className="relative">
              <Server className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-ink-500" />
              <input
                type="text"
                value={settings.apiEndpoint}
                onChange={(e) => onUpdateSettings({ apiEndpoint: e.target.value })}
                className="w-full pl-11 pr-4 py-3 bg-ink-800 border border-ink-600 rounded-lg text-ink-50 placeholder-ink-500 focus:border-primary-500 transition-colors"
                placeholder="http://localhost:8000/v1"
              />
            </div>
            <p className="text-xs text-ink-500">
              OpenAI-compatible API endpoint for your vision-language model
            </p>
          </div>

          {/* Model ID */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="block text-sm font-medium text-ink-300">
                Model
              </label>
              <button
                onClick={fetchModels}
                disabled={isFetchingModels}
                className="flex items-center gap-1 text-xs text-primary-400 hover:text-primary-300 transition-colors disabled:opacity-50"
              >
                <RefreshCw className={`w-3 h-3 ${isFetchingModels ? 'animate-spin' : ''}`} />
                Refresh
              </button>
            </div>
            {availableModels.length > 0 ? (
              <select
                value={settings.modelId}
                onChange={(e) => onUpdateSettings({ modelId: e.target.value })}
                className="w-full px-4 py-3 bg-ink-800 border border-ink-600 rounded-lg text-ink-50 focus:border-primary-500 transition-colors"
              >
                {!availableModels.includes(settings.modelId) && (
                  <option value={settings.modelId}>
                    {settings.modelId} (current, not in server list)
                  </option>
                )}
                {availableModels.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={settings.modelId}
                onChange={(e) => onUpdateSettings({ modelId: e.target.value })}
                className="w-full px-4 py-3 bg-ink-800 border border-ink-600 rounded-lg text-ink-50 placeholder-ink-500 focus:border-primary-500 transition-colors"
                placeholder="Qwen/Qwen3-VL-30B-A3B-Instruct"
              />
            )}
            {modelFetchError && (
              <p className="text-xs text-danger">
                Failed to fetch models: {modelFetchError}
              </p>
            )}
            {availableModels.length === 0 && !modelFetchError && !isFetchingModels && (
              <p className="text-xs text-ink-500">
                Enter model ID manually or click Refresh to fetch available models
              </p>
            )}
          </div>

          {/* Review each action (saved default for new runs) */}
          <div className="flex items-center justify-between">
            <div className="pr-4">
              <label
                id="review-each-action-label"
                className="block text-sm font-medium text-ink-300"
              >
                Review Each Action
              </label>
              <p className="text-xs text-ink-500">
                Ask for approval before every mouse or keyboard action. Turn off to let tasks control the computer directly. Saved as the default and applied when the next task starts.
              </p>
              {!settings.reviewEachAction && (
                <p className="text-xs text-warning mt-1">
                  Direct control: actions will run without review.
                </p>
              )}
            </div>
            <button
              role="switch"
              aria-checked={settings.reviewEachAction}
              aria-labelledby="review-each-action-label"
              onClick={() => onUpdateSettings({ reviewEachAction: !settings.reviewEachAction })}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0 ${
                settings.reviewEachAction ? 'bg-primary-500' : 'bg-ink-600'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  settings.reviewEachAction ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          {/* System Prompt */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="block text-sm font-medium text-ink-300">
                <div className="flex items-center gap-2">
                  <FileText className="w-4 h-4" />
                  System Prompt
                </div>
              </label>
              <button
                onClick={() => onUpdateSettings({ systemPrompt: DEFAULT_SYSTEM_PROMPT })}
                className="flex items-center gap-1 text-xs text-primary-400 hover:text-primary-300 transition-colors"
              >
                <RotateCcw className="w-3 h-3" />
                Reset to Default
              </button>
            </div>
            <textarea
              value={settings.systemPrompt}
              onChange={(e) => onUpdateSettings({ systemPrompt: e.target.value })}
              rows={10}
              className="w-full px-4 py-3 bg-ink-800 border border-ink-600 rounded-lg text-ink-50 placeholder-ink-500 focus:border-primary-500 transition-colors font-mono text-xs resize-y"
              placeholder="Enter system prompt..."
            />
            <p className="text-xs text-ink-500">
              The system prompt sent to the model. Defines how the AI interprets commands and interacts with the computer.
            </p>
          </div>

          {/* Action Delay */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-ink-300">
              Action Delay (ms)
            </label>
            <input
              type="number"
              min={0}
              max={10000}
              step={100}
              value={settings.actionDelayMs}
              onChange={(e) => onUpdateSettings({ actionDelayMs: Math.max(0, parseInt(e.target.value) || 0) })}
              className="w-full px-4 py-3 bg-ink-800 border border-ink-600 rounded-lg text-ink-50 focus:border-primary-500 transition-colors"
            />
            <p className="text-xs text-ink-500">
              Delay after each action before taking a screenshot. Increase if the screenshot captures mid-action/loading states.
            </p>
          </div>

          {/* Max Turns */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-ink-300">
              Max Turns
            </label>
            <input
              type="number"
              min={1}
              max={100}
              step={1}
              value={settings.maxTurns}
              onChange={(e) => onUpdateSettings({ maxTurns: Math.max(1, parseInt(e.target.value) || 20) })}
              className="w-full px-4 py-3 bg-ink-800 border border-ink-600 rounded-lg text-ink-50 focus:border-primary-500 transition-colors"
            />
            <p className="text-xs text-ink-500">
              Maximum number of actions before automatically stopping. Prevents infinite loops.
            </p>
          </div>

          {/* Thinking Mode */}
          <div className="flex items-center justify-between">
            <div>
              <label className="block text-sm font-medium text-ink-300">
                Thinking Mode
              </label>
              <p className="text-xs text-ink-500">
                Enable reasoning/thinking for models that support it (Qwen3, Gemma, DeepSeek-R1, etc.)
              </p>
            </div>
            <button
              onClick={() => onUpdateSettings({ enableThinking: !settings.enableThinking })}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                settings.enableThinking ? 'bg-primary-500' : 'bg-ink-600'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  settings.enableThinking ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          {/* Expand thinking by default */}
          <div className="flex items-center justify-between">
            <div>
              <label className="block text-sm font-medium text-ink-300">
                Expand Thinking by Default
              </label>
              <p className="text-xs text-ink-500">
                Show reasoning blocks expanded instead of collapsed
              </p>
            </div>
            <button
              onClick={() => onUpdateSettings({ expandThinkingByDefault: !settings.expandThinkingByDefault })}
              disabled={!settings.enableThinking}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                settings.expandThinkingByDefault ? 'bg-primary-500' : 'bg-ink-600'
              } disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  settings.expandThinkingByDefault ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          {/* Task planning */}
          <div className="flex items-center justify-between">
            <div>
              <label className="block text-sm font-medium text-ink-300">
                Plan Before Acting
              </label>
              <p className="text-xs text-ink-500">
                Create a short plan and keep it in task context during multi-step work.
              </p>
            </div>
            <button
              onClick={() => onUpdateSettings({ enablePlanning: !settings.enablePlanning })}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                settings.enablePlanning ? 'bg-primary-500' : 'bg-ink-600'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  settings.enablePlanning ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          {/* Screenshot Resolution */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-ink-300">
              Screenshot Max Dimension
            </label>
            <select
              value={settings.screenshotMaxDimension}
              onChange={(e) => onUpdateSettings({ screenshotMaxDimension: parseInt(e.target.value) })}
              className="w-full px-4 py-3 bg-ink-800 border border-ink-600 rounded-lg text-ink-50 focus:border-primary-500 transition-colors"
            >
              <option value={768}>768px (Low - fastest, fewer tokens)</option>
              <option value={1024}>1024px (Medium-Low)</option>
              <option value={1280}>1280px (Medium)</option>
              <option value={1920}>1920px (1080p - recommended)</option>
              <option value={2560}>2560px (Very High - 1440p equivalent)</option>
              <option value={3840}>3840px (Ultra - 4K, most tokens)</option>
            </select>
            <p className="text-xs text-ink-500">
              Longest side of the screenshot sent to the model. Clicks map to the full screen at any setting. 1080p suits most displays; a 4K screen is downscaled exactly 2:1. Lower values use fewer tokens but lose detail.
            </p>
          </div>

          {/* Save screenshots in sessions */}
          <div className="flex items-center justify-between">
            <div className="pr-4">
              <label className="block text-sm font-medium text-ink-300">
                Save Screenshots in Sessions
              </label>
              <p className="text-xs text-ink-500">
                Include screenshots and zoom crops when saving sessions to history. Turn off to save text, actions, and thinking only — sessions stay tiny.
              </p>
            </div>
            <button
              onClick={() => onUpdateSettings({ saveScreenshotsInSessions: !settings.saveScreenshotsInSessions })}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0 ${
                settings.saveScreenshotsInSessions ? 'bg-primary-500' : 'bg-ink-600'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  settings.saveScreenshotsInSessions ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          {/* Zoom Refine (two-pass coarse-to-fine) */}
          <div className="flex items-center justify-between">
            <div className="pr-4">
              <label className="block text-sm font-medium text-ink-300">
                Precision Clicks
              </label>
              <p className="text-xs text-ink-500">
                Check the intended target in a magnified view of the same screenshot before clicking. Adds one model request; only one click is sent.
              </p>
            </div>
            <button
              onClick={() => onUpdateSettings({ zoomRefine: !settings.zoomRefine })}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0 ${
                settings.zoomRefine ? 'bg-primary-500' : 'bg-ink-600'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  settings.zoomRefine ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          {/* Zoom crop size - only relevant when refine is on */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-ink-300">
              Zoom Crop Size
            </label>
            <select
              value={settings.zoomCropFraction}
              onChange={(e) => onUpdateSettings({ zoomCropFraction: parseFloat(e.target.value) })}
              disabled={!settings.zoomRefine}
              className="w-full px-4 py-3 bg-ink-800 border border-ink-600 rounded-lg text-ink-50 focus:border-primary-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <option value={0.2}>20% (tightest zoom — small targets, riskier if coarse is off)</option>
              <option value={0.3}>30% (recommended)</option>
              <option value={0.4}>40% (safer framing, less magnification)</option>
              <option value={0.5}>50% (loosest)</option>
            </select>
            <p className="text-xs text-ink-500">
              Size of the zoom window as a fraction of the screen, centered on the first prediction. Smaller = more magnification, but the true target must fall inside it.
            </p>
          </div>

          {/* Bounding-box clicks - works standalone or as the pass-2 format */}
          <div className="flex items-center justify-between">
            <div className="pr-4">
              <label className="block text-sm font-medium text-ink-300">
                Click with Bounding Box
              </label>
              <p className="text-xs text-ink-500">
                Instead of picking a single point, the model outlines the target with a box and the click lands at its center. Often more accurate on small icons and buttons. Works on its own or combined with Zoom Refine.
              </p>
            </div>
            <button
              onClick={() => onUpdateSettings({ boxRefine: !settings.boxRefine })}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0 ${
                settings.boxRefine ? 'bg-primary-500' : 'bg-ink-600'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  settings.boxRefine ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          {/* Debug Mode */}
          <div className="flex items-center justify-between">
            <div className="pr-4">
              <label className="block text-sm font-medium text-ink-300">
                Debug Mode
              </label>
              <p className="text-xs text-ink-500">
                Show developer instruments — the calibration probe in the expanded screenshot view (click-to-measure click accuracy, sample recording, and the fit).
              </p>
            </div>
            <button
              onClick={() => onUpdateSettings({ debugMode: !settings.debugMode })}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0 ${
                settings.debugMode ? 'bg-primary-500' : 'bg-ink-600'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  settings.debugMode ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          {/* Test Connection */}
          <div className="pt-2">
            <button
              onClick={handleTestConnection}
              disabled={isTesting}
              className={`w-full py-3 px-4 rounded-lg font-medium transition-all flex items-center justify-center gap-2 ${
                testResult === true
                  ? 'bg-success/15 text-success border border-success/40'
                  : testResult === false
                  ? 'bg-danger/15 text-danger border border-danger/40'
                  : 'bg-ink-700 text-ink-200 border border-ink-600 hover:bg-ink-600'
              }`}
            >
              {isTesting ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  Testing Connection...
                </>
              ) : testResult === true ? (
                <>
                  <Check className="w-5 h-5" />
                  Connection Successful
                </>
              ) : testResult === false ? (
                <>
                  <X className="w-5 h-5" />
                  Connection Failed
                </>
              ) : (
                'Test Connection'
              )}
            </button>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-ink-700 bg-ink-900/50">
          <button
            onClick={onResetSettings}
            className="flex items-center gap-2 px-4 py-2 text-ink-400 hover:text-ink-50 transition-colors"
          >
            <RotateCcw className="w-4 h-4" />
            Reset to Defaults
          </button>
          <button
            onClick={onClose}
            className="btn-primary"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
