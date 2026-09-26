# Task progress and memory

Planning uses the same local vision model as execution. No additional model or separate summarization request is needed. The model reports on the current screen alongside its proposed next input, using a few flat fields. The controller keeps all task bookkeeping (milestone IDs, statuses, input receipts, outcomes, failure memory), so the model never has to write nested structures or remember IDs.

The controller supplies the current tool schema on every request, including when saved settings contain an older tool definition. A rejected wire response keeps its specific schema error and a bounded final-output excerpt for up to two repair attempts. The excerpt appears under **View rejected model response** and is included in session exports as diagnostic text; it is never an executable action. Reasoning is not included in that excerpt.

## Plans

A `plan` action lists one to seven short steps. Each step is one string: what to do, an arrow, and what will be visible when it worked.

```json
{"name":"computer","arguments":{"action":"plan","steps":["Open the report -> Report text is visible in the editor","Save the report -> The requested destination and saved state are visible"]}}
```

Without an arrow, the step doubles as its own success condition. A step list written as lines of `text` (for example a numbered list) is also accepted. The controller assigns IDs such as `m1-1` and `m1-2` and shows the plan back to the model as a numbered list marking each step `done`, `CURRENT`, `todo`, or `blocked`. Milestones begin pending and become in progress when input is submitted for them.

To revise, the model sends `plan` again with a `reason` and **only the work still to do**:

```json
{"name":"computer","arguments":{"action":"plan","reason":"Ctrl+S had no effect","steps":["Save through File > Save As -> The Save dialog confirms the original destination"]}}
```

Completed milestones are kept automatically, with their IDs and evidence. Unfinished milestones are replaced by the new steps. A new step with the same title as a finished one is dropped. A finished plan plus new steps may not exceed seven. A missing reason is recorded as "Plan revised". Replaced plans remain in the conversation, and revision reasons explain the change without altering the original goal.

## Observations

Any action may carry three optional fields about **this** screenshot:

| Field | Meaning |
| --- | --- |
| `screen` | One sentence describing what the screenshot shows. Used as evidence. |
| `last_action` | `worked`, `failed` or `unclear`: did the **previous** input work, judging by this screenshot? Omitted on the first action. |
| `step_done` | `true` only when the current step's success condition is visible now. |

```json
{"name":"computer","arguments":{"action":"key","key":"ctrl+s","screen":"The report text is visible in the editor","last_action":"worked","step_done":true}}
```

The report describes the previous input on the current screen. It does not claim that the proposed Ctrl+S has already worked. The controller assigns source steps and observation IDs; the model cannot invent those references.

- Each input creates an unverified receipt. The next screenshot reviews it: `worked` means succeeded, `failed` means failed, and anything else means uncertain. An omitted review is recorded as uncertain, so it never blocks the next action.
- `step_done` completes the current milestone unless `last_action` is `failed`. It also settles an earlier uncertain review of that milestone's last input as succeeded.
- `done` completes every unfinished milestone with its `text` as evidence, unless the last action failed. The task still finishes only after a second `done` on a fresh screenshot, with no unreviewed input.
- A failed outcome is kept as a failure note, and the three most recent failures are shown to the model under "Recent problems".

Reports cannot authorize input or replace the original user request. Input proposals sent to Rust contain only executable action fields.

## Bounded recovery and memory

- Three identical consecutive action/screenshot pairs, or two failed outcomes for the same milestone, request one revised plan before further input. A second such episode pauses the task. The wording of the report does not affect repeated-action detection.
- Up to seven milestones, 16 notes, 8,000 combined note/evidence characters, eight receipts, and five revision reasons are retained. Whole notes are compacted, oldest failures first. Omission counts are shown to the model.
- The task prompt is capped at 32,000 JavaScript string characters and always contains the goal, the full plan, the review request for the previous input, and the current request. The separate recent transcript remains limited to six turns / 24,000 characters. These are character budgets, not model-specific token accounting.
- The summary is assembled from milestone evidence and failure notes, rather than only the last few input commands. The full conversation remains the audit trail.

## Checkpoints and limits

Version 2 checkpoints preserve milestone IDs, evidence, notes, receipts, counters, and revision reasons. Restoring always stops the task and requires a fresh screen. Old string plans migrate to pending milestones, and a legacy input summary becomes unverified history to recheck. Notes of any kind in older checkpoints (facts, files, questions) still load and are shown in the task panel. They never block completion, because the model has no way to answer them. No run token or approval is restored. Unknown future checkpoint versions are rejected rather than guessed.

The panel labels model observations separately from controller errors. Evidence remains model judgment, and saved or imported evidence is historical, not trusted proof. Final completion still requires the model to recheck the full original task against a fresh screen. Real-model visual grounding, independent application-state verification, and model-specific token budgets need further evaluation.
