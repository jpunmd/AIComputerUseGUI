import { useRef, useState } from 'react';
import { ChatSession, Message } from '../types';
import {
  Trash2,
  Download,
  Upload,
  Edit3,
  Check,
  X,
  FolderOpen,
  AlertCircle
} from 'lucide-react';

interface SessionHistoryProps {
  sessions: ChatSession[];
  activeSessionId?: string | null;
  disabled?: boolean; // A task is running; opening a session would replace its chat
  onLoadSession: (messages: Message[], sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, newName: string) => void;
  onExportSessions: (sessionIds?: string[]) => void;
  onImportSessions: (file: File) => Promise<number>;
  onClearAllSessions: () => void;
}

const iconButton =
  'p-1.5 rounded-md text-ink-400 hover:text-ink-50 hover:bg-ink-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed';

export function SessionHistory({
  sessions,
  activeSessionId,
  disabled = false,
  onLoadSession,
  onDeleteSession,
  onRenameSession,
  onExportSessions,
  onImportSessions,
  onClearAllSessions,
}: SessionHistoryProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleStartEdit = (session: ChatSession) => {
    setEditingId(session.id);
    setEditName(session.name);
  };

  const handleSaveEdit = (sessionId: string) => {
    if (editName.trim()) {
      onRenameSession(sessionId, editName.trim());
    }
    setEditingId(null);
    setEditName('');
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditName('');
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setImportError(null);
    setImportSuccess(null);

    try {
      const count = await onImportSessions(file);
      setImportSuccess(`Imported ${count} session${count !== 1 ? 's' : ''}`);
      setTimeout(() => setImportSuccess(null), 3000);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Failed to import');
      setTimeout(() => setImportError(null), 5000);
    }

    // Reset file input
    e.target.value = '';
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else if (diffDays === 1) {
      return 'Yesterday';
    } else if (diffDays < 7) {
      return `${diffDays} days ago`;
    } else {
      return date.toLocaleDateString();
    }
  };

  const getMessageCount = (session: ChatSession) => {
    return session.messages.filter(m => m.role !== 'system').length;
  };

  const loadSession = (session: ChatSession) => {
    const messages = session.messages.map(m => ({
      ...m,
      timestamp: new Date(m.timestamp),
    }));
    onLoadSession(messages, session.id);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header with actions */}
      <div className="flex items-center gap-1 pl-4 pr-2 py-3">
        <h2 className="text-sm font-semibold text-ink-100">Saved sessions</h2>
        {sessions.length > 0 && (
          <span className="px-1.5 text-xs rounded-full bg-ink-700 text-ink-300">
            {sessions.length}
          </span>
        )}
        <div className="ml-auto flex items-center">
          <button
            onClick={() => fileInputRef.current?.click()}
            className={iconButton}
            title="Import sessions"
            aria-label="Import sessions"
          >
            <Upload className="w-4 h-4" />
          </button>
          <button
            onClick={() => onExportSessions()}
            disabled={sessions.length === 0}
            className={iconButton}
            title="Export all sessions"
            aria-label="Export all sessions"
          >
            <Download className="w-4 h-4" />
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          onChange={handleFileChange}
          className="hidden"
        />
      </div>

      {/* Import feedback */}
      {(importError || importSuccess) && (
        <div
          className={`mx-3 mb-2 px-3 py-2 rounded-lg border text-xs flex items-start gap-2 ${
            importError
              ? 'bg-danger/15 border-danger/40 text-danger'
              : 'bg-success/15 border-success/40 text-success'
          }`}
        >
          {importError ? <AlertCircle className="w-4 h-4 shrink-0" /> : <Check className="w-4 h-4 shrink-0" />}
          {importError ?? importSuccess}
        </div>
      )}

      {/* Sessions list */}
      <div className="flex-1 overflow-y-auto px-2">
        {sessions.length === 0 ? (
          <div className="flex flex-col items-center text-center text-ink-500 px-4 py-10">
            <FolderOpen className="w-8 h-8 mb-3 opacity-60" />
            <p className="text-sm">No saved sessions yet</p>
            <p className="text-xs mt-1">Finished tasks and chats you save appear here.</p>
          </div>
        ) : (
          <ul className="space-y-0.5 pb-2">
            {sessions.map((session) => {
              const active = session.id === activeSessionId;
              return (
                <li key={session.id}>
                  {editingId === session.id ? (
                    <div className="p-2 rounded-lg bg-ink-800">
                      <input
                        type="text"
                        value={editName}
                        aria-label="Session name"
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleSaveEdit(session.id);
                          if (e.key === 'Escape') handleCancelEdit();
                        }}
                        className="w-full px-2 py-1 rounded bg-ink-950 border border-ink-600 text-ink-50 text-sm focus:outline-none focus:border-primary-500"
                        autoFocus
                      />
                      <div className="flex gap-2 mt-2">
                        <button
                          onClick={() => handleSaveEdit(session.id)}
                          className="flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded bg-success/15 text-success hover:bg-success/25 text-xs"
                        >
                          <Check className="w-3 h-3" />
                          Save
                        </button>
                        <button
                          onClick={handleCancelEdit}
                          className="flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded bg-ink-700 text-ink-300 hover:bg-ink-600 text-xs"
                        >
                          <X className="w-3 h-3" />
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div
                      className={`group relative flex items-center rounded-lg transition-colors ${
                        active ? 'bg-ink-800' : 'hover:bg-ink-800'
                      }`}
                    >
                      {active && (
                        <span aria-hidden="true" className="absolute left-0 top-2 bottom-2 w-0.5 rounded-full bg-primary-500" />
                      )}
                      <button
                        onClick={() => loadSession(session)}
                        disabled={disabled}
                        aria-current={active ? 'true' : undefined}
                        title={disabled ? 'Stop the current task to open a session' : session.name}
                        className="flex-1 min-w-0 text-left px-3 py-2 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <span className={`block text-sm truncate ${active ? 'text-ink-50 font-medium' : 'text-ink-200'}`}>
                          {session.name}
                        </span>
                        <span className="block text-xs text-ink-500 mt-0.5">
                          {formatDate(session.createdAt)} · {getMessageCount(session)} messages
                        </span>
                      </button>

                      {/* Row actions: overlaid on hover or keyboard focus, so
                          the title gets the full width the rest of the time */}
                      <div className="absolute inset-y-0 right-0 flex items-center pl-6 pr-1 rounded-r-lg bg-gradient-to-l from-ink-800 from-70% to-transparent opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto transition-opacity">
                        <button
                          onClick={() => handleStartEdit(session)}
                          className={iconButton}
                          title="Rename"
                          aria-label={`Rename ${session.name}`}
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => onExportSessions([session.id])}
                          className={iconButton}
                          title="Export"
                          aria-label={`Export ${session.name}`}
                        >
                          <Download className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => onDeleteSession(session.id)}
                          className="p-1.5 rounded-md text-ink-400 hover:text-danger hover:bg-danger/15 transition-colors"
                          title="Delete"
                          aria-label={`Delete ${session.name}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Footer with clear all */}
      {sessions.length > 0 && (
        <div className="p-2 border-t border-ink-700">
          {confirmClear ? (
            <div className="flex gap-2">
              <button
                onClick={() => {
                  onClearAllSessions();
                  setConfirmClear(false);
                }}
                className="flex-1 flex items-center justify-center gap-2 px-3 py-1.5 rounded-lg bg-danger/15 hover:bg-danger/25 text-danger text-sm transition-colors"
              >
                <Check className="w-4 h-4" />
                Delete all
              </button>
              <button
                onClick={() => setConfirmClear(false)}
                className="px-3 py-1.5 rounded-lg hover:bg-ink-800 text-ink-300 text-sm transition-colors"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmClear(true)}
              className="w-full flex items-center justify-center gap-2 px-3 py-1.5 rounded-lg hover:bg-ink-800 text-ink-400 hover:text-danger text-sm transition-colors"
            >
              <Trash2 className="w-4 h-4" />
              Clear all sessions
            </button>
          )}
        </div>
      )}
    </div>
  );
}
