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
  memory.setPlan([
    'Open report -> Report text visible in editor',
    'Save report -> Saved indicator and correct path visible',
  ]);
  return memory;
}
function completeFirst(memory: TaskMemory) {
  memory.applyProgress({
    milestones: [
      {
        id: memory.task!.plan[0].id,
        status: 'completed',
        evidence: 'Editor visible',
      },
    ],
  });
}

describe('flat plans', () => {
  it('splits each step into a title and success condition', () => {
    expect(
      parsePlan(['Open Chrome -> window visible', 'Search → results shown']).steps,
    ).toEqual([
      { title: 'Open Chrome', successCriteria: 'window visible' },
      { title: 'Search', successCriteria: 'results shown' },
    ]);
    // A plain step doubles as its own success condition.
    expect(parsePlan(['Open Chrome']).steps[0]).toEqual({
      title: 'Open Chrome',
      successCriteria: 'Open Chrome',
    });
    // A numbered list written as text is tolerated.
    expect(
      parsePlan('1. Open Chrome -> window visible\n2) Search').steps,
    ).toHaveLength(2);
    expect(parsePlan(['x'], 'Retry').reason).toBe('Retry');
  });

  it('rejects empty, oversized and structured plans', () => {
    for (const bad of [
      [],
      '',
      Array(8).fill('step'),
      Array(8).fill('step').join('\n'),
      ['-> only a condition'],
      [{ title: 'Open Chrome', success_criteria: 'visible' }],
      undefined,
    ])
      expect(() => parsePlan(bad)).toThrow();
  });
});

