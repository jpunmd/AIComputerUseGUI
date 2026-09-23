import { Message, TaskRecord } from '../types';

export interface PriorTurn {
  user_query: string;
  assistant_content: string;
  assistant_thinking?: string;
}
export const MAX_CONTEXT_CHARS = 24000;
export const MAX_RECENT_TURNS = 6;

// Keep a full audit log in the chat; this object is bounded model context.
export class TaskMemory {
  turns: PriorTurn[] = [];
  task: TaskRecord | null = null;
  private receipts: string[] = [];
  private omitted = 0;

  record(query: string, answer: string) {
    this.turns.push({ user_query: query, assistant_content: answer });
    while (
      this.turns.length > MAX_RECENT_TURNS ||
      this.turns.reduce(
        (n, t) => n + t.user_query.length + t.assistant_content.length,
        0,
      ) > MAX_CONTEXT_CHARS
    ) {
      this.turns.shift();
      this.omitted++;
    }
  }

  receipt(text: string) {
    this.receipts.push(text.slice(0, 800));
    this.receipts = this.receipts.slice(-10);
    if (this.task) this.task.summary = this.receipts.join('\n');
  }

  context(): PriorTurn[] {
    return this.turns.map((t) => ({ ...t }));
  }

  prompt(query: string): string {
    if (!this.task) return query;
    return `Original task (preserve its constraints):\n${this.task.goal}\n\nPlan:\n${this.task.plan.map((s, i) => `${i + 1}. ${s}`).join('\n') || 'Not yet recorded'}\n\nRecent execution receipts (OS submission is not proof of success):\n${this.task.summary || 'None'}\n${this.omitted ? `Older transcript turns omitted: ${this.omitted}. Ask if a required detail is missing; never invent it.\n` : ''}\nCurrent request:\n${query}`;
  }

  start(goal: string, planning: boolean) {
    this.task = {
      goal,
      plan: [],
      status: planning ? 'planning' : 'running',
      summary: '',
    };
    this.receipts = [];
  }

  restore(messages: Message[]) {
    this.turns = [];
    this.receipts = [];
    this.omitted = 0;
    const saved = messages
      .slice()
      .reverse()
      .find((m) => m.task)?.task;
    this.task = saved ? structuredClone(saved) : null;
    let query = '';
    for (const message of messages) {
      if (message.role === 'user') query = message.content;
      if (message.role === 'assistant' && query) {
        this.record(query, message.content);
        query = '';
      }
    }
    if (this.task) {
      this.task.status = 'stopped';
      // Executor authorization is never reconstructed from a saved session.
      this.receipts = this.task.summary.split('\n').slice(-10);
    }
  }
}

export function parsePlan(text: string): string[] {
  const plan = text
    .split('\n')
    .map((s) => s.replace(/^\s*(?:\d+[.)]|[-*])\s*/, '').trim())
    .filter(Boolean);
  if (plan.length < 1 || plan.length > 7 || plan.some((s) => s.length > 400))
    throw new Error('Plan must contain one to seven short steps');
  return plan;
}

export function actionSignature(action: unknown, screenshot: string): string {
  let hash = 2166136261;
  for (let i = 0; i < screenshot.length; i++)
    hash = Math.imul(hash ^ screenshot.charCodeAt(i), 16777619);
  return `${JSON.stringify(action)}:${hash >>> 0}`;
}
