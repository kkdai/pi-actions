# OAuth credential persistence

Review and triage can save OAuth credentials that Pi refreshes to a GitHub
Actions environment secret. This is opt-in. API-key authentication and calls
without persistence settings keep their existing behavior.

## Activation gate

Do not activate persistence until the owner has completed credential setup and
the new action revision is published. Pin both actions to that reviewed revision.
Do not add the new inputs to an older action revision.

The repository's existing `.github/workflows/review.yml` and `triage.yml` are not
migrated by this guide. The examples below are migration templates, not active
configuration. External setup and controlled GitHub checks remain required.
Local tests do not establish production readiness.

## Input and storage contract

Provide exactly one of `api-key` or `auth-json`. Persistence requires `auth-json`
with an OAuth credential for the selected `provider`, plus all three inputs:

| Input              | Required value                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| `auth-secret`      | Name of an existing environment secret, such as `PI_AUTH_JSON`.                                        |
| `auth-environment` | Environment that owns the secret and is attached to the job, such as `pi-oauth`.                       |
| `auth-token`       | GitHub token with permission to update that environment secret; an existing `PAT_TOKEN` can be reused. |

The selected provider's entry must contain `type: "oauth"`, non-empty `access`
and `refresh` strings, and a finite numeric `expires` timestamp in milliseconds.
Additional credential fields are preserved. Pi handles provider refresh; the
action does not implement a second OAuth flow.

Partial settings and API-key credentials in persistence mode fail before Pi
runs. The destination is always the caller's `GITHUB_REPOSITORY`. Repository
secrets, organization secrets, and secrets in other repositories are not
persistence destinations. There is no repository-secret fallback.

Before Pi runs, the action checks the destination environment's secret metadata
to confirm that the environment and secret exist and are readable. This API does
not return a decrypted value. A successful preflight does not prove that a later
write will succeed or that the caller attached the correct job environment.

When all three persistence inputs are omitted, OAuth refreshes are not saved.
Temporary credentials are removed after the run. Manual replacement is then
required when the stored credentials become invalid.

## Writer token permissions

Reuse the existing `PAT_TOKEN` repository secret if its token can update the
caller's environment secrets. No additional token secret is required.

Fine-grained PATs and GitHub App tokens need the repository permission
**Environments: read and write**. Classic PATs need the `repo` scope and access
to the repository. For a new token, limit access to the caller repository and
avoid unrelated permissions.

A shared PAT can have permissions required by other workflows. Sharing it also
increases the impact of a leak. Pass it only through the action's `auth-token`
input; do not grant additional permissions solely for model access.

GitHub's official REST documentation specifies:

