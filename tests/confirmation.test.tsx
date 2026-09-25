import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ActionConfirmation,
  ENTER_ARM_DELAY_MS,
} from '../src/components/ActionConfirmation';
afterEach(cleanup);

describe('task approval dialog', () => {
  it('offers task permission next to one-time approval and shows the precise target', () => {
    const request = {
      message: 'Click the marked target',
      onConfirm: vi.fn(),
      onDeny: vi.fn(),
      onAllowTask: vi.fn(),
      preview: { image: 'test', coordinate: [400, 900] },
    };
    const stop = vi.fn();
    render(<ActionConfirmation request={request} onStop={stop} />);
    expect(screen.getByRole('dialog')).toBeDefined();
    expect(screen.getByAltText('Proposed click target')).toBeDefined();
    fireEvent.click(
      screen.getByRole('button', { name: 'Allow for this task' }),
    );
    expect(request.onAllowTask).toHaveBeenCalledOnce();
    expect(request.onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));
    expect(request.onConfirm).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: /Stop task/ }));
    expect(stop).toHaveBeenCalledOnce();
  });
  it('approves with Enter only after a short delay, and rejects with Escape', () => {
    vi.useFakeTimers();
    try {
      const request = {
        message: 'Click the marked target',
        onConfirm: vi.fn(),
        onDeny: vi.fn(),
      };
      render(<ActionConfirmation request={request} onStop={vi.fn()} />);
      fireEvent.keyDown(window, { key: 'Enter' });
      expect(request.onConfirm).not.toHaveBeenCalled();
      vi.advanceTimersByTime(ENTER_ARM_DELAY_MS);
      fireEvent.keyDown(window, { key: 'Enter', repeat: true });
      expect(request.onConfirm).not.toHaveBeenCalled();
      fireEvent.keyDown(window, { key: 'Enter' });
      expect(request.onConfirm).toHaveBeenCalledOnce();
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(request.onDeny).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
  it('leaves Enter on a focused button to that button', () => {
    vi.useFakeTimers();
    try {
      const request = {
        message: 'Click the marked target',
        onConfirm: vi.fn(),
        onDeny: vi.fn(),
      };
      render(<ActionConfirmation request={request} onStop={vi.fn()} />);
      vi.advanceTimersByTime(ENTER_ARM_DELAY_MS);
      fireEvent.keyDown(screen.getByRole('button', { name: 'Reject' }), {
        key: 'Enter',
      });
      expect(request.onConfirm).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it('shows only one-time approval for model questions', () => {
    render(
      <ActionConfirmation
        request={{
          message: 'Open which report?',
          onConfirm: vi.fn(),
          onDeny: vi.fn(),
        }}
        onStop={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole('button', { name: 'Allow for this task' }),
    ).toBeNull();
  });
});
