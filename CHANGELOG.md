# pi-action

## 0.0.2

### Patch Changes

- 2b6c55e: Support fork pull request reviews through trusted `pull_request_target` workflows. Add a `pull-request` input for manual reviews through `workflow_dispatch`. Both paths review only the diff without checking out or running pull request code, and keep the stale-head check before publication.

## 0.0.1

### Patch Changes

- 7acb6fa: Move the pull request review action from the repository root to `review/action.yml`.
  Update workflows from `narumiruna/pi-action@<ref>` to
  `narumiruna/pi-action/review@<ref>`. The repository root is no longer an action entry point.
