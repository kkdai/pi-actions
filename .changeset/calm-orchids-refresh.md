---
"pi-action": minor
---

Add opt-in OAuth credential persistence for review and triage through GitHub Actions environment secrets. Save refreshed credentials after Pi exits, including failures, while keeping the writer token separate from Pi and normal GitHub operations. Reuse an existing PAT_TOKEN for secret updates without a separate writer secret. Suppress OAuth error diagnostics that can contain tokens not yet saved by Pi. Document shared job serialization, setup, live verification, and recovery requirements.
