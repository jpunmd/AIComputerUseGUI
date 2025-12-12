import { useState, useCallback, useEffect } from 'react';
import { ChatSession, Message, SerializedMessage } from '../types';

const STORAGE_KEY = 'ai-computer-use-sessions';

// Convert Message to SerializedMessage (Date to ISO string)
export function serializeMessage(message: Message): SerializedMessage {
  return {
    ...message,
    timestamp: message.timestamp.toISOString(),
  };
}

// Convert SerializedMessage to Message (ISO string to Date)
export function deserializeMessage(message: SerializedMessage): Message {
  return {
    ...message,
    timestamp: new Date(message.timestamp),
  };
}

export function useSessions() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);

  // Load sessions from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as ChatSession[];
        setSessions(parsed);
      }
    } catch (err) {
      console.error('Failed to load sessions:', err);
    }
  }, []);

  // Save sessions to localStorage whenever they change
  const persistSessions = useCallback((newSessions: ChatSession[]) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(newSessions));
      setSessions(newSessions);
    } catch (err) {
      console.error('Failed to save sessions:', err);
    }
  }, []);

  // Save current chat as a new session
  const saveSession = useCallback((messages: Message[], name?: string): ChatSession => {
    const now = new Date().toISOString();
    
    // Try to get initial query from first user message
    const firstUserMessage = messages.find(m => m.role === 'user');
    const initialQuery = firstUserMessage?.content || 'Untitled Session';
    
    const session: ChatSession = {
      id: crypto.randomUUID(),
      name: name || initialQuery.slice(0, 50) + (initialQuery.length > 50 ? '...' : ''),
      createdAt: now,
      updatedAt: now,
      messages: messages.map(serializeMessage),
      initialQuery,
    };

    const newSessions = [session, ...sessions];
    persistSessions(newSessions);
    return session;
  }, [sessions, persistSessions]);

  // Delete a session
  const deleteSession = useCallback((sessionId: string) => {
    const newSessions = sessions.filter(s => s.id !== sessionId);
    persistSessions(newSessions);
  }, [sessions, persistSessions]);

  // Rename a session
  const renameSession = useCallback((sessionId: string, newName: string) => {
    const newSessions = sessions.map(s => 
      s.id === sessionId 
        ? { ...s, name: newName, updatedAt: new Date().toISOString() }
        : s
    );
    persistSessions(newSessions);
  }, [sessions, persistSessions]);

  // Get messages from a session (deserialized)
  const getSessionMessages = useCallback((sessionId: string): Message[] | null => {
    const session = sessions.find(s => s.id === sessionId);
    if (!session) return null;
    return session.messages.map(deserializeMessage);
  }, [sessions]);

  // Export sessions to JSON file
  const exportSessions = useCallback((sessionIds?: string[]) => {
    const toExport = sessionIds 
      ? sessions.filter(s => sessionIds.includes(s.id))
      : sessions;
    
    const blob = new Blob([JSON.stringify(toExport, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ai-computer-use-sessions-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [sessions]);

  // Import sessions from JSON file
  const importSessions = useCallback((file: File): Promise<number> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const content = e.target?.result as string;
          const imported = JSON.parse(content) as ChatSession[];
          
          if (!Array.isArray(imported)) {
            throw new Error('Invalid format: expected an array of sessions');
          }

          // Validate and regenerate IDs to avoid conflicts
          const validSessions = imported.map(session => {
            if (!session.messages || !Array.isArray(session.messages)) {
              throw new Error('Invalid session: missing messages array');
            }
            return {
              ...session,
              id: crypto.randomUUID(), // New ID to avoid conflicts
              createdAt: session.createdAt || new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            };
          });

          const newSessions = [...validSessions, ...sessions];
          persistSessions(newSessions);
          resolve(validSessions.length);
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsText(file);
    });
  }, [sessions, persistSessions]);

  // Clear all sessions
  const clearAllSessions = useCallback(() => {
    persistSessions([]);
  }, [persistSessions]);

  return {
    sessions,
    saveSession,
    deleteSession,
    renameSession,
    getSessionMessages,
    exportSessions,
    importSessions,
    clearAllSessions,
  };
}
