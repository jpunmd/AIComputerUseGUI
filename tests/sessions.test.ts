import { describe, expect, it } from 'vitest';
import { parseSessionImport, validateSession } from '../src/agent/sessions';
import { TaskMemory } from '../src/agent/memory';
const session = {
  id: 'old',
  name: 'Test',
  createdAt: '2026-09-23T00:00:00Z',
  updatedAt: '2026-09-23T00:00:00Z',
  messages: [
    {
      id: 'm',
      role: 'system',
      content: 'Checkpoint',
      timestamp: '2026-09-23T00:00:00Z',
      task: {
        goal: 'Open a file',
        plan: ['Open editor'],
        status: 'running',
        summary: 'Input submitted',
      },
      approved: true,
    },
  ],
};
describe('saved sessions', () => {
  it('preserves bounded rejected output as diagnostic text without action permissions', () => {
    const saved = {
      ...session,
      messages: [
        {
          ...session.messages[0],
          modelResponse: '<tool_call>invalid</tool_call>',
          approved: true,
        },
      ],
    };
    const restored = validateSession(saved).messages[0];
    expect(restored.modelResponse).toBe('<tool_call>invalid</tool_call>');
    expect(restored).not.toHaveProperty('approved');
    saved.messages[0].modelResponse = 'x'.repeat(33001);
    expect(() => validateSession(saved)).toThrow();
  });
  it('round-trips versioned progress, facts and receipts while discarding unknown authorization', () => {
    const memory = new TaskMemory();
    memory.start('Open report', true);
    memory.observe('screen-1');
    memory.setPlan('Open report');
    memory.applyProgress({
      milestones: [
        { id: 'm1-1', status: 'completed', evidence: 'Editor visible' },
      ],
      notes: [
        { kind: 'artifact', text: 'report.txt', evidence: 'Editor title' },
      ],
    });
    const saved = {
      ...session,
      messages: [
        {
          ...session.messages[0],
          task: { ...memory.task!, approved: true },
        },
      ],
    };
    const restored = validateSession(saved).messages[0].task!;
    expect(restored.plan[0].status).toBe('completed');
    expect(restored.notes[0].text).toBe('report.txt');
    expect(restored.status).toBe('stopped');
    expect(restored).not.toHaveProperty('approved');
    const invalid = structuredClone(saved);
    invalid.messages[0].task.plan[0].evidence = undefined;
    expect(() => validateSession(invalid)).toThrow('lacks observed evidence');
  });
  it('imports a stopped checkpoint with new identity and no authorization fields', () => {
    const [result] = parseSessionImport(JSON.stringify([session]));
    expect(result.id).not.toBe('old');
    expect(result.messages[0].task?.status).toBe('stopped');
    expect(result.messages[0]).not.toHaveProperty('approved');
  });
  it('rejects malformed task data, dates, roles, and oversized imports', () => {
    expect(() =>
      validateSession({ ...session, createdAt: 'invalid' }),
    ).toThrow();
    expect(() =>
      validateSession({
        ...session,
        messages: [{ ...session.messages[0], role: 'developer' }],
      }),
    ).toThrow();
    expect(() =>
      validateSession({
        ...session,
        messages: [
          {
            ...session.messages[0],
            task: { ...session.messages[0].task, plan: 'execute' },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      parseSessionImport(JSON.stringify(Array(101).fill(session))),
    ).toThrow();
  });
});
