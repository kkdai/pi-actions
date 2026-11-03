---
"pi-action": patch
---

Support fork pull request reviews through trusted `pull_request_target` workflows. Add a `pull-request` input for manual reviews through `workflow_dispatch`. Both paths review only the diff without checking out or running pull request code, and keep the stale-head check before publication.
