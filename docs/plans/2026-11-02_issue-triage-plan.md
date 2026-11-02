# Issue triage action

## Goal

Add a reusable action at `triage/action.yml` that classifies open GitHub issues with Pi and adds existing repository labels. Keep the root pull request review action compatible.

## Context

- The root `action.yml` installs Pi and runs `scripts/review.mjs`.
- The review runner already isolates credentials and disables Pi tools and project configuration.
- Vitest tests replace `gh` and `pi` with local executables. `npm run ci` runs lint, tests, and the TypeScript build.

## Plan

- [x] Extract the shared Pi runner without changing review behavior. `scripts/pi.mjs` now supplies credential validation, prompt resolution, process isolation, and cleanup. The 138 existing tests pass.
- [x] Add `triage/action.yml`, `triage/triage.mjs`, and the bundled `.pi/prompts/triage-issue.md` prompt. The integration tests verify supported issue activity, closed-issue skips, live issue data, paginated labels, strict output, final content checks, and add-only writes.
- [x] Add local integration tests for classification input, additive and repeat-safe writes, invalid output, stale issue data, unsupported events, credential isolation, and cleanup. All 85 triage tests pass.
- [x] Document the action inputs, required permissions, workflow example, and limits in `triage/README.md`. The example passes actionlint and the action metadata wiring checks pass. `npm run ci` was run; its baseline failure is recorded below.
- [x] Add `.github/workflows/triage.yml` for issue open, edit, and reopen events. It uses `PI_AUTH_JSON` and the review workflow's provider settings. The workflow passes actionlint and scoped Biome checks.
- [x] Limit the bundled prompt to `bug`, `documentation`, `enhancement`, and `question`. A prompt contract test verifies the supported names; documentation explains that custom prompts can use other existing labels.

## Completion Checklist

- [x] Local tests verify existing-name validation, add-only label writes, the no-tools invocation, and rejection when issue content changes before the final check.
- [ ] The existing review tests and all repository checks pass. All 223 tests, the build, and changed-file lint pass, but repository-wide formatting still fails as recorded below.
- [x] Documentation identifies the action path and provides a usable workflow.

## Validation results

- `npm test`: 223 tests pass across four files.
- `npm run build`: passes.
- Scoped Biome checks, JavaScript syntax checks, action metadata wiring checks, example workflow actionlint, and `git diff --check`: pass.
- `npm run ci`: fails in Biome on four pre-existing formatting errors in `.github/workflows/ci.yml`, `src/hello.ts`, `src/index.ts`, and `tests/index.test.ts`. `git diff --exit-code HEAD --` for those paths passes, which confirms they are unchanged. These unrelated files remain outside this change. The CI completion check remains open.
- Biome also reports the existing informational schema-version mismatch; it does not fail scoped checks.

## External Handoff

A repository maintainer must supply a Pi credential secret and run the documented workflow on a test issue after publishing this action revision. Live model classification and GitHub label publication are not verified by local mocked tests. No external API writes or model calls are required for this implementation.

## Rollback / Recovery

Remove the triage workflow step to stop classification. Existing labels remain unchanged unless a maintainer removes them. The action does not remove labels or post comments.
