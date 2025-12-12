import { useState } from 'react';
import { Settings as SettingsIcon, X, RotateCcw, Check, Loader2, Server } from 'lucide-react';
import { Settings } from '../types';

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

  const handleTestConnection = async () => {
    setIsTesting(true);
    setTestResult(null);
    const result = await onTestConnection();
    setTestResult(result);
    setIsTesting(false);
    setTimeout(() => setTestResult(null), 3000);
  };

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
            <label className="block text-sm font-medium text-dark-300">
              Model ID
            </label>
            <input
              type="text"
              value={settings.modelId}
              onChange={(e) => onUpdateSettings({ modelId: e.target.value })}
              className="w-full px-4 py-3 bg-dark-800 border border-dark-600 rounded-lg text-white placeholder-dark-500 focus:border-primary-500 transition-colors"
              placeholder="Qwen/Qwen3-VL-30B-A3B-Instruct"
            />
          </div>

          {/* Max Tokens */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-dark-300">
              Max Tokens
            </label>
            <input
              type="number"
              value={settings.maxTokens}
              onChange={(e) => onUpdateSettings({ maxTokens: parseInt(e.target.value) || 2048 })}
              className="w-full px-4 py-3 bg-dark-800 border border-dark-600 rounded-lg text-white focus:border-primary-500 transition-colors"
            />
          </div>

          {/* Verbosity */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-dark-300">
              Response Verbosity
            </label>
            <select
              value={settings.verbosity}
              onChange={(e) => onUpdateSettings({ verbosity: e.target.value as 'concise' | 'normal' | 'verbose' })}
              className="w-full px-4 py-3 bg-dark-800 border border-dark-600 rounded-lg text-white focus:border-primary-500 transition-colors"
            >
              <option value="concise">Concise - Just actions, minimal explanation</option>
              <option value="normal">Normal - Brief explanations</option>
              <option value="verbose">Verbose - Detailed reasoning</option>
            </select>
            <p className="text-xs text-dark-500">
              Controls how much the AI explains its reasoning
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
