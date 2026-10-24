# Work history and completion reflections

## Behaviour

- Open **Work history** from the command palette, history ribbon icon or the button in **Today**.
- History is a read-only projection of tasks whose current status is `closed`. All categories are included, not just the `Work` category.
- Dated records use **only `closedAt`**, grouped newest first by month in the device's time zone. Year, inclusive From/To dates and exact linked-note filters intersect. Filters are local to the view and do not write settings or tasks.
- Records without a valid completion timestamp appear separately under **Completion date unknown**. They obey the linked-note filter but remain visible regardless of date filters, explicitly excluded from dated counts. Due, created, updated and comment timestamps are never substituted.
- Cards show titles, actual completion timestamps, existing linked-note buttons and **all** close-out comments. Missing reflections are labelled; ordinary comments remain in Focus Hub. Text is rendered literally rather than as HTML/Markdown.
- Reopened tasks disappear from history; this is a view of currently closed work, not an append-only status-transition audit log. Existing `closedAt` semantics are unchanged.

## Completion

The model has tasks, arbitrary category names and linked notes, **not a separate project entity or project-completion action**. Therefore the prompt applies to all task/project work moved to Closed through Focus Hub, Today (including End of day) or timeline menus.

The existing **Prompt for close-out comment** setting controls the prompt. It asks for:

1. Result / what changed
2. My contribution
3. Measurable impact / evidence

All fields are optional. Missing evidence is left blank, not invented. Non-empty fields become labelled sections in one appended `closeOut: true` comment using the existing persistence and note-mirroring mechanism. No schema migration or new storage field is required; prior comments and their IDs are retained and old clients can display/edit the comment.

The task is already Closed when the reflection opens. **Skip**, Escape and closing the modal discard the draft without undoing completion or adding a comment. Ctrl/Cmd+Enter saves. Note-checkbox synchronisation and external Sync imports deliberately do not open interactive prompts; they retain their existing behaviour.

## Verification without a live vault

```sh
node --test tests/*.test.mjs
npm run build
git diff --check
node tests/preview-history.mjs
```

Tests use synthetic tasks and a jsdom Obsidian API boundary, exercising the real view, modal, status transition and comment methods. They include a synthetic 95-record distribution (49 dated, 46 unknown dates, 16 close-outs), DST/year boundaries, filters, literal unsafe text, settings, skip/dismiss and preservation of previous comments. This fixture is not a readback of the live vault.

The preview script renders the actual history view and completion modal with demonstration data and a small stand-in theme into ignored `test-tmp/history-preview.html` and `test-tmp/completion-preview.html`. These static visual fixtures are not a live Obsidian session. Screenshot artefacts in `test-tmp/` are also ignored. No scheduler, network fetch or vault migration is added by this feature.
