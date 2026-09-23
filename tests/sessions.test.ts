import { describe, expect, it } from 'vitest';
import { parseSessionImport, validateSession } from '../src/agent/sessions';
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
