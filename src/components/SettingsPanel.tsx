import { useState, useEffect } from 'react';
import { Settings as SettingsIcon, X, RotateCcw, Check, Loader2, Server, RefreshCw, FileText } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { Settings } from '../types';
import { DEFAULT_SYSTEM_PROMPT } from '../hooks/useSettings';

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

  const handleTestConnection = async () => {
    setIsTesting(true);
    setTestResult(null);
    const result = await onTestConnection();
    setTestResult(result);
    setIsTesting(false);
    setTimeout(() => setTestResult(null), 3000);
  };

  const fetchModels = async () => {
    setIsFetchingModels(true);
    setModelFetchError(null);
    try {
      const models = await invoke<string[]>('fetch_available_models', {
        apiEndpoint: settings.apiEndpoint,
      });
      setAvailableModels(models);
      // If current model is not in list and we have models, select the first one
      if (models.length > 0 && !models.includes(settings.modelId)) {
        onUpdateSettings({ modelId: models[0] });
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setModelFetchError(errorMessage);
      setAvailableModels([]);
    } finally {
      setIsFetchingModels(false);
    }
  };

  // Fetch models when the panel opens or endpoint changes
  useEffect(() => {
    if (isOpen && settings.apiEndpoint) {
      fetchModels();
    }
  }, [isOpen, settings.apiEndpoint]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="glass w-full max-w-lg mx-4 rounded-2xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-dark-700">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary-500/20">
              <SettingsIcon className="w-5 h-5 text-primary-400" />
            </div>
            <h2 className="text-xl font-semibold text-white">Settings</h2>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-dark-700 transition-colors"
          >
            <X className="w-5 h-5 text-dark-400" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6 max-h-[70vh] overflow-y-auto">
          {/* API Endpoint */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-dark-300">
              API Endpoint
            </label>
            <div className="relative">
              <Server className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-dark-500" />
              <input
                type="text"
                value={settings.apiEndpoint}
                onChange={(e) => onUpdateSettings({ apiEndpoint: e.target.value })}
                className="w-full pl-11 pr-4 py-3 bg-dark-800 border border-dark-600 rounded-lg text-white placeholder-dark-500 focus:border-primary-500 transition-colors"
                placeholder="http://localhost:8000/v1"
              />
            </div>
            <p className="text-xs text-dark-500">
              OpenAI-compatible API endpoint for Qwen3-VL
            </p>
          </div>

          {/* Model ID */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="block text-sm font-medium text-dark-300">
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
                className="w-full px-4 py-3 bg-dark-800 border border-dark-600 rounded-lg text-white focus:border-primary-500 transition-colors"
              >
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
                className="w-full px-4 py-3 bg-dark-800 border border-dark-600 rounded-lg text-white placeholder-dark-500 focus:border-primary-500 transition-colors"
                placeholder="Qwen/Qwen3-VL-30B-A3B-Instruct"
              />
            )}
            {modelFetchError && (
              <p className="text-xs text-red-400">
                Failed to fetch models: {modelFetchError}
              </p>
            )}
            {availableModels.length === 0 && !modelFetchError && !isFetchingModels && (
              <p className="text-xs text-dark-500">
                Enter model ID manually or click Refresh to fetch available models
              </p>
            )}
          </div>

          {/* System Prompt */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="block text-sm font-medium text-dark-300">
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
              className="w-full px-4 py-3 bg-dark-800 border border-dark-600 rounded-lg text-white placeholder-dark-500 focus:border-primary-500 transition-colors font-mono text-xs resize-y"
              placeholder="Enter system prompt..."
            />
            <p className="text-xs text-dark-500">
              The system prompt sent to the model. Defines how the AI interprets commands and interacts with the computer.
            </p>
          </div>

          {/* Action Delay */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-dark-300">
              Action Delay (ms)
            </label>
            <input
              type="number"
              min={0}
              max={10000}
              step={100}
              value={settings.actionDelayMs}
              onChange={(e) => onUpdateSettings({ actionDelayMs: Math.max(0, parseInt(e.target.value) || 0) })}
              className="w-full px-4 py-3 bg-dark-800 border border-dark-600 rounded-lg text-white focus:border-primary-500 transition-colors"
            />
            <p className="text-xs text-dark-500">
              Delay after each action before taking a screenshot. Increase if the screenshot captures mid-action/loading states.
            </p>
          </div>

          {/* Max Turns */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-dark-300">
              Max Turns
            </label>
            <input
              type="number"
              min={1}
              max={100}
              step={1}
              value={settings.maxTurns}
              onChange={(e) => onUpdateSettings({ maxTurns: Math.max(1, parseInt(e.target.value) || 20) })}
              className="w-full px-4 py-3 bg-dark-800 border border-dark-600 rounded-lg text-white focus:border-primary-500 transition-colors"
            />
            <p className="text-xs text-dark-500">
              Maximum number of actions before automatically stopping. Prevents infinite loops.
            </p>
          </div>

          {/* Thinking Mode */}
          <div className="flex items-center justify-between">
            <div>
              <label className="block text-sm font-medium text-dark-300">
                Thinking Mode
              </label>
              <p className="text-xs text-dark-500">
                Enable reasoning/thinking for supported models (Qwen3, DeepSeek-R1, etc.)
              </p>
            </div>
            <button
              onClick={() => onUpdateSettings({ enableThinking: !settings.enableThinking })}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                settings.enableThinking ? 'bg-primary-500' : 'bg-dark-600'
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
              <label className="block text-sm font-medium text-dark-300">
                Expand Thinking by Default
              </label>
              <p className="text-xs text-dark-500">
                Show reasoning blocks expanded instead of collapsed
              </p>
            </div>
            <button
              onClick={() => onUpdateSettings({ expandThinkingByDefault: !settings.expandThinkingByDefault })}
              disabled={!settings.enableThinking}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                settings.expandThinkingByDefault ? 'bg-primary-500' : 'bg-dark-600'
              } disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  settings.expandThinkingByDefault ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          {/* Auto-approve confirmations */}
          <div className="flex items-center justify-between">
            <div>
              <label className="block text-sm font-medium text-dark-300">
                Always Allow Sensitive Actions
              </label>
              <p className="text-xs text-dark-500">
                Skip the confirmation dialog for delete, download, install, and other sensitive actions. Off by default.
              </p>
            </div>
            <button
              onClick={() => onUpdateSettings({ autoApproveConfirmations: !settings.autoApproveConfirmations })}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                settings.autoApproveConfirmations ? 'bg-primary-500' : 'bg-dark-600'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  settings.autoApproveConfirmations ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          {/* Screenshot Resolution */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-dark-300">
              Screenshot Max Dimension
            </label>
            <select
              value={settings.screenshotMaxDimension}
              onChange={(e) => onUpdateSettings({ screenshotMaxDimension: parseInt(e.target.value) })}
              className="w-full px-4 py-3 bg-dark-800 border border-dark-600 rounded-lg text-white focus:border-primary-500 transition-colors"
            >
              <option value={768}>768px (Low - fastest, fewer tokens)</option>
              <option value={1024}>1024px (Medium-Low)</option>
              <option value={1280}>1280px (Medium - recommended)</option>
              <option value={1920}>1920px (High - 1080p equivalent)</option>
              <option value={2560}>2560px (Very High - 1440p equivalent)</option>
              <option value={3840}>3840px (Ultra - 4K, most tokens)</option>
            </select>
            <p className="text-xs text-dark-500">
              Maximum width/height for screenshots sent to the model. Lower values use fewer tokens but may lose detail.
            </p>
          </div>

          {/* Test Connection */}
          <div className="pt-2">
            <button
              onClick={handleTestConnection}
              disabled={isTesting}
              className={`w-full py-3 px-4 rounded-lg font-medium transition-all flex items-center justify-center gap-2 ${
                testResult === true
                  ? 'bg-green-500/20 text-green-400 border border-green-500/50'
                  : testResult === false
                  ? 'bg-red-500/20 text-red-400 border border-red-500/50'
                  : 'bg-dark-700 text-dark-200 border border-dark-600 hover:bg-dark-600'
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
        <div className="flex items-center justify-between px-6 py-4 border-t border-dark-700 bg-dark-900/50">
          <button
            onClick={onResetSettings}
            className="flex items-center gap-2 px-4 py-2 text-dark-400 hover:text-white transition-colors"
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
