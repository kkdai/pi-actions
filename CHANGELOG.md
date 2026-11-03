# pi-action

## 0.1.0

### Minor Changes

- f62e24b: Recheck earlier unresolved Pi findings against the current diff. Post a short explanation in simple technical English before resolving each verified fix. Leave uncertain findings and other authors' threads unchanged, and avoid duplicate fix replies on same-commit retries.

### Patch Changes

- 7f63f7d: Improve review comment readability with summary-first content, finding counts, linked diff locations on separate lines, and short commit links in the footer.
- d139b10: Show inline findings in a Markdown table with severity, title, and a linked file name and line range. Keep full file paths in link tooltips and preserve inline comment text.

## 0.0.2

### Patch Changes

- 2b6c55e: Support fork pull request reviews through trusted `pull_request_target` workflows. Add a `pull-request` input for manual reviews through `workflow_dispatch`. Both paths review only the diff without checking out or running pull request code, and keep the stale-head check before publication.

## 0.0.1

### Patch Changes

- 7acb6fa: Move the pull request review action from the repository root to `review/action.yml`.
  Update workflows from `narumiruna/pi-action@<ref>` to
  `narumiruna/pi-action/review@<ref>`. The repository root is no longer an action entry point.
