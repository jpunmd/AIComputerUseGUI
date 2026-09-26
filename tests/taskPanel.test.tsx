import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { TaskPanel } from '../src/components/TaskPanel';
import { TaskMemory } from '../src/agent/memory';
afterEach(cleanup);

it('shows milestone state, success conditions, observed evidence and failed approaches', () => {
  const memory = new TaskMemory();
  memory.start('Save report', true);
  memory.observe('screen-1');
  memory.setPlan(['Open report', 'Save report -> Saved label visible']);
  memory.applyProgress({
    milestones: [
      { id: 'm1-1', status: 'completed', evidence: 'Report text is visible' },
      { id: 'm1-2', status: 'blocked', evidence: 'Destination is unknown' },
    ],
  });
  memory.interrupted('Save dialog did not open');
  render(<TaskPanel task={memory.task!} expanded />);
  expect(screen.getByText(/1\/2 milestones completed/)).toBeTruthy();
  expect(screen.getByText(/Success condition: Saved label visible/)).toBeTruthy();
  expect(
    screen.getByText(/Model observed at step 1: Report text is visible/),
  ).toBeTruthy();
  expect(
    within(
      screen.getByRole('region', { name: 'Failed approaches' }),
    ).getAllByText(/Save dialog did not open/).length,
  ).toBeGreaterThan(0);
  expect(screen.getByText('— Blocked')).toBeTruthy();
});
