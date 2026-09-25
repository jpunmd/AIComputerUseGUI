import { Evidence, TaskRecord } from '../types';

const labels = {
  pending: 'Pending',
  in_progress: 'In progress',
  completed: 'Completed',
  blocked: 'Blocked',
};
function EvidenceLine({ evidence }: { evidence?: Evidence }) {
  if (!evidence) return null;
  const source =
    evidence.source === 'model_observation'
      ? 'Model observed'
      : evidence.source === 'controller'
        ? 'Controller reported'
        : 'Older history';
  return (
    <p className="text-xs text-ink-400 mt-1 break-words">
      {source} at step {evidence.step}: {evidence.text}
    </p>
  );
}

export function TaskPanel({
  task,
  expanded = false,
}: {
  task: TaskRecord;
  expanded?: boolean;
}) {
  const completed = task.plan.filter((s) => s.status === 'completed').length;
  const groups = [
    ['fact', 'Observed facts'],
    ['artifact', 'Files and values'],
    ['failure', 'Failed approaches'],
    ['question', 'Open questions'],
  ] as const;
  return (
    <details
      className="text-sm text-ink-300"
      open={expanded || task.status === 'planning'}
    >
      <summary className="cursor-pointer">
        Task: {task.status.replace('_', ' ')} · {completed}/{task.plan.length}{' '}
        milestones completed — {task.goal.slice(0, 100)}
      </summary>
      <div
        className="max-h-72 overflow-y-auto pr-3 mt-3 space-y-4"
        aria-label="Task plan and memory"
      >
        <p className="text-xs text-ink-400">
          Completion evidence is the model’s interpretation of a screen. Saved
          evidence is rechecked when continuing.
        </p>
        <ol className="space-y-3">
          {task.plan.map((step, index) => (
            <li key={step.id} className="border-l-2 border-ink-600 pl-3">
              <p className="font-medium text-ink-200">
                {index + 1}. {step.title}{' '}
                <span
                  className={
                    step.status === 'blocked'
                      ? 'text-warning'
                      : step.status === 'completed'
                        ? 'text-success'
                        : 'text-primary-300'
                  }
                >
                  — {labels[step.status]}
                </span>
              </p>
              <p className="text-xs mt-1">
                Success condition: {step.successCriteria}
              </p>
              <EvidenceLine evidence={step.evidence} />
              {step.attempts > 0 && (
                <p className="text-xs text-ink-500">
                  {step.attempts} input action{step.attempts === 1 ? '' : 's'}{' '}
                  submitted
                </p>
              )}
            </li>
          ))}
        </ol>
        {task.planChanges.length > 1 && (
          <div>
            <h3 className="font-medium">Latest plan revision</h3>
            <p className="text-xs mt-1">
              {task.planChanges[task.planChanges.length - 1].reason}
            </p>
          </div>
        )}
        {groups.map(([kind, title]) => {
          const notes = task.notes.filter((n) => n.kind === kind);
          return (
            notes.length > 0 && (
              <section key={kind} aria-label={title}>
                <h3 className="font-medium text-ink-200">{title}</h3>
                <ul className="space-y-2 mt-1">
                  {notes.map((note) => (
                    <li key={note.id} className="break-words">
                      <p>{note.text}</p>
                      <EvidenceLine evidence={note.evidence} />
                    </li>
                  ))}
                </ul>
              </section>
            )
          );
        })}
        {task.receipts.length > 0 && (
          <section aria-label="Recent input results">
            <h3 className="font-medium text-ink-200">Recent input results</h3>
            <ul className="space-y-2 mt-1">
              {task.receipts.slice(-3).map((r) => (
                <li key={r.step}>
                  <p className="text-xs">
                    Step {r.step}:{' '}
                    {r.outcome === 'unverified'
                      ? 'Awaiting observation'
                      : r.outcome}{' '}
                    — expected {r.expected}
                  </p>
                  <EvidenceLine evidence={r.evidence} />
                </li>
              ))}
            </ul>
          </section>
        )}
        {task.omittedNotes > 0 && (
          <p className="text-xs text-warning">
            {task.omittedNotes} older memory entries were omitted to keep
            context bounded. The conversation retains the full history.
          </p>
        )}
      </div>
    </details>
  );
}
