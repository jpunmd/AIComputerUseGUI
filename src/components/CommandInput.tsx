import { useState, FormEvent } from 'react';
import { Send, ShieldCheck, ShieldAlert, StopCircle } from 'lucide-react';

// How mouse/keyboard actions run: each one reviewed, all executed directly by
// default, or directly because the user chose "Allow for this task" mid-run.
export type ControlMode = 'supervised' | 'direct' | 'allowed-for-task';

interface CommandInputProps {
  onSubmit: (query: string) => void;
  onStop: () => void;
  isProcessing: boolean;
  isStopping?: boolean;
  controlMode: ControlMode;
  disabled?: boolean;
}

const MODE_BADGE: Record<ControlMode, { label: string; title: string }> = {
  supervised: {
    label: 'Supervised — you approve each action',
    title: 'Every mouse and keyboard action waits for your approval.',
  },
  direct: {
    label: 'Direct control — actions run without review',
    title: 'Mouse and keyboard actions execute immediately. Turn on "Review each action" to approve each one.',
  },
  'allowed-for-task': {
    label: 'Direct control for this run — you allowed this task',
    title: 'Review resumes when this run ends.',
  },
};

function ModeBadge({ mode }: { mode: ControlMode }) {
  const { label, title } = MODE_BADGE[mode];
  const supervised = mode === 'supervised';
  const Icon = supervised ? ShieldCheck : ShieldAlert;
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${
        supervised
          ? 'bg-success/10 text-success border-success/30'
          : 'bg-warning/15 text-warning border-warning/40'
      }`}
    >
      <Icon className="w-3.5 h-3.5" />
      {label}
    </span>
  );
}

export function CommandInput({
  onSubmit,
  onStop,
  isProcessing,
  isStopping = false,
  controlMode,
  disabled = false,
}: CommandInputProps) {
  const [query, setQuery] = useState('');

  const submit = () => {
    if (query.trim() && !isProcessing && !disabled) {
      onSubmit(query.trim());
      setQuery('');
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit();
  };

  return (
    <form onSubmit={handleSubmit} className="px-6 py-4 border-t border-ink-700">
      <div className="max-w-3xl mx-auto">
        <div className="flex gap-3">
          {/* Input field */}
          <div className="flex-1 relative">
            <textarea
              maxLength={8192}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                // Don't submit while an IME composition is in progress (CJK
                // input) — Enter there confirms the composition, not the message.
                if (e.nativeEvent.isComposing) return;
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder="Enter a command (e.g., 'Click the start button')"
              disabled={isProcessing || disabled}
              rows={2}
              className="w-full px-4 py-3 bg-ink-800 border border-ink-600 rounded-xl text-ink-50 placeholder-ink-500 focus:border-primary-500 transition-colors disabled:opacity-50 resize-none"
            />
          </div>

          {/* Send, or Stop while anything is running (preview, inference, or task) */}
          {isProcessing ? (
            <button
              type="button"
              onClick={onStop}
              disabled={isStopping}
              className="flex-shrink-0 flex items-center gap-2 px-5 py-3 rounded-xl bg-danger text-white font-medium hover:bg-danger/90 transition-colors disabled:opacity-60 disabled:cursor-wait"
              title="Stop execution (Ctrl+Alt+F12 works outside this window)"
            >
              <StopCircle className={`w-5 h-5 ${isStopping ? 'animate-pulse' : ''}`} />
              {isStopping ? 'Stopping…' : 'Stop'}
            </button>
          ) : (
            <button
              type="submit"
              aria-label="Send"
              disabled={!query.trim() || disabled}
              className="flex-shrink-0 px-6 py-3 rounded-xl bg-primary-600 hover:bg-primary-500 text-white font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Send className="w-5 h-5" />
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 mt-2 px-1">
          <ModeBadge mode={controlMode} />
          {isProcessing ? (
            <span className="text-xs text-ink-400">
              Emergency stop from anywhere:{' '}
              <kbd className="px-1.5 py-0.5 rounded border border-ink-600 bg-ink-800 font-sans text-ink-200">
                Ctrl+Alt+F12
              </kbd>
            </span>
          ) : (
            <span className="text-xs text-ink-500">
              Enter to send · Shift+Enter for a new line
            </span>
          )}
        </div>
      </div>
    </form>
  );
}
