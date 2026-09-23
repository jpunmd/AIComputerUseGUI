import { expect, it } from 'vitest';
import {
  TaskMemory,
  MAX_CONTEXT_CHARS,
  MAX_RECENT_TURNS,
  parsePlan,
} from '../src/agent/memory';
import { sanitizeSettings } from '../src/hooks/useSettings';

it('bounds context while preserving the exact original goal and plan', () => {
  const memory = new TaskMemory();
  memory.start('Save report to C:\\Reports; do not send it.', true);
  memory.task!.plan = ['Open report', 'Save report'];
  for (let n = 0; n < 100; n++) {
    memory.record('user' + n + 'x'.repeat(3000), 'answer' + n);
    memory.receipt('Input submitted ' + n);
  }
  expect(memory.context().length).toBeLessThanOrEqual(MAX_RECENT_TURNS);
  expect(
    memory
      .context()
      .reduce(
        (n, t) => n + t.user_query.length + t.assistant_content.length,
        0,
      ),
  ).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
  expect(memory.prompt('Continue')).toContain(
    'Save report to C:\\Reports; do not send it.',
  );
  expect(memory.prompt('Continue')).toContain('Save report');
  expect(memory.task!.summary.split('\n')).toHaveLength(10);
});
it('rejects oversized plans and removes legacy approval settings', () => {
  expect(() => parsePlan(Array(8).fill('step').join('\n'))).toThrow();
  const settings = sanitizeSettings({
    autoApproveConfirmations: true,
    maxTurns: 999,
    actionDelayMs: -1,
    enablePlanning: 'yes',
  });
  expect(settings).not.toHaveProperty('autoApproveConfirmations');
  expect(settings.maxTurns).toBe(100);
  expect(settings.actionDelayMs).toBe(0);
  expect(settings.enablePlanning).toBe(true);
});
