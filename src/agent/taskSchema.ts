import {
  Evidence,
  ExecutionReceipt,
  MemoryNote,
  Milestone,
  TaskProgress,
  TaskRecord,
} from '../types';

export const MAX_NOTES = 16;
export const MAX_NOTE_CHARS = 8000;
export const MAX_RECEIPTS = 8;
const taskStatuses = [
  'planning',
  'running',
  'stopped',
  'completed',
  'needs_user',
];
const milestoneStatuses = ['pending', 'in_progress', 'completed', 'blocked'];
const kinds = ['fact', 'artifact', 'failure', 'question'];

export class TaskUpdateError extends Error {
  constructor(message: string) {
    super(`Invalid task progress: ${message}`);
  }
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TaskUpdateError('expected an object');
  return value as Record<string, unknown>;
}
export function text(value: unknown, max: number, empty = false): string {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    (!empty && !value.trim()) ||
    value.includes('\0')
  )
    throw new TaskUpdateError('missing or oversized text');
  return value;
}
function number(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 1000000
  )
    throw new TaskUpdateError('invalid step count');
  return value;
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max)
    throw new TaskUpdateError('invalid or oversized list');
  return value;
}
function oneOf<T extends string>(
  value: unknown,
  allowed: readonly string[],
): T {
  if (typeof value !== 'string' || !allowed.includes(value))
    throw new TaskUpdateError('invalid status or kind');
  return value as T;
}
function fields(data: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(data).some((key) => !allowed.includes(key)))
    throw new TaskUpdateError('unknown field');
}
function unique(ids: string[]) {
  if (new Set(ids).size !== ids.length)
    throw new TaskUpdateError('duplicate IDs');
}
export function parseProgress(value: unknown): TaskProgress {
  const data = object(value);
  fields(data, [
    'milestones',
    'outcome',
    'notes',
    'resolve_questions',
    'next_milestone_id',
    'expected_outcome',
  ]);
  const result: TaskProgress = {};
  if (data.milestones !== undefined) {
    result.milestones = list(data.milestones, 7).map((value) => {
      const row = object(value);
      fields(row, ['id', 'status', 'evidence']);
      return {
        id: text(row.id, 40),
        status: oneOf(row.status, milestoneStatuses.slice(1)),
        evidence: text(row.evidence, 500),
      };
    });
    unique(result.milestones.map((row) => row.id));
  }
  if (data.outcome !== undefined) {
    const row = object(data.outcome);
    fields(row, ['status', 'evidence']);
    result.outcome = {
      status: oneOf(row.status, ['succeeded', 'failed', 'uncertain']),
      evidence: text(row.evidence, 500),
    };
  }
  if (data.notes !== undefined) {
    result.notes = list(data.notes, 6).map((value) => {
      const row = object(value);
      fields(row, ['id', 'kind', 'text', 'evidence']);
      const kind = oneOf<MemoryNote['kind']>(row.kind, kinds);
      return {
        ...(row.id === undefined ? {} : { id: text(row.id, 40) }),
        kind,
        text: text(row.text, 400),
        ...(row.evidence === undefined && kind === 'question'
          ? {}
          : { evidence: text(row.evidence, 500) }),
      };
    });
    unique(result.notes.flatMap((row) => (row.id ? [row.id] : [])));
  }
  if (data.resolve_questions !== undefined) {
    result.resolve_questions = list(data.resolve_questions, 6).map((value) => {
      const row = object(value);
      fields(row, ['id', 'answer', 'evidence']);
      return {
        id: text(row.id, 40),
        answer: text(row.answer, 400),
        evidence: text(row.evidence, 500),
      };
    });
    unique(result.resolve_questions.map((row) => row.id));
  }
  if (data.next_milestone_id !== undefined)
    result.next_milestone_id = text(data.next_milestone_id, 40);
  if (data.expected_outcome !== undefined)
    result.expected_outcome = text(data.expected_outcome, 400);
  return result;
}

export interface PlanDraft {
  reason?: string;
  steps: { id?: string; title: string; success_criteria: string }[];
}
export function parsePlan(value: string): PlanDraft {
  text(value, 8192);
  if (value.trim().startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new TaskUpdateError('invalid plan JSON');
    }
    const data = object(parsed);
    fields(data, ['reason', 'steps']);
    const steps = list(data.steps, 7).map((value) => {
      const row = object(value);
      fields(row, ['id', 'title', 'success_criteria']);
      return {
        ...(row.id === undefined ? {} : { id: text(row.id, 40) }),
        title: text(row.title, 240),
        success_criteria: text(row.success_criteria, 400),
      };
    });
    if (!steps.length)
      throw new TaskUpdateError('plan needs one to seven milestones');
    unique(steps.flatMap((row) => (row.id ? [row.id] : [])));
    return {
      steps,
      ...(data.reason === undefined ? {} : { reason: text(data.reason, 500) }),
    };
  }
  // Backward compatible plan text becomes pending milestones, never completed work.
  const steps = value
    .split('\n')
    .map((s) => s.replace(/^\s*(?:\d+[.)]|[-*])\s*/, '').trim())
    .filter(Boolean);
  if (!steps.length || steps.length > 7)
    throw new TaskUpdateError('plan needs one to seven milestones');
  return {
    steps: steps.map((s) => ({ title: text(s, 240), success_criteria: s })),
  };
}