describe('task progress and durable memory', () => {
  it('bounds the complete task prompt without truncating the original goal or current request', () => {
    const memory = new TaskMemory(),
      goal = '原'.repeat(8192),
      request = '請'.repeat(8192);
    memory.start(goal, true);
    memory.observe('screen-1');
    memory.setPlan(
      Array.from(
        { length: 7 },
        (_, i) => 'Step ' + i + 'x'.repeat(190) + ' -> ' + 'y'.repeat(190),
      ),
    );
    for (let i = 2; i < 20; i++)
      memory.interrupted('Failure ' + i + 'p'.repeat(390));
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
    expect(memory.prompt('Continue')).toContain('Recent problems');
    memory.setPlan(
      ['Open report through the File menu -> Report text visible'],
      'Try a different menu',
    );
    expect(memory.recoveryReason()).toBeNull();
  });

  it('preserves the goal and recent problems after transcript turns are compacted', () => {
    const memory = setup();
    memory.interrupted('Save dialog closed unexpectedly');
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
    const prompt = memory.prompt('Continue');
    expect(prompt).toContain('Save report to C:\\Reports; do not send it.');
    expect(prompt).toContain('Save dialog closed unexpectedly');
    expect(prompt).toContain('Older transcript turns omitted');
  });

  it('does not turn submitted input into milestone completion without fresh evidence', () => {
    const memory = setup(),
      id = memory.task!.plan[0].id;
    memory.submitted(input, memory.actionContext(input));
    expect(memory.task!.plan[0].status).toBe('in_progress');
    expect(memory.task!.receipts[0].outcome).toBe('unverified');
    // Input cannot be judged on the screenshot it ran on.
    expect(() => memory.applyProgress({ outcome: observed })).toThrow(
      'awaiting review',
    );
    expect(memory.task!.receipts[0].outcome).toBe('unverified');
    expect(() => memory.actionContext(input)).toThrow('not been reviewed');
    memory.observe('screen-2');
    expect(() =>
      memory.applyProgress({
        milestones: [{ id, status: 'completed', evidence: 'Editor visible' }],
      }),
    ).toThrow('did not work');
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

  it('derives outcomes and step completion from the flat report', () => {
    const memory = setup(),
      second = memory.task!.plan[1];
    // Nothing to review before the first input; the report cannot claim an outcome.
    expect(memory.progressFromReport({ last_action: 'worked' })).toEqual({});
    expect(memory.prompt('Continue')).toContain('omit last_action');
    memory.submitted(input, memory.actionContext(input));
    memory.observe('screen-2');
    expect(memory.prompt('Continue')).toContain(
      'Set last_action from THIS screenshot',
    );
    // Omitted last_action never blocks the next action: it becomes uncertain.
    const unclear = memory.progressFromReport(undefined);
    expect(unclear.outcome?.status).toBe('uncertain');
    memory.applyProgress(unclear);
    expect(() => memory.actionContext(input)).not.toThrow();
    // A later step_done settles the earlier unclear review and completes the step.
    memory.observe('screen-3');
    const done = memory.progressFromReport({
      screen: 'Report text visible',
      step_done: true,
    });
    expect(done.outcome?.status).toBe('succeeded');
    memory.applyProgress(done);
    expect(memory.task!.plan[0].status).toBe('completed');
    expect(memory.task!.plan[0].evidence?.text).toBe('Report text visible');
    // A failed action never completes a step, even if step_done is set.
    memory.submitted(input, memory.actionContext(input));
    memory.observe('screen-4');
    const failed = memory.progressFromReport({
      last_action: 'failed',
      step_done: true,
    });
    expect(failed).toMatchObject({ outcome: { status: 'failed' } });
    expect(failed.milestones).toBeUndefined();
    memory.applyProgress(failed);
    // done completes every unfinished step with the done evidence.
    memory.observe('screen-5');
    const finish = memory.progressFromReport({}, 'Saved label visible');
    expect(finish.milestones).toEqual([
      { id: second.id, status: 'completed', evidence: 'Saved label visible' },
    ]);
    memory.applyProgress(finish);
    expect(memory.canComplete()).toBe(true);
    expect(memory.prompt('Continue')).toContain('1. done: Open report');
  });

  it('applies progress atomically and rejects unknown milestone IDs', () => {
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
  });

  it('keeps finished steps automatically when the model replans only the remaining work', () => {
    const memory = setup(),
      first = memory.task!.plan[0];
    completeFirst(memory);
    memory.setPlan(
      ['Use File > Save As -> Save dialog confirms the original destination'],
      'Save shortcut failed; use the File menu instead',
    );
    expect(memory.task!.plan).toHaveLength(2);
    expect(memory.task!.plan[0]).toMatchObject({
      id: first.id,
      title: first.title,
      status: 'completed',
    });
    expect(memory.task!.plan[1]).toMatchObject({
      id: 'm2-1',
      title: 'Use File > Save As',
      status: 'pending',
    });
    expect(memory.task!.revision).toBe(2);
    expect(memory.task!.goal).toBe(
      'Save report to C:\\Reports; do not send it.',
    );
    expect(memory.task!.planChanges[1].reason).toContain('shortcut failed');
    // Repeating a finished step is harmless, and a missing reason is tolerated.
    memory.setPlan(['Open report -> Report visible', 'Save a copy -> Copy saved']);
    expect(memory.task!.plan.map((s) => [s.id, s.status])).toEqual([
      [first.id, 'completed'],
      ['m3-1', 'pending'],
    ]);
    expect(memory.task!.planChanges[2].reason).toBe('Plan revised');
    expect(() => memory.setPlan(['Open report'], 'Nothing new')).toThrow(
      'not finished yet',
    );
    expect(() =>
      memory.setPlan(
        Array.from({ length: 7 }, (_, i) => 'New step ' + i),
        'Too long',
      ),
    ).toThrow('at most 6 remaining steps');
    expect(memory.task!.revision).toBe(3);
  });

  it('bounds retained failures and records controller blocks', () => {
    const memory = setup();
    for (let i = 2; i < 70; i++) {
      memory.observe('screen-' + i);
      memory.interrupted('Observed failure ' + i + 'x'.repeat(390));
    }
    expect(memory.task!.notes.length).toBeLessThanOrEqual(MAX_NOTES);
    expect(
      memory.task!.notes.reduce(
        (n, row) => n + row.text.length + row.evidence.text.length,
        0,
      ),
    ).toBeLessThanOrEqual(MAX_NOTE_CHARS);
    expect(memory.task!.omittedNotes).toBeGreaterThan(0);
    memory.submitted(input, memory.actionContext(input));
    memory.blocked('Save dialog did not open');
    expect(memory.task!.plan[0].status).toBe('blocked');
    expect(memory.task!.summary).toContain('Save dialog did not open');
    expect(
      memory.task!.notes.find((n) => n.kind === 'failure')!.evidence.source,
    ).toBe('controller');
  });

  it('restores evidence and IDs but requires a new observation before any progress update', () => {
    const memory = setup();
    memory.interrupted('Window switched');
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
    completeFirst(restored);
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

  it('old checkpoint questions cannot block completion, since nothing can answer them', () => {
    const memory = setup();
    memory.task!.notes.push({
      id: 'q1',
      kind: 'question',
      text: 'Which folder?',
      evidence: { text: 'x', step: 0, observationId: '', source: 'legacy' },
    });
    memory.applyProgress(memory.progressFromReport({}, 'Saved label visible'));
    expect(memory.canComplete()).toBe(true);
  });

  it('a new task clears old milestones and memory, and varying reports cannot evade repetition detection', () => {
    const memory = setup();
    memory.interrupted('old failure');
    memory.start('Different goal', true);
    expect(memory.task!.notes).toEqual([]);
    expect(memory.task!.plan).toEqual([]);
    expect(memory.task!.receipts).toEqual([]);
    expect(actionSignature(input, 'screen')).toBe(
      actionSignature(
        { ...input, report: { screen: 'Different wording' } },
        'screen',
      ),
    );
  });

  it('removes legacy approval and tool-format settings', () => {
    const settings = sanitizeSettings({
      autoApproveConfirmations: true,
      simpleToolFormat: false,
      maxTurns: 999,
      actionDelayMs: -1,
      enablePlanning: 'yes',
    });
    expect(settings).not.toHaveProperty('autoApproveConfirmations');
    expect(settings).not.toHaveProperty('simpleToolFormat');
    expect(settings.maxTurns).toBe(100);
    expect(settings.actionDelayMs).toBe(0);
    expect(settings.enablePlanning).toBe(true);
  });
});
