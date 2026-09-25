import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatHistory, describeAction } from '../src/components/ChatHistory';
import { SessionHistory } from '../src/components/SessionHistory';
import type { ChatSession, Message } from '../src/types';
afterEach(cleanup);

// jsdom has no layout; the chat scrolls its anchor into view on update.
Element.prototype.scrollIntoView = vi.fn();

const at = (s: number) => new Date(2026, 0, 1, 12, 0, s);

describe('step timeline', () => {
  it('describes actions in plain words, with coordinates only in debug mode', () => {
    const click = { action: 'left_click', arguments: { coordinate: [300.4, 400.6] } };
    expect(describeAction(click)).toBe('Click');
    expect(describeAction(click, true)).toBe('Click (300, 401)');
    expect(describeAction({ action: 'type', arguments: { text: 'notepad' } })).toBe('Type “notepad”');
    expect(describeAction({ action: 'key', arguments: { key: 'ctrl+l' } })).toBe('Press ctrl+l');
    expect(describeAction({ action: 'scroll', arguments: { direction: 'down' } })).toBe('Scroll down');
    expect(describeAction({ action: 'none', arguments: {} })).toBeNull();
  });

  it('renders one card per step and system events without their tone symbol', () => {
    const messages: Message[] = [
      { id: 'u', role: 'user', content: 'Open Notepad', timestamp: at(0) },
      {
        id: 'a',
        role: 'assistant',
        content: 'Typing the app name.',
        timestamp: at(1),
        stepNumber: 2,
        thinking: 'The Start menu is open.',
        action: { action: 'type', arguments: { text: 'notepad' } },
      },
      { id: 's', role: 'system', content: '✓ Task completed', timestamp: at(2) },
    ];
    render(<ChatHistory messages={messages} />);
    expect(screen.getByText('Open Notepad')).toBeDefined();
    expect(screen.getByText('Step 2')).toBeDefined();
    expect(screen.getByText('Type “notepad”')).toBeDefined();
    expect(screen.getByText('Task completed')).toBeDefined();
    expect(screen.queryByText('The Start menu is open.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Thinking' }));
    expect(screen.getByText('The Start menu is open.')).toBeDefined();
  });
});

describe('sessions sidebar', () => {
  const session: ChatSession = {
    id: 's1',
    name: 'Open Notepad',
    createdAt: at(0).toISOString(),
    updatedAt: at(0).toISOString(),
    messages: [{ id: 'u', role: 'user', content: 'Open Notepad', timestamp: at(0).toISOString() }],
  };
  const props = {
    sessions: [session],
    onDeleteSession: vi.fn(),
    onRenameSession: vi.fn(),
    onExportSessions: vi.fn().mockResolvedValue(1),
    onImportSessions: vi.fn(),
    onClearAllSessions: vi.fn(),
  };

  it('opens a session by clicking its row and marks the active one', () => {
    const onLoadSession = vi.fn();
    render(<SessionHistory {...props} activeSessionId="s1" onLoadSession={onLoadSession} />);
    const row = screen.getByRole('button', { name: /^Open Notepad/ });
    expect(row.getAttribute('aria-current')).toBe('true');
    fireEvent.click(row);
    expect(onLoadSession).toHaveBeenCalledOnce();
    const [messages, id] = onLoadSession.mock.calls[0];
    expect(id).toBe('s1');
    expect(messages[0].timestamp).toBeInstanceOf(Date);
  });

  it('cannot replace the chat while a task is running', () => {
    const onLoadSession = vi.fn();
    render(<SessionHistory {...props} disabled onLoadSession={onLoadSession} />);
    const row = screen.getByRole('button', { name: /^Open Notepad/ }) as HTMLButtonElement;
    expect(row.disabled).toBe(true);
  });
});

describe('session export', () => {
  const session: ChatSession = {
    id: 's1',
    name: 'Open Notepad',
    createdAt: at(0).toISOString(),
    updatedAt: at(0).toISOString(),
    messages: [],
  };
  const props = {
    sessions: [session],
    onLoadSession: vi.fn(),
    onDeleteSession: vi.fn(),
    onRenameSession: vi.fn(),
    onImportSessions: vi.fn(),
    onClearAllSessions: vi.fn(),
  };

  it('reports how many sessions were saved', async () => {
    const onExportSessions = vi.fn().mockResolvedValue(1);
    render(<SessionHistory {...props} onExportSessions={onExportSessions} />);
    fireEvent.click(screen.getByRole('button', { name: 'Export Open Notepad' }));
    expect(onExportSessions).toHaveBeenCalledWith(['s1']);
    expect(await screen.findByText('Exported 1 session')).toBeDefined();
  });

  it('says nothing when the save dialog is cancelled, and shows failures', async () => {
    const onExportSessions = vi.fn().mockResolvedValueOnce(0).mockRejectedValueOnce(new Error('disk full'));
    render(<SessionHistory {...props} onExportSessions={onExportSessions} />);
    fireEvent.click(screen.getByRole('button', { name: 'Export all sessions' }));
    await Promise.resolve();
    expect(screen.queryByText(/Exported/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Export all sessions' }));
    expect(await screen.findByText('Export failed: disk full')).toBeDefined();
  });
});
