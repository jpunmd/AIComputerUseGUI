import { useState, FormEvent } from 'react';
import { Send, Loader2 } from 'lucide-react';

interface CommandInputProps {
  onSubmit: (query: string) => void;
  isProcessing: boolean;
  disabled?: boolean;
}

export function CommandInput({
  onSubmit,
  isProcessing,
  disabled = false,
}: CommandInputProps) {
  const [query, setQuery] = useState('');

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (query.trim() && !isProcessing && !disabled) {
      onSubmit(query.trim());
      setQuery('');
    }
  };

  return (
    <form onSubmit={handleSubmit} className="p-4 border-t border-dark-700">
      <div className="flex gap-3">
        {/* Input field */}
        <div className="flex-1 relative">
          <textarea
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (query.trim() && !isProcessing && !disabled) {
                  onSubmit(query.trim());
                  setQuery('');
                }
              }
            }}
            placeholder="Enter a command (e.g., 'Click the start button')"
            disabled={isProcessing || disabled}
            rows={2}
            className="w-full px-4 py-3 bg-dark-800 border border-dark-600 rounded-xl text-white placeholder-dark-500 focus:border-primary-500 transition-colors disabled:opacity-50 resize-none"
          />
        </div>

        {/* Submit button */}
        <button
          type="submit"
          disabled={!query.trim() || isProcessing || disabled}
          className="flex-shrink-0 px-6 py-3 rounded-xl bg-gradient-to-r from-primary-500 to-primary-600 hover:from-primary-400 hover:to-primary-500 text-white font-medium transition-all shadow-lg shadow-primary-500/25 hover:shadow-primary-500/40 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:shadow-primary-500/25"
        >
          {isProcessing ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : (
            <Send className="w-5 h-5" />
          )}
        </button>
      </div>
      
      {/* Helper text */}
      <p className="text-xs text-dark-500 mt-2 px-1">
        Describe what you want to do on the screen. Press Enter to send, Shift+Enter for new line.
      </p>
    </form>
  );
}
