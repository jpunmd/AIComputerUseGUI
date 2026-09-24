import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { TaskPanel } from '../src/components/TaskPanel';
import { TaskMemory } from '../src/agent/memory';
afterEach(cleanup);

it('shows milestone state, success conditions, observed evidence and unresolved questions', () => {
  const memory = new TaskMemory();
  memory.start('Save report', true);
  memory.observe('screen-1');
  memory.setPlan('Open report\nSave report');
  memory.applyProgress({
    milestones: [
      { id: 'm1-1', status: 'completed', evidence: 'Report text is visible' },
      { id: 'm1-2', status: 'blocked', evidence: 'Destination is unknown' },
    ],
    notes: [
      { kind: 'question', text: 'Which folder should receive the report?' },
    ],
  });
  render(<TaskPanel task={memory.task!} expanded />);
  expect(screen.getByText(/1\/2 milestones completed/)).toBeTruthy();
  expect(screen.getByText(/Success condition: Save report/)).toBeTruthy();
  expect(
    screen.getByText(/Model observed at step 1: Report text is visible/),
  ).toBeTruthy();
  expect(
    within(screen.getByRole('region', { name: 'Open questions' })).getByText(
      'Which folder should receive the report?',
    ),
  ).toBeTruthy();
  expect(screen.getByText('— Blocked')).toBeTruthy();
});
