---
"pi-action": minor
---

Add a standalone persist-auth action that validates private OAuth credential files and saves them to environment secrets with an existing PAT_TOKEN. Add an optional auth-output handoff to review and triage, including failed Pi exits and successful no-op tasks, while preserving the inline persistence interface. Document cleanup ownership, shared job locking, and the standalone post-publication failure window.
