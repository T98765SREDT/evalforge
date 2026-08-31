# Browser acceptance checklist

This checklist is the manual/browser-E2E companion to the Node test suite. It
does not claim that a browser run has happened. Record the date, browser and
version, viewport, commit, and evidence links when executing it.

## Test record

| Field | Value |
| --- | --- |
| Date |  |
| Browser/version |  |
| Viewport |  |
| Commit |  |
| Tester |  |
| Result | Pass / blocked / needs follow-up |

## Targeted regression log

| Date | Scope | Result | Evidence |
| --- | --- | --- | --- |
| 2026-08-30 | Fresh local origin: legacy array migration, v3 blind-session creation, assignment start, draft save, refresh recovery, session completion and metadata reveal | Blocked locally | Playwright package/browser binaries are not installed in this environment; run the CI browser matrix before recording a pass |
| 2026-08-30 | 375px responsive smoke check: top bar, onboarding card, metric cards, and first review controls | Blocked locally | Requires the same Playwright browser setup; no local pass is claimed |

This log records targeted regressions only; the full clean-profile checklist below
still requires a fresh run when import, queue, export, keyboard, and deployed-page
behavior are being signed off.

## Clean-profile happy path

Start with a fresh browser profile or clear only the EvalForge origin. Open the
local server (`npm start`) or the deployed Pages URL.

1. Confirm the first screen explains that the workspace is empty and that data
   stays in the browser.
2. Download the CSV template and verify it contains
   `external_id,prompt,response_1,response_2`.
3. Import `examples/coding-pairs.jsonl`. The preview must show accepted,
   duplicate, and rejected rows; storage must remain unchanged until Apply.
4. Apply the dataset. The Dataset Library and Review queue must update together.
   If storage fails, the preview must remain available and the dataset write
   must roll back.
5. Open a queued case, edit a title or note, and confirm the workstation moves
   through dirty/saving/saved states. Refresh and confirm the saved draft is
   still present.
6. Complete one review with all rubric dimensions and evidence notes. Confirm
   the queue links the completed review and progress changes.
7. Skip another queued case with a reason. Confirm it remains visible as
   skipped and cannot be silently reopened as completed work.
8. Open **Evaluation analytics**. Confirm rates show numerators/denominators,
   drafts are excluded, and filters change the URL and the visible counts.
9. Export Audit JSON, Analysis CSV, and Summary Markdown. Confirm the exports
   contain saved data only; the CSV omits prompt/response text and the Markdown
   contains aggregate values only.
10. Run `node cli/evalforge.mjs verify <audit-file>.json` and record the output.

## Verified v3 blind-session slice

After the legacy data has been migrated, click **Check local storage** and
confirm that the status becomes **Verified v3 workspace**. The new v3 panel
should then:

1. List only datasets that contain at least one response pair.
2. Create a blind session with an explicit reviewer ID and seed.
3. Confirm assignment navigation is disabled before a session exists and stays
   locked while a session create/start/save transaction is in flight.
4. Persist one pending assignment per case and keep the same candidate order
   when the page is refreshed.
5. Display the prompt and positional candidate labels without source, model, or
   candidate IDs.
6. Start the first assignment and leave an `assignment_started` audit event in
   the v3 workspace.
7. Rate every rubric dimension, choose a preference, select confidence, and
   enter at least 20 characters of rationale. If the preference differs from
   the calculated winner, confirm that the additional evidence field appears
   and is required.
8. Save a draft, refresh the page, run **Check local storage**, and confirm the
   active session resumes at the first unfinished assignment with its draft
   values intact.
9. Complete the review and confirm the assignment becomes read-only and the
   review/audit rows are present in the verified workspace.
10. Resolve every assignment, click **Complete session**, and confirm the
   session status changes only after the guard passes. Then click **Reveal
   metadata** once and confirm the second audit event is recorded; repeated
   clicks must be idempotent.
11. Move between assignments with Previous/Next without exposing hidden
   metadata.

The panel now supports rubric ratings, anchored confidence, rationale, draft
saving, completion, refresh recovery, explicit session completion, and a
separate metadata-reveal action. The automated cross-layer workflow is in
[`tests/e2e/evalforge.spec.mjs`](../tests/e2e/evalforge.spec.mjs); this checklist
remains the manual companion for focus, motion, screenshots, and deeper failure
injection.

## Failure and integrity paths

- Restore a malformed JSON backup. The preview must show an error without
  replacing current evaluations.
- Attempt to apply a dataset containing a missing required field. The rejected
  row must identify its line and field and be downloadable as JSONL.
- Edit a completed review and save it as a revision. The prior revision must
  remain present and the new record must reference `supersedesReviewId`.
- On a revealed session, confirm source metrics appear. On an active blind
  session, confirm model/source names are absent from the reviewer-facing
  projection and source analytics remain unavailable.
- If a completed assignment points to a missing or draft review record, the
  session must refuse completion and leave the session state and audit trail
  unchanged.
- Tamper with candidate content or a rubric checksum in an exported audit JSON.
  The CLI must exit with an invalid-data result.
- Refresh while a draft is dirty. Confirm the browser exit warning appears and
  that choosing Keep editing leaves the form unchanged.

## Keyboard and responsive checks

- Use Tab/Shift+Tab only. Every control has a visible focus indicator and no
  keyboard trap occurs in a dialog.
- Open and close methodology, import, unsaved-change, confirmation, and skip
  dialogs with the keyboard. Focus returns to the control that opened the
  dialog.
- At a 375px-wide viewport, confirm the navigation, rubric rows, response cards,
  queue, analytics panels, and export actions remain readable without horizontal
  scrolling.
- Enable reduced motion and confirm no required information depends on an
  animation.

## Evidence to attach

Capture only de-identified examples:

- clean-profile onboarding;
- dataset preview with one rejected row;
- saved queue progress and analytics filter;
- audit export/CLI verification output;
- 375px layout and keyboard focus screenshots.

Do not attach real prompts, candidate responses, credentials, or browser
storage dumps.
