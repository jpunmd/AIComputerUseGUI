import { useRef, useState } from 'react';
import { ChatSession, Message } from '../types';
import { 
  Trash2, 
  Download, 
  Upload, 
  Clock, 
  MessageSquare, 
  ChevronRight,
  Edit3,
  Check,
  X,
  FolderOpen,
  AlertCircle
} from 'lucide-react';

interface SessionHistoryProps {
  sessions: ChatSession[];
  onLoadSession: (messages: Message[]) => void;
  onDeleteSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, newName: string) => void;
  onExportSessions: (sessionIds?: string[]) => void;
  onImportSessions: (file: File) => Promise<number>;
  onClearAllSessions: () => void;
}

export function SessionHistory({
  sessions,
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

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setImportError(null);
    setImportSuccess(null);

    try {
      const count = await onImportSessions(file);
      setImportSuccess(`Successfully imported ${count} session${count !== 1 ? 's' : ''}`);
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

  return (
    <div className="flex flex-col h-full">
      {/* Header with actions */}
      <div className="p-4 border-b border-dark-700">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-white">Saved Sessions</h2>
          <span className="text-xs text-dark-400">{sessions.length} session{sessions.length !== 1 ? 's' : ''}</span>
        </div>
        
        <div className="flex gap-2">
          <button
            onClick={() => onExportSessions()}
            disabled={sessions.length === 0}
            className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-dark-800 hover:bg-dark-700 text-dark-300 hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm"
            title="Export all sessions"
          >
            <Download className="w-4 h-4" />
            Export All
          </button>
          
          <button
            onClick={handleImportClick}
            className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-dark-800 hover:bg-dark-700 text-dark-300 hover:text-white transition-colors text-sm"
            title="Import sessions"
          >
            <Upload className="w-4 h-4" />
            Import
          </button>
          
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            onChange={handleFileChange}
            className="hidden"
          />
        </div>

        {/* Import feedback */}
        {importError && (
          <div className="mt-2 px-3 py-2 rounded-lg bg-red-500/20 border border-red-500/50 text-red-400 text-xs flex items-center gap-2">
            <AlertCircle className="w-4 h-4" />
            {importError}
          </div>
        )}
        {importSuccess && (
          <div className="mt-2 px-3 py-2 rounded-lg bg-green-500/20 border border-green-500/50 text-green-400 text-xs flex items-center gap-2">
            <Check className="w-4 h-4" />
            {importSuccess}
          </div>
        )}
      </div>

      {/* Sessions list */}
      <div className="flex-1 overflow-y-auto">
        {sessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-dark-500 p-8">
            <FolderOpen className="w-12 h-12 mb-4 opacity-50" />
            <p className="text-center">No saved sessions yet</p>
            <p className="text-sm mt-1 text-center">Complete a task and save it to see it here</p>
          </div>
        ) : (
          <div className="p-2 space-y-1">
            {sessions.map((session) => (
              <div
                key={session.id}
                className="group rounded-lg bg-dark-800/50 hover:bg-dark-800 border border-dark-700 hover:border-dark-600 transition-all"
              >
                {editingId === session.id ? (
                  /* Edit mode */
                  <div className="p-3">
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleSaveEdit(session.id);
                        if (e.key === 'Escape') handleCancelEdit();
                      }}
                      className="w-full px-2 py-1 rounded bg-dark-900 border border-dark-600 text-white text-sm focus:outline-none focus:border-primary-500"
                      autoFocus
                    />
                    <div className="flex gap-2 mt-2">
                      <button
                        onClick={() => handleSaveEdit(session.id)}
                        className="flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded bg-green-500/20 text-green-400 hover:bg-green-500/30 text-xs"
                      >
                        <Check className="w-3 h-3" />
                        Save
                      </button>
                      <button
                        onClick={handleCancelEdit}
                        className="flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded bg-dark-700 text-dark-300 hover:bg-dark-600 text-xs"
                      >
                        <X className="w-3 h-3" />
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  /* View mode */
                  <div className="p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <h3 className="text-sm font-medium text-white truncate">
                          {session.name}
                        </h3>
                        <div className="flex items-center gap-3 mt-1 text-xs text-dark-400">
                          <span className="flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {formatDate(session.createdAt)}
                          </span>
                          <span className="flex items-center gap-1">
                            <MessageSquare className="w-3 h-3" />
                            {getMessageCount(session)} messages
                          </span>
                        </div>
                      </div>
                      
                      {/* Action buttons */}
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => handleStartEdit(session)}
                          className="p-1.5 rounded hover:bg-dark-600 text-dark-400 hover:text-white transition-colors"
                          title="Rename"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => onExportSessions([session.id])}
                          className="p-1.5 rounded hover:bg-dark-600 text-dark-400 hover:text-white transition-colors"
                          title="Export"
                        >
                          <Download className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => onDeleteSession(session.id)}
                          className="p-1.5 rounded hover:bg-red-500/20 text-dark-400 hover:text-red-400 transition-colors"
                          title="Delete"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    {/* Load button */}
                    <button
                      onClick={() => {
                        const messages = session.messages.map(m => ({
                          ...m,
                          timestamp: new Date(m.timestamp),
                        }));
                        onLoadSession(messages);
                      }}
                      className="w-full mt-2 flex items-center justify-center gap-2 px-3 py-1.5 rounded bg-primary-500/20 hover:bg-primary-500/30 text-primary-400 text-xs transition-colors"
                    >
                      <ChevronRight className="w-3 h-3" />
                      Load Session
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer with clear all */}
      {sessions.length > 0 && (
        <div className="p-3 border-t border-dark-700">
          {confirmClear ? (
            <div className="flex gap-2">
              <button
                onClick={() => {
                  onClearAllSessions();
                  setConfirmClear(false);
                }}
                className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-400 text-sm transition-colors"
              >
                <Check className="w-4 h-4" />
                Confirm Delete All
              </button>
              <button
                onClick={() => setConfirmClear(false)}
                className="px-3 py-2 rounded-lg bg-dark-800 hover:bg-dark-700 text-dark-300 text-sm transition-colors"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmClear(true)}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-dark-800 hover:bg-dark-700 text-dark-400 hover:text-red-400 text-sm transition-colors"
            >
              <Trash2 className="w-4 h-4" />
              Clear All Sessions
            </button>
          )}
        </div>
      )}
    </div>
  );
}
