import { useState, useCallback, useEffect } from 'react';
import { ChatSession, Message, SerializedMessage } from '../types';

// Sessions used to live in localStorage under this key, but base64 screenshots
// blow past its ~10MB quota after a handful of sessions. They now live in
// IndexedDB, whose quota is a share of the disk; this key is only read once on
// startup to migrate old data (and clearing it frees the localStorage quota).
const LEGACY_STORAGE_KEY = 'ai-computer-use-sessions';

const DB_NAME = 'ai-computer-use';
const DB_VERSION = 1;
const SESSIONS_STORE = 'sessions';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(SESSIONS_STORE)) {
          db.createObjectStore(SESSIONS_STORE, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        dbPromise = null; // Allow a retry on the next call
        reject(request.error ?? new Error('Failed to open IndexedDB'));
      };
    });
  }
  return dbPromise;
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

async function idbPutSessions(sessions: ChatSession[]): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(SESSIONS_STORE, 'readwrite');
  const store = tx.objectStore(SESSIONS_STORE);
  for (const session of sessions) {
    store.put(session);
  }
  await txDone(tx);
}

async function idbDeleteSession(sessionId: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(SESSIONS_STORE, 'readwrite');
  tx.objectStore(SESSIONS_STORE).delete(sessionId);
  await txDone(tx);
}

async function idbClearSessions(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(SESSIONS_STORE, 'readwrite');
  tx.objectStore(SESSIONS_STORE).clear();
  await txDone(tx);
}

async function idbGetAllSessions(): Promise<ChatSession[]> {
  const db = await openDb();
  const tx = db.transaction(SESSIONS_STORE, 'readonly');
  const request = tx.objectStore(SESSIONS_STORE).getAll();
  await txDone(tx);
  return (request.result ?? []) as ChatSession[];
}

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

// Drop the base64 images — text, actions, and thinking are the valuable part
const stripImages = (messages: SerializedMessage[]): SerializedMessage[] =>
  messages.map(({ screenshot, zoomCrop, ...rest }) => rest);

// Outcome of a save attempt: `session` is null when nothing could be
// persisted; `slimmed` is true when it only fit after dropping images.
export interface SaveResult {
  session: ChatSession | null;
  slimmed: boolean;
}

export interface SaveOptions {
  name?: string;
  // When false, screenshots and zoom crops are stripped before saving so
  // sessions stay tiny (text, actions, and thinking are kept)
  includeScreenshots?: boolean;
}

export function useSessions() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);

  // Load sessions from IndexedDB on mount, migrating any sessions saved by
  // older versions into localStorage
  useEffect(() => {
    (async () => {
      try {
        const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
        if (legacy) {
          try {
            const parsed = JSON.parse(legacy) as ChatSession[];
            if (Array.isArray(parsed) && parsed.length > 0) {
              await idbPutSessions(parsed);
            }
            localStorage.removeItem(LEGACY_STORAGE_KEY);
          } catch (err) {
            // Leave the localStorage copy in place if migration failed
            console.error('Failed to migrate sessions from localStorage:', err);
          }
        }

        const all = await idbGetAllSessions();
        // getAll() returns records in key (UUID) order; show newest first
        all.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
        setSessions(all);
      } catch (err) {
        console.error('Failed to load sessions:', err);
      }
    })();
  }, []);

  // Save current chat as a new session
  const saveSession = useCallback(async (messages: Message[], options?: SaveOptions): Promise<SaveResult> => {
    const now = new Date().toISOString();

    // Try to get initial query from first user message
    const firstUserMessage = messages.find(m => m.role === 'user');
    const initialQuery = firstUserMessage?.content || 'Untitled Session';

    const includeScreenshots = options?.includeScreenshots ?? true;
    const serialized = messages.map(serializeMessage);

    const session: ChatSession = {
      id: crypto.randomUUID(),
      name: options?.name || initialQuery.slice(0, 50) + (initialQuery.length > 50 ? '...' : ''),
      createdAt: now,
      updatedAt: now,
      messages: includeScreenshots ? serialized : stripImages(serialized),
      initialQuery,
    };

    try {
      await idbPutSessions([session]);
      setSessions(prev => [session, ...prev]);
      return { session, slimmed: false };
    } catch (err) {
      console.error('Failed to save session:', err);
    }

    // Unlikely to hit quota with IndexedDB, but keep the fallback: retry
    // without the base64 images
    if (includeScreenshots) {
      const slimSession: ChatSession = {
        ...session,
        messages: stripImages(serialized),
      };
      try {
        await idbPutSessions([slimSession]);
        setSessions(prev => [slimSession, ...prev]);
        return { session: slimSession, slimmed: true };
      } catch (err) {
        console.error('Failed to save slimmed session:', err);
      }
    }

    return { session: null, slimmed: false };
  }, []);

  // Delete a session
  const deleteSession = useCallback(async (sessionId: string) => {
    try {
      await idbDeleteSession(sessionId);
      setSessions(prev => prev.filter(s => s.id !== sessionId));
    } catch (err) {
      console.error('Failed to delete session:', err);
    }
  }, []);

  // Rename a session
  const renameSession = useCallback(async (sessionId: string, newName: string) => {
    const target = sessions.find(s => s.id === sessionId);
    if (!target) return;
    const updated: ChatSession = { ...target, name: newName, updatedAt: new Date().toISOString() };
    try {
      await idbPutSessions([updated]);
      setSessions(prev => prev.map(s => (s.id === sessionId ? updated : s)));
    } catch (err) {
      console.error('Failed to rename session:', err);
    }
  }, [sessions]);

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
      reader.onload = async (e) => {
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

          await idbPutSessions(validSessions);
          setSessions(prev => [...validSessions, ...prev]);
          resolve(validSessions.length);
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsText(file);
    });
  }, []);

  // Clear all sessions
  const clearAllSessions = useCallback(async () => {
    try {
      await idbClearSessions();
      setSessions([]);
    } catch (err) {
      console.error('Failed to clear sessions:', err);
    }
  }, []);

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
