import { describe, expect, it } from 'vitest';
import {
  TaskMemory,
  MAX_CONTEXT_CHARS,
  MAX_RECENT_TURNS,
  MAX_PROMPT_CHARS,
  parsePlan,
  actionSignature,
} from '../src/agent/memory';
import {
  restoreTask,
  MAX_NOTES,
  MAX_NOTE_CHARS,
} from '../src/agent/taskSchema';
import { sanitizeSettings } from '../src/hooks/useSettings';
import { ActionResult, Message } from '../src/types';

const input: ActionResult = { action: 'key', arguments: { key: 'ctrl+s' } };
const observed = {
  status: 'succeeded' as const,
  evidence: 'Saved indicator is visible beside report.txt',
};
function setup() {
  const memory = new TaskMemory();
  memory.start('Save report to C:\\Reports; do not send it.', true);
  memory.observe('screen-1');
  memory.setPlan(
    JSON.stringify({
      steps: [
        {
          title: 'Open report',
          success_criteria: 'Report text visible in editor',
        },
        {
          title: 'Save report',
          success_criteria: 'Saved indicator and correct path visible',
        },
      ],
    }),
  );
  return memory;
}

describe('task progress and durable memory', () => {
  it('bounds the complete task prompt without truncating the original goal or current request', () => {
    const memory = new TaskMemory(),
      goal = '原'.repeat(8192),
      request = '請'.repeat(8192);
    memory.start(goal, true);
    memory.observe('screen-1');
    memory.setPlan(
      JSON.stringify({
        steps: Array.from({ length: 7 }, (_, i) => ({
          title: 'Step ' + i + 'x'.repeat(200),
          success_criteria: 'y'.repeat(400),
        })),
      }),
    );
    for (let i = 2; i < 20; i++) {
      memory.observe('screen-' + i);
      memory.applyProgress({
        notes: [
          {
            kind: 'artifact',
            text: 'p'.repeat(390) + i,
            evidence: 'e'.repeat(490),
          },
        ],
      });
    }
    const prompt = memory.prompt(request);
    expect(prompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
    expect(prompt).toContain(goal);
    expect(prompt).toContain(request);
    expect(new TextEncoder().encode(prompt).length).toBeLessThan(131072);
  });

  it('requests a new approach after two observed failures even when actions or screenshots differ', () => {
    const memory = setup();
    for (let i = 0; i < 2; i++) {
      memory.submitted(input, memory.actionContext(input));
      memory.observe('changed-screen-' + i);
      memory.applyProgress({
        outcome: {
          status: 'failed',
          evidence:
            'Expected report did not appear; a different dialog appeared',
        },
      });
    }
    expect(memory.recoveryReason()).toContain('Two recent actions failed');
    memory.setPlan(
      JSON.stringify({
        reason: 'Try a different menu',
        steps: memory.task!.plan.map((s) => ({
          id: s.id,
          title: s.title,
          success_criteria: s.successCriteria,
        })),
      }),
    );
    expect(memory.recoveryReason()).toBeNull();
  });
  it('preserves paths, evidence and constraints after recent transcript turns are compacted', () => {
    const memory = setup();
    memory.applyProgress({
      notes: [
        {
          kind: 'artifact',
          text: 'C:\\Reports\\final.txt',
          evidence: 'Save dialog destination shows this exact path',
        },
      ],
    });
    for (let n = 0; n < 100; n++)
      memory.record('user' + n + 'x'.repeat(3000), 'answer' + n);
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
    expect(memory.prompt('Continue')).toContain('C:\\Reports\\final.txt');
    expect(memory.task!.notes[0].evidence).toMatchObject({
      step: 1,
      observationId: 'screen-1',
      source: 'model_observation',
    });
    expect(memory.prompt('Continue')).toContain(
      'Older transcript turns omitted',
    );
  });

  it('does not turn submitted input into milestone completion without fresh evidence', () => {
    const memory = setup(),
      id = memory.task!.plan[0].id;
    memory.submitted(input, memory.actionContext(input));
    expect(memory.task!.plan[0].status).toBe('in_progress');
    expect(memory.task!.receipts[0].outcome).toBe('unverified');
    expect(() => memory.applyProgress({ outcome: observed })).toThrow(
      'fresh observation',
    );
    expect(() => memory.actionContext(input)).toThrow(
      'review the previous input',
    );
    memory.observe('screen-2');
    expect(() =>
      memory.applyProgress({
        milestones: [{ id, status: 'completed', evidence: 'Editor visible' }],
      }),
    ).toThrow('review the last input');
    memory.applyProgress({
      outcome: observed,
      milestones: [
        {
          id,
          status: 'completed',
          evidence: 'Report text is visible in editor',
        },
      ],
    });
    expect(memory.task!.plan[0]).toMatchObject({
      status: 'completed',
      attempts: 1,
    });
    expect(memory.canComplete()).toBe(false); // Save milestone remains pending.
    expect(memory.actionContext(input).milestoneId).toBe(
      memory.task!.plan[1].id,
    );
  });

  it('requires all milestones and open questions to be resolved', () => {
    const memory = setup();
    memory.applyProgress({
      milestones: memory.task!.plan.map((s) => ({
        id: s.id,
        status: 'completed',
        evidence: 'Target state visible',
      })),
      notes: [
        { kind: 'question', text: 'Which final filename does the user want?' },
      ],
    });
    expect(memory.canComplete()).toBe(false);
    const question = memory.task!.notes[0].id;
    memory.observe('screen-2');
    memory.applyProgress({
      resolve_questions: [
        {
          id: question,
          answer: 'The final filename is final.txt',
          evidence: 'The Save dialog shows the selected filename final.txt',
        },
      ],
      notes: [
        {
          kind: 'artifact',
          text: 'final.txt',
          evidence: 'User-selected filename visible in Save dialog',
        },
      ],
    });
    expect(memory.canComplete()).toBe(true);
    expect(memory.task!.summary).toContain('The final filename is final.txt');
  });

  it('never evicts an unanswered question merely to make room for new notes', () => {
    const memory = setup();
    for (let i = 1; i <= 16; i++) {
      memory.observe('question-screen-' + i);
      memory.applyProgress({
        notes: [{ kind: 'question', text: 'Open question ' + i }],
      });
    }
    memory.observe('overflow-screen');
    expect(() =>
      memory.applyProgress({
        notes: [{ kind: 'question', text: 'Question 17' }],
      }),
    ).toThrow('unresolved questions');
    expect(memory.task!.notes).toHaveLength(16);
    expect(memory.task!.notes.some((n) => n.text === 'Open question 1')).toBe(
      true,
    );
    expect(memory.canComplete()).toBe(false);
  });

  it('applies progress atomically and rejects invented IDs, approval fields and unsupported facts', () => {
    const memory = setup(),
      before = structuredClone(memory.task);
    expect(() =>
      memory.applyProgress({
        milestones: [
          {
            id: memory.task!.plan[0].id,
            status: 'completed',
            evidence: 'Editor visible',
          },
          { id: 'invented', status: 'completed', evidence: 'Trust me' },
        ],
      }),
    ).toThrow('unknown milestone');
    expect(memory.task).toEqual(before);
    expect(() =>
      memory.applyProgress({
        notes: [{ kind: 'fact', text: 'File was saved' }],
      }),
    ).toThrow();
    expect(() => memory.applyProgress({ approved: true })).toThrow(
      'unknown field',
    );
    expect(() =>
      memory.applyProgress({
        milestones: [
          { id: memory.task!.plan[0].id, status: 'completed', evidence: '' },
        ],
      }),
    ).toThrow();
  });

  it('preserves completed work and requires a reason when revising a plan', () => {
    const memory = setup(),
      [first, second] = memory.task!.plan;
    memory.applyProgress({
      milestones: [
        { id: first.id, status: 'completed', evidence: 'Editor visible' },
      ],
    });
    expect(() => memory.setPlan('Start everything again')).toThrow('reason');
    expect(() =>
      memory.setPlan(
        JSON.stringify({
          reason: 'Retry',
          steps: [{ title: 'Save differently', success_criteria: 'Saved' }],
        }),
      ),
    ).toThrow('cannot drop completed');
    memory.setPlan(
      JSON.stringify({
        reason: 'Save shortcut failed; use the File menu instead',
        steps: [
          {
            id: first.id,
            title: first.title,
            success_criteria: first.successCriteria,
          },
          {
            id: second.id,
            title: 'Use File > Save As',
            success_criteria: 'Save dialog confirms the original destination',
          },
        ],
      }),
    );
    expect(memory.task!.plan[0]).toMatchObject({
      id: first.id,
      status: 'completed',
    });
    expect(memory.task!.plan[1]).toMatchObject({
      id: second.id,
      status: 'pending',
    });
    expect(memory.task!.revision).toBe(2);
    expect(memory.task!.goal).toBe(
      'Save report to C:\\Reports; do not send it.',
    );
    expect(memory.task!.planChanges[1].reason).toContain('shortcut failed');
  });

  it('retains failed approaches and prioritizes file paths within a bounded summary', () => {
    const memory = setup();
    memory.applyProgress({
      notes: [
        {
          kind: 'artifact',
          text: 'C:\\Reports\\final.txt',
          evidence: 'Destination visible',
        },
      ],
    });
    for (let i = 2; i < 70; i++) {
      memory.observe('screen-' + i);
      memory.applyProgress({
        notes: [
          {
            kind: 'fact',
            text: 'Observed fact ' + i + 'x'.repeat(200),
            evidence: 'Visible value ' + i + 'y'.repeat(200),
          },
        ],
      });
    }
    expect(memory.task!.notes.length).toBeLessThanOrEqual(MAX_NOTES);
    expect(
      memory.task!.notes.reduce(
        (n, row) => n + row.text.length + row.evidence.text.length,
        0,
      ),
    ).toBeLessThanOrEqual(MAX_NOTE_CHARS);
    expect(
      memory.task!.notes.some((n) => n.text === 'C:\\Reports\\final.txt'),
    ).toBe(true);
    expect(memory.task!.omittedNotes).toBeGreaterThan(0);
    memory.blocked('Save dialog did not open', memory.task!.plan[1].id);
    expect(memory.task!.plan[1].status).toBe('blocked');
    expect(memory.task!.summary).toContain('Save dialog did not open');
    expect(
      memory.task!.notes.find((n) => n.kind === 'failure')!.evidence.source,
    ).toBe('controller');
  });

  it('updates a known note without inventing a new source or authorizing actions', () => {
    const memory = setup();
    memory.applyProgress({
      notes: [
        {
          kind: 'artifact',
          text: 'draft.txt',
          evidence: 'Editor title draft.txt',
        },
      ],
    });
    const id = memory.task!.notes[0].id;
    memory.observe('screen-2');
    memory.applyProgress({
      notes: [
        {
          id,
          kind: 'artifact',
          text: 'final.txt',
          evidence: 'Editor title now final.txt',
        },
      ],
    });
    expect(memory.task!.notes).toHaveLength(1);
    expect(memory.task!.notes[0]).toMatchObject({
      id,
      text: 'final.txt',
      evidence: { step: 2 },
    });
    expect(() =>
      memory.applyProgress({
        notes: [{ id: 'fake', kind: 'artifact', text: 'x', evidence: 'x' }],
      }),
    ).toThrow();
  });

  it('restores evidence and IDs but requires a new observation before any progress update', () => {
    const memory = setup();
    memory.applyProgress({
      notes: [{ kind: 'fact', text: 'Editor open', evidence: 'Title visible' }],
    });
    const checkpoint: Message = {
      id: 'm',
      role: 'system',
      content: 'Checkpoint',
      timestamp: new Date(),
      task: structuredClone(memory.task!),
    };
    const restored = new TaskMemory();
    restored.restore([checkpoint]);
    expect(restored.task!.status).toBe('stopped');
    expect(restored.task!.plan[0].id).toBe(memory.task!.plan[0].id);
    expect(restored.task!.notes).toEqual(memory.task!.notes);
    expect(() => restored.applyProgress({})).toThrow('no task observation');
    restored.observe('new-screen');
    restored.applyProgress({
      milestones: [
        {
          id: restored.task!.plan[0].id,
          status: 'completed',
          evidence: 'Editor still visible',
        },
      ],
    });
    expect(restored.task!.plan[0].evidence!.step).toBe(2);
  });

  it('migrates legacy plans without treating their summary as verified success', () => {
    const restored = restoreTask({
      goal: 'Save report',
      plan: ['Save report'],
      status: 'completed',
      summary: 'Input submitted: ctrl+s',
    });
    expect(restored.schemaVersion).toBe(2);
    expect(restored.status).toBe('stopped');
    expect(restored.plan[0].status).toBe('pending');
    expect(restored.notes[0]).toMatchObject({
      kind: 'question',
      evidence: { source: 'legacy' },
    });
  });

  it('a new task clears old milestones and memory, and varying metadata cannot evade repetition detection', () => {
    const memory = setup();
    memory.applyProgress({
      notes: [{ kind: 'artifact', text: 'old.txt', evidence: 'Title visible' }],
    });
    memory.start('Different goal', true);
    expect(memory.task!.notes).toEqual([]);
    expect(memory.task!.plan).toEqual([]);
    expect(memory.task!.receipts).toEqual([]);
    expect(actionSignature(input, 'screen')).toBe(
      actionSignature(
        { ...input, progress: { expected_outcome: 'Different wording' } },
        'screen',
      ),
    );
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
});
