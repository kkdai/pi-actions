---
"pi-action": minor
---

Add opt-in OAuth credential persistence for review and triage through GitHub Actions environment secrets. Save refreshed credentials after Pi exits, including failures, while keeping the dedicated writer token separate from Pi and normal GitHub operations. Suppress OAuth error diagnostics that can contain tokens not yet saved by Pi. Document shared job serialization, setup, live verification, and recovery requirements.
