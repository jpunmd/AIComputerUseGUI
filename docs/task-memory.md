# Task progress and memory

Planning uses the same local vision model as execution. No additional model or separate summarization request is needed: a normal action response can describe the current screen and record durable facts alongside its proposed next input. This adds structured output requirements; models that cannot follow them receive one repair attempt and then the run pauses.

## Milestones and revisions

The initial `plan` action's `text` contains JSON such as:

```json
{"steps":[{"title":"Open the report","success_criteria":"Report text is visible in the editor"},{"title":"Save the report","success_criteria":"The requested destination and saved state are visible"}]}
```

The controller assigns IDs such as `m1-1` and `m1-2`. Milestones begin pending and become in progress when input is submitted for them. The model can mark a milestone completed or blocked using current-screen evidence. Previously completed work can be reopened when a new observation contradicts it.

A revised plan uses the same format with a `reason`. Retain existing IDs for retained work; omit an ID for a new milestone. Every completed milestone must keep its ID, title, and success condition. Failed approaches remain in memory and prior plans remain in the conversation. Revision reasons explain changes to unfinished work without changing the original goal.

## Observations and summaries

Include `progress` inside the computer tool's arguments. For example, after observing the report open, propose saving it:

```json
{
  "name": "computer",
  "arguments": {
    "action": "key",
    "key": "ctrl+s",
    "progress": {
      "outcome": {"status":"succeeded","evidence":"The report text is visible in the editor"},
      "milestones": [{"id":"m1-1","status":"completed","evidence":"The editor displays the requested report"}],
      "notes": [{"kind":"artifact","text":"report.txt","evidence":"The editor title shows report.txt"}],
      "next_milestone_id": "m1-2",
      "expected_outcome": "A saved indicator appears for the requested destination"
    }
  }
}
```

The outcome describes the **previous** input on the **current** screen. It does not claim that the proposed Ctrl+S has already worked. The controller assigns source steps/observation IDs; the model cannot invent those references. Outcome status is `succeeded`, `failed`, or `uncertain`. Review is required before further input. Uncertainty is retained rather than promoted to success.

Notes have kind `fact`, `artifact`, `failure`, or `question`. Facts, paths, and failures require a short evidence statement; questions may omit it. Up to six notes may be provided per response. Updating a note uses its existing `id`; changing its kind is rejected. `resolve_questions` contains objects with `id`, a self-contained `answer`, and `evidence`; the answer is retained as a fact. A task cannot finish while questions remain, and compaction never silently removes an unanswered question.

Milestone updates require an existing `id`, a status of `in_progress`, `completed`, or `blocked`, and evidence. At most one milestone can be in progress. Empty evidence, unknown IDs, unknown fields, and malformed updates are rejected atomically before input. Memory cannot authorize any input or replace the original user request. Input proposals sent to Rust contain only executable action fields.

## Bounded recovery and memory

- Three identical consecutive action/screenshot pairs, or two reported failed outcomes for the same milestone, request one revised plan before further input. A second such failure episode pauses the task. Progress wording does not affect repeated-action detection.
- Up to seven milestones, 16 notes, 8,000 combined note/evidence characters, eight receipts, and five revision reasons are retained. Whole notes are compacted; paths and unanswered questions receive priority. Omission counts tell the model to ask for missing details.
- The task prompt is capped at 32,000 JavaScript string characters. The goal, full milestone descriptions/conditions, current request, and latest receipt stay intact. Optional older results are selected as whole entries. The separate recent transcript remains limited to six turns / 24,000 characters. These are character budgets, not model-specific token accounting.
- The summary is assembled from model-extracted notes and milestone evidence, rather than only the last few input commands. It is not an exhaustive summary of everything the model has ever seen. The full conversation remains the audit trail.

## Checkpoints and limits

Version 2 checkpoints preserve milestone IDs, evidence, notes, receipts, counters, and revision reasons. Restoring always stops the task and requires a fresh screen. Old string plans migrate to pending milestones; a legacy input summary becomes unverified history to recheck. No run token or approval is restored. Unknown future checkpoint versions are rejected rather than guessed.

The panel labels model observations separately from controller errors. Evidence remains model judgment, and saved/imported evidence is historical, not trusted proof. Final completion still requires the model to recheck the full original task against a fresh screen. Real-model grounding, independent application-state verification, and model-specific token budgets require further evaluation/work.
