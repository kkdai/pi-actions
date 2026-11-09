# Persist Pi OAuth credentials

Use `narumiruna/pi-action/persist-auth` to validate an already-refreshed Pi
`auth.json` file and save it to an existing GitHub Actions environment secret in
the caller repository. Pi performs OAuth refresh; this action does not log in,
exchange provider tokens, or run a model.

## Activation and setup

Follow the [OAuth setup and migration guide](../docs/oauth.md) before activation.
It contains the durable owner setup, writer permissions, complete review and
triage workflows, live verification, and recovery instructions. Use a dedicated
CI-only Pi login and the same job environment and job-level lock for every
consumer, with `cancel-in-progress: false`.

Reuse the existing `PAT_TOKEN`; do not create another writer secret. Fine-grained
tokens need repository **Environments: read and write**. Classic PATs need `repo`
and repository access. Owner setup and live permissions remain unverified by
local tests. Wait for publication, pin the reviewed revision, and complete the
controlled checks before production use.

## Usage

Place these steps inside the protected job from the
[standalone review workflow](../docs/oauth.md#standalone-review-githubworkflowsreviewyml):

```yaml
- name: Review pull request
  id: review
  uses: narumiruna/pi-action/review@<PUBLISHED_COMMIT_SHA>
  with:
    auth-json: ${{ secrets.PI_AUTH_JSON }}
    provider: openai-codex
    model: gpt-6.1-sol
    auth-output: ${{ runner.temp }}/pi-review-auth/auth.json

- name: Persist refreshed credentials
  if: always() && steps.review.outcome != 'skipped'
  uses: narumiruna/pi-action/persist-auth@<PUBLISHED_COMMIT_SHA>
  with:
    auth-file: ${{ runner.temp }}/pi-review-auth/auth.json
    auth-json: ${{ secrets.PI_AUTH_JSON }}
    token: ${{ secrets.PAT_TOKEN }}
```

Replace both placeholders with the same published, reviewed full commit SHA.
For triage, use the [standalone triage workflow](../docs/oauth.md#standalone-triage-githubworkflowstriageyml).
Use the same known absolute file path in producer and consumer; do not depend on
outputs from a failed composite step. `always()` permits persistence after
producer failure, while the outcome check excludes skipped steps. Do not add
`continue-on-error`: a failed review or triage must remain failed.

Pass the writer token only to this action's `token` input, not to the producer,
job environment, Pi, or ordinary GitHub commands. Keep the regular workflow token
for comments and labels. Never put auth data in arguments, logs, outputs, or
artifacts.

The action sets up Node.js 26 and runs `dist/persist-auth.js`. The runner must
provide Bash and GitHub CLI (`gh`); `ubuntu-latest` includes both. No Pi
installation, checkout, model call, or local build is needed.

## Inputs

| Input         | Required | Default        | Description                                                                                                                |
| ------------- | -------- | -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `auth-file`   | Yes      | —              | Absolute path to a private regular `0600` auth file in a `0700` parent under `RUNNER_TEMP`. The action consumes this file. |
| `token`       | Yes      | —              | GitHub writer token, normally `${{ secrets.PAT_TOKEN }}`.                                                                  |
| `environment` | No       | `pi-oauth`     | Environment that owns the existing secret and is attached to the caller's job.                                             |
| `secret-name` | No       | `PI_AUTH_JSON` | Existing environment secret to update.                                                                                     |
| `auth-json`   | No       | —              | Original full auth document for semantic unchanged detection.                                                              |

Both the file and any supplied original must contain a non-empty provider map
of valid credential objects, including at least one complete OAuth credential.
OAuth entries require `type: "oauth"`, non-empty `access` and `refresh` strings,
and a finite numeric `expires` timestamp in milliseconds. Other valid credentials
and provider-specific fields are preserved. Malformed, incomplete, or oversized
documents fail safely; the maximum secret size is 48 KB.

Supply the original full `auth-json` to avoid unnecessary writes. Semantically
equal documents skip the update even if JSON formatting or key order differs.
This includes unchanged exports from successful producer no-ops. Without the
original, the action saves the valid file; GitHub cannot return a decrypted
secret for comparison. The destination is restricted to an existing environment
secret in the caller repository, with no repository-secret fallback.

## File ownership and cleanup

Review and triage reserve a new `auth-output` destination before Pi. They validate
the whole original document before any Pi invocation and export only a validated
merge of the selected credential into that original full document after each Pi
invocation, including failure. Successful no-ops export the unchanged full
document. Later parsing, state-check, or publication failures retain a valid
handoff. Invalid post-Pi credentials remove the incomplete handoff rather than
restore an original refresh token that might already be consumed.

The consumer requires a regular file owned by the current UID with mode `0600`,
a private `0700` parent, and a path under canonical `RUNNER_TEMP`. Symlinks,
public permissions, unsafe ownership, and paths outside the temporary directory
are rejected. The new handoff and consumer modes support POSIX ownership checks
on Linux and macOS. They fail closed if UID or private-permission safety cannot
be established; existing authentication modes are unchanged.

After validating path and private ownership, the action deletes the input on
handled success, unchanged results, or failure, including rejected secret
updates. Missing or malformed files cannot report a successful save. Invalid
path ownership is rejected without deleting an arbitrary file. It never follows
a symlink, deletes outside `RUNNER_TEMP`, or recursively deletes caller
directories. Cleanup runs in an isolated worker with an empty environment and a
verified working directory, then claims the file before removal. Empty private
handoff and cleanup directories may remain until runner cleanup. Cleanup
failures fail the step; combined save and cleanup failures report safe context
without raw auth data.

## Failure timing and recovery

Standalone destination preflight occurs **after Pi**. It cannot prevent earlier
token rotation. A failed write fails the job but cannot undo comments or labels
already published. Keep the supported inline `auth-secret`, `auth-environment`,
and `auth-token` inputs if writeback must succeed before publication. Do not
combine those inputs with `auth-output` or run both write paths together.

Runner loss, timeout, or forced cancellation can still prevent writeback and
cleanup. A previous secret can already contain a consumed refresh token. Stop
all consumers and follow [recovery](../docs/oauth.md#recovery-and-rollback);
do not restore an old document or blindly retry the old refresh token.

To roll back standalone mode, remove both the `persist-auth` step and producer
`auth-output` input. Return to inline persistence or API-key authentication. Do
not revoke a shared `PAT_TOKEN` merely because this consumer stopped using it.

## Verify in GitHub

Complete the [external verification handoff](../docs/oauth.md#external-verification-handoff)
after owner setup, publication, and pinning. Check a failed Pi exit followed by
the independent `always()` step, a queued second job using the saved state, and
cleanup without printing credentials. Confirm that failed saves fail the job
and that earlier comments or labels can remain. These live checks are not
performed by local tests. Secret changes, external writes, and release operations
require separate authorization.
