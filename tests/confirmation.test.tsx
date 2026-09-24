import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionConfirmation } from '../src/components/ActionConfirmation';
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