| Operation                              | Fine-grained repository permission | Source                                                                                                                           |
| -------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Read environment-secret metadata       | Environments: read                 | [Get an environment secret](https://docs.github.com/en/rest/actions/secrets#get-an-environment-secret)                           |
| Read the encryption public key         | Environments: read                 | [Get an environment public key](https://docs.github.com/en/rest/actions/secrets#get-an-environment-public-key)                   |
| Create or update an environment secret | Environments: write                | [Create or update an environment secret](https://docs.github.com/en/rest/actions/secrets#create-or-update-an-environment-secret) |

These endpoints support fine-grained PATs, GitHub App installation access tokens,
and GitHub App user access tokens. Repository **Secrets: write** alone is not
sufficient: it is not the permission for environment-secret endpoints. App tokens
must remain valid through writeback; mint a fresh token in a trusted step when
needed. Organization approval and repository policies can still restrict access.

Keep the normal workflow `GITHUB_TOKEN` for comments and labels. Do not replace
it with the writer token or grant broad permissions to it. The action accepts the
writer through `auth-token`, maps it to the `PI_AUTH_TOKEN` environment variable,
and removes it from ordinary `gh` commands and Pi. Within this action, only
environment-secret operations receive it as their GitHub authentication token.

## Owner setup

The repository/account owner must complete these steps outside this change.
Do not send credentials through chat or include them in logs, commits, outputs,
or artifacts.

1. Wait until the reviewed persistence implementation is ready to publish.
   Stop all existing consumers of the OAuth login before changing its storage.
2. Create the `pi-oauth` GitHub environment in the caller repository. Restrict
   access to trusted workflow revisions. Check that required reviewers and branch
   restrictions permit the intended trusted review and triage jobs.
3. Check that the existing `PAT_TOKEN` has the permissions above. Verify metadata
   access and updates against a synthetic environment secret before using real
   OAuth data. Complete any required organization approval.
4. Use Pi `/login` once with a CI-only login. Store its `auth.json` document as the
   environment secret `PI_AUTH_JSON`. Use a login that is not shared with local Pi
   sessions, another repository, or any consumer outside the shared lock.
5. Keep the existing `PAT_TOKEN` repository secret and pass it as `auth-token`,
   as shown below. Do not create a separate writer secret. For an App, supply a
   fresh token from a trusted token creation step instead. Do not put the writer
   in job-level `env`, `GH_TOKEN`, or `GITHUB_TOKEN`.
6. Remove any repository or organization `PI_AUTH_JSON` value available to these
   jobs after confirming the environment value is configured. Do not leave a
   same-name fallback that can hide a missing job environment.
7. Publish the new action revision. Replace each SHA placeholder below with the
   same full, reviewed commit SHA. Migrate every credential consumer together,
   then perform the controlled checks before enabling production use.

## Serialization requirements

Every job that reads or writes this credential must use the same environment and
one fixed **job-level** concurrency group, with `cancel-in-progress: false`.
Hold the group for the whole job, from environment-secret loading to writeback.
Do not add a pull request number, issue number, or workflow name to this group.
Remove workflow-level automatic cancellation that could stop the protected job.
The composite action cannot enforce these caller settings.

GitHub reads repository and organization secrets when a workflow is queued. It
reads environment secrets when a job referencing the environment starts. The
shared job lock is therefore required for waiting jobs to receive updated state.
Verify this order with the live check below; a local mock cannot establish it.

Concurrency is mutual exclusion, not a guaranteed FIFO queue. With the default
queue behavior, a new pending run can replace an older pending run even with
`cancel-in-progress: false`. Repository concurrency cannot coordinate another
repository or a local Pi session. Secret APIs provide no compare-and-swap check.

## Migration examples

These are complete replacements for OAuth workflows, not additions to their
existing per-item concurrency blocks. Do not apply them before owner setup and
publication. Replace `<PUBLISHED_OAUTH_PERSISTENCE_COMMIT_SHA>` in both examples
with the published revision's full commit SHA. The placeholder is not runnable.
Keep the API-key examples in the action guides unchanged; they do not need this
shared OAuth lock.

### Review: `.github/workflows/review.yml`

```yaml
name: PR Review

on:
  pull_request_target:
    branches:
      - main
  workflow_dispatch:
    inputs:
      pull-request:
        description: Pull request number to review
        required: true
        type: number

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    # Never check out or execute pull request code.
    if: github.actor != 'dependabot[bot]'
    environment: pi-oauth
    concurrency:
      group: pi-oauth-auth-json
      cancel-in-progress: false
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: narumiruna/pi-action/review@<PUBLISHED_OAUTH_PERSISTENCE_COMMIT_SHA>
        with:
          pull-request: ${{ inputs.pull-request }}
          auth-json: ${{ secrets.PI_AUTH_JSON }}
          auth-secret: PI_AUTH_JSON
          auth-environment: pi-oauth
          auth-token: ${{ secrets.PAT_TOKEN }}
          provider: openai-codex
          model: gpt-6.1-sol
          thinking: medium
```

### Triage: `.github/workflows/triage.yml`

```yaml
name: Issue Triage

on:
  issues:
    types: [opened, edited, reopened]

permissions:
  issues: write

jobs:
  triage:
    environment: pi-oauth
    concurrency:
      group: pi-oauth-auth-json
      cancel-in-progress: false
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: narumiruna/pi-action/triage@<PUBLISHED_OAUTH_PERSISTENCE_COMMIT_SHA>
        with:
          auth-json: ${{ secrets.PI_AUTH_JSON }}
          auth-secret: PI_AUTH_JSON
          auth-environment: pi-oauth
          auth-token: ${{ secrets.PAT_TOKEN }}
          provider: openai-codex
          model: gpt-6.1-sol
          thinking: medium
```

Neither workflow needs a checkout with bundled prompts. Use only trusted action
revisions and prompts. Never check out a pull request head, execute pull request
code, or load prompts from it. If a custom prompt needs a checkout, use a trusted
revision. Create repository labels before testing triage.

## Credential lifecycle and failures

1. The action validates settings and checks destination metadata before Pi runs.
2. It keeps the original auth document in the parent process. Pi receives only
   the selected provider's credential in a mode-`0600` temporary `auth.json`.
3. It captures Pi stdout and stderr instead of streaming possible refreshed
   credentials to normal logs.
4. After every Pi process exit, including a failed exit, it reads and validates
   the selected credential. If it changed, the action masks its string values
   and replaces only that provider in the original document. Other providers and
   provider-specific metadata are preserved. Unchanged credentials are not saved;
   missing or invalid refreshed data cannot overwrite the stored secret.
5. It saves the merged JSON through stdin to
   `gh secret set <name> --env <environment> --repo <repository>`.
   GitHub CLI encrypts the value. The JSON is not passed in command arguments.
6. Writeback completes before model output parsing, result validation, or
   publication of comments or labels. A later failure does not discard a valid
   refresh. If saving fails, the action fails before publication. If both Pi and
   saving fail, it retains the Pi failure status and reports a separate sanitized
   persistence error. It always attempts temporary-file cleanup.

OAuth failure messages report the process exit status, not arbitrary child
output. A malformed provider response can contain new tokens even when Pi has
not saved them to `auth.json`. This suppression also applies without persistence.
The `refresh_token_reused` error adds explicit sign-in guidance.

A runner loss, forced cancellation, or timeout can interrupt the interval between
provider rotation and writeback. Automatic cleanup cannot guarantee recovery.
A failed write can leave the previous secret unusable. Do not retry refresh with
that old token or assume that a failed action left credentials unchanged.

## External verification handoff

The repository maintainer must complete this controlled GitHub check after
publication, pinning, owner setup, and migration of all consumers. Use a test
repository or controlled test configuration before production.

1. Run review and triage with the same environment and job lock. Arrange for one
   job to wait before the running job refreshes its credential. Confirm that the
   waiting job starts with saved state and succeeds without
   `refresh_token_reused`. Do not print or export credentials to compare them.
2. Cause a controlled model failure after a valid refresh. Confirm that writeback
   occurs despite the failed Pi exit and that the next run succeeds. Also check
   that malformed model output cannot prevent writeback.
3. Inspect redaction without printing token values. Confirm that a persistence
   failure blocks comments and labels. Record the tested action SHA and results
   without credential data.

These live checks remain outstanding until a maintainer records evidence. Local
mocks do not verify secret snapshot timing, live writer permissions, provider
refresh behavior, or model results. Do not rely on production auto-refresh before
these checks pass. Changes to `sumire` or any other external repository, and all
external writes, require separate authorization.

## Recovery and rollback

Stop every credential consumer before recovery. For `refresh_token_reused`, a
revoked credential, or lost refresh state, obtain a fresh CI-only Pi login and
replace the environment's `PI_AUTH_JSON`. Do not restore an old auth document;
its refresh token can already be consumed. Fix writer permissions or availability
before restarting jobs. Retrying the same consumed token cannot repair it.

To disable persistence, remove `auth-secret`, `auth-environment`, and `auth-token`
together. Return to manual credential replacement or API-key authentication.
Keep any remaining OAuth consumers serialized. Removing persistence does not
require revoking a shared `PAT_TOKEN` that other workflows still use. Revoke or
rotate it if compromised or when it is no longer needed. Existing comments and
labels do not need rollback.

## References

- [GitHub secret-loading timing](https://docs.github.com/en/actions/reference/security/secrets#when-github-actions-reads-secrets)
- [GitHub workflow concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
- [GitHub CLI secret updates and stdin](https://cli.github.com/manual/gh_secret_set)