function evidence(value: unknown, maxStep: number): Evidence {
  const data = object(value);
  const step = number(data.step);
  if (step > maxStep)
    throw new TaskUpdateError('evidence refers to a future step');
  const result: Evidence = {
    text: text(data.text, 500),
    step,
    observationId: text(data.observationId, 100, true),
    source: oneOf(data.source, ['model_observation', 'controller', 'legacy']),
  };
  if (
    result.source === 'model_observation' &&
    (!result.observationId || result.step === 0)
  )
    throw new TaskUpdateError('observation evidence needs a source screen');
  return result;
}
export function emptyTask(goal: string, planning: boolean): TaskRecord {
  return {
    schemaVersion: 2,
    goal: text(goal, 8192),
    plan: [],
    status: planning ? 'planning' : 'running',
    summary: '',
    notes: [],
    receipts: [],
    planChanges: [],
    revision: 0,
    lastStep: 0,
    omittedNotes: 0,
  };
}

// Shared by imports and restores. Build known fields explicitly; never trust saved authorization.
export function restoreTask(value: unknown): TaskRecord {
  const data = object(value);
  oneOf(data.status, taskStatuses);
  const result = emptyTask(text(data.goal, 8192), false);
  result.status = 'stopped';
  if (data.schemaVersion === undefined) {
    result.plan = list(data.plan, 7).map((s, i) => ({
      id: `m1-${i + 1}`,
      title: text(s, 400),
      successCriteria: text(s, 400),
      status: 'pending',
      attempts: 0,
    }));
    const legacy = text(data.summary, 10000, true);
    result.revision = result.plan.length ? 1 : 0;
    if (legacy)
      result.notes = [
        {
          id: 'legacy',
          kind: 'question',
          text: 'Older checkpoint contains unverified input history; recheck the current screen.',
          evidence: {
            text: legacy.slice(0, 500),
            step: 0,
            observationId: '',
            source: 'legacy',
          },
        },
      ];
    return result;
  }
  if (data.schemaVersion !== 2)
    throw new TaskUpdateError('unsupported checkpoint version');
  result.lastStep = number(data.lastStep);
  result.revision = number(data.revision);
  result.omittedNotes = number(data.omittedNotes);
  result.plan = list(data.plan, 7).map((value) => {
    const row = object(value);
    const item: Milestone = {
      id: text(row.id, 40),
      title: text(row.title, 400),
      successCriteria: text(row.successCriteria, 400),
      status: oneOf(row.status, milestoneStatuses),
      attempts: number(row.attempts),
    };
    if (row.evidence !== undefined)
      item.evidence = evidence(row.evidence, result.lastStep);
    if (
      item.status === 'completed' &&
      (!item.evidence || item.evidence.source !== 'model_observation')
    )
      throw new TaskUpdateError('completed milestone lacks observed evidence');
    return item;
  });
  unique(result.plan.map((s) => s.id));
  if (result.plan.filter((s) => s.status === 'in_progress').length > 1)
    throw new TaskUpdateError('multiple current milestones in checkpoint');
  result.notes = list(data.notes, MAX_NOTES).map((value) => {
    const row = object(value);
    return {
      id: text(row.id, 40),
      kind: oneOf(row.kind, kinds),
      text: text(row.text, 400),
      evidence: evidence(row.evidence, result.lastStep),
    };
  });
  unique(result.notes.map((n) => n.id));
  if (
    result.notes.reduce(
      (sum, n) => sum + n.text.length + n.evidence.text.length,
      0,
    ) > MAX_NOTE_CHARS
  )
    throw new TaskUpdateError('saved memory exceeds budget');
  result.receipts = list(data.receipts, MAX_RECEIPTS).map((value) => {
    const row = object(value);
    const item: ExecutionReceipt = {
      step: number(row.step),
      observationId: text(row.observationId, 100),
      action: text(row.action, 600),
      expected: text(row.expected, 400),
      outcome: oneOf(row.outcome, [
        'unverified',
        'succeeded',
        'failed',
        'uncertain',
      ]),
    };
    if (item.step > result.lastStep)
      throw new TaskUpdateError('invalid receipt step');
    if (row.milestoneId !== undefined)
      item.milestoneId = text(row.milestoneId, 40);
    if (row.evidence !== undefined)
      item.evidence = evidence(row.evidence, result.lastStep);
    if (item.outcome !== 'unverified' && !item.evidence)
      throw new TaskUpdateError('receipt result lacks evidence');
    if (
      item.evidence &&
      (item.evidence.step <= item.step ||
        item.evidence.observationId === item.observationId ||
        item.evidence.source !== 'model_observation')
    )
      throw new TaskUpdateError(
        'receipt evidence must follow input on a fresh screen',
      );
    return item;
  });
  if (
    result.receipts.some(
      (r, i) => i > 0 && r.step <= result.receipts[i - 1].step,
    )
  )
    throw new TaskUpdateError('receipt steps must be ordered and unique');
  result.planChanges = list(data.planChanges, 5).map((value) => {
    const row = object(value);
    const item = {
      revision: number(row.revision),
      reason: text(row.reason, 500),
      step: number(row.step),
    };
    if (item.step > result.lastStep || item.revision > result.revision)
      throw new TaskUpdateError('invalid plan revision history');
    return item;
  });
  // summary is a derived view, not another model-authored source of facts.
  return result;
}
