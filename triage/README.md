# Pi Issue Triage

Use Pi to classify an issue and add existing repository labels. The action does
not create labels, remove labels, or post comments.

## Usage

Save an API key for your provider as the `PI_API_KEY` GitHub Actions secret. Then
create `.github/workflows/triage.yml`:

```yaml
name: Issue Triage

on:
  issues:
    types: [opened, edited, reopened]

permissions:
  issues: write

concurrency:
  group: pi-triage-${{ github.event.issue.number }}
  cancel-in-progress: true

jobs:
  triage:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: narumiruna/pi-action/triage@main
        with:
          api-key: ${{ secrets.PI_API_KEY }}
          provider: openai
          model: gpt-6.1-sol
          thinking: medium
```

Pin the action to a commit SHA for production use. Create the repository labels
before the first run. Label descriptions help Pi select relevant labels.

No checkout is needed with the bundled prompt. The runner must provide Bash and
GitHub CLI; `ubuntu-latest` includes both. The action installs Node.js and Pi.

## Inputs

| Input              | Required             | Default                       | Description                                                                                                        |
| ------------------ | -------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `api-key`          | One credential input | —                             | API key for the selected provider.                                                                                 |
| `auth-json`        | One credential input | —                             | Contents of Pi's `auth.json`, with an API key or OAuth credential for the selected provider.                       |
| `auth-secret`      | With persistence     | —                             | Existing environment secret to update. Requires `auth-environment`, `auth-token`, and OAuth `auth-json`.           |
| `auth-environment` | With persistence     | —                             | Environment that owns the secret and is attached to the caller's job.                                              |
| `auth-token`       | With persistence     | —                             | GitHub token with repository `Environments: write` permission. An existing `PAT_TOKEN` can be reused.              |
| `base-url`         | No                   | —                             | HTTP or HTTPS API base URL override for an existing Pi provider. The API protocol and model catalog do not change. |
| `provider`         | No                   | `openai`                      | Pi provider ID.                                                                                                    |
| `model`            | No                   | `gpt-6.1-sol`                 | Model ID in the selected provider's Pi catalog.                                                                    |
| `thinking`         | No                   | `medium`                      | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Pi limits the level to those supported by the model. |
| `prompt`           | No                   | `.pi/prompts/triage-issue.md` | Path to a Markdown system prompt, relative to the workspace. The default has a bundled copy.                       |

Provide exactly one of `api-key` or `auth-json`, stored as a GitHub Actions secret.
The workflow's `GITHUB_TOKEN` needs `issues: write`.

### Use Pi credentials

Use `auth-json` instead of `api-key` and select the provider whose credential is
in the document. For an `openai-codex` login, use `provider: openai-codex` and a
model from that provider's Pi catalog.

For persistent OAuth credentials, follow the shared
[OAuth setup and migration guide](../docs/oauth.md). It includes a complete triage
workflow. Use a CI-only Pi login, an existing environment secret in the caller
repository, and all three persistence inputs. Every consumer, including review,
must use the same job environment and job-level concurrency group with
`cancel-in-progress: false`.

Do not activate these settings before owner setup and publication of the new
action revision. Pin that revision; older action revisions do not support these
inputs. Complete the guide's controlled GitHub checks before production use.

With persistence enabled, valid credential changes are saved after every Pi exit,
including failure, before parsing results or adding labels. Other providers and
metadata are preserved. A failed save fails the action before publication.
Without persistence settings, refreshed credentials are not saved; replace them
manually when needed.

### Use a custom triage prompt

The `prompt` input defaults to
[`.pi/prompts/triage-issue.md`](../.pi/prompts/triage-issue.md). A workspace copy at
that path takes precedence over the bundled copy. Other prompt paths must exist
in the workspace. To use a repository prompt, check out a trusted revision before
the action and set `prompt` to its Markdown file path.

The bundled prompt uses only `bug`, `documentation`, `enhancement`, and `question`
for automatic issue classification. It excludes labels that need maintainer
judgment or pull request context. Custom prompts can select other existing labels.

Custom prompts receive JSON containing `issue.title`, `issue.body`, and all
repository label names and descriptions in `labels`. They must return only this
JSON structure, using exact names of existing labels:

```json
{ "labels": ["bug", "documentation"] }
```

Return `{"labels": []}` when no label applies. Other fields, unknown labels, and
non-JSON output fail the action before any labels are applied.

## Behavior and limits

- Only `issues` events are supported. Activities other than `opened`, `edited`,
  and `reopened` are skipped. Closed issues and repositories without labels are
  also skipped.
- The action reads the current issue title and body, not comments or repository
  files. It retrieves all repository labels, including paginated results.
- Pi runs without tools, extensions, skills, project configuration, or session
  storage. GitHub tokens are not passed to Pi. Temporary Pi credentials are
  removed after success or failure.
- Before adding labels, the action checks the current title, body, open state,
  and labels again. Changed issue content fails the run; rerun it to classify the
  latest content.
- Only missing selected labels are added. Existing labels are preserved, including
  labels added during classification. Repeated runs do not duplicate labels.
  A maintainer must remove incorrect or outdated labels.
- Model classification can be incorrect. Do not use an applied label as
  authorization for a privileged workflow.
- GitHub API errors, model errors, invalid output, and context limits can fail the
  action. The action does not retry failed writes automatically.

## Troubleshooting

### Credential or provider errors

For `Provide exactly one of api-key or auth-json.`, check that the selected
secret exists and is available to the workflow. Do not pass both inputs.

For provider authentication errors, check that the credential matches
`provider`. Use a `model` from that provider's Pi catalog; changing `base-url`
does not add models or change the API protocol.

For `refresh_token_reused` or lost OAuth state, stop every consumer and follow
[OAuth recovery](../docs/oauth.md#recovery-and-rollback). Obtain a fresh CI-only
login and replace the environment secret; retrying the old token cannot repair
it. For preflight or save failures, check the environment, secret name, and the
writer token's `Environments: write` permission before restarting jobs.

### GitHub permission errors

For GitHub `403` errors, grant `issues: write` to the job's `GITHUB_TOKEN`.
Check repository and organization Actions policies if writes are still blocked.
Pi credentials do not grant GitHub access.

### No labels are added

Check the action log:

- `Skipping unsupported issue activity.`: use an `issues` event with
  `opened`, `edited`, or `reopened`.
- `Skipping a closed issue.`: classification requires an open issue.
- `Skipping a repository without labels.`: create repository labels first.
- `No labels selected.`: no label was selected for the supplied issue. Check
  the label names, descriptions, and [prompt rules](#use-a-custom-triage-prompt).
- `No new labels to apply.`: all selected labels are already on the issue.
  No action is needed.

### Missing prompt or invalid model output

For `The prompt file does not exist.`, check the workspace-relative `prompt`
path. A repository prompt needs a checkout of a trusted revision.

For invalid JSON, schema errors, or unknown labels, check the
[custom prompt contract](#use-a-custom-triage-prompt). The response must contain
only a `labels` array with exact existing label names. Do not add Markdown
fences or prose outside the JSON object. Invalid output does not add labels.

### The issue changed during triage

Rerun the workflow when the issue is open and its title and body are stable.
The action reads the current issue again. Labels added by other runs or
maintainers are preserved.

## Verify in GitHub

The [repository workflow](../.github/workflows/triage.yml) is not yet migrated to
OAuth persistence. Do not activate persistence before owner setup, publication,
and pinning of the new action revision. Use the
[shared migration examples](../docs/oauth.md#migration-examples), then complete
the [external verification handoff](../docs/oauth.md#external-verification-handoff).
This includes queued secret-loading timing and a failure after refresh.

Run the published action on a test issue with suitable repository labels. Check
the selected labels, then rerun it and confirm that other labels remain unchanged.
Complete these checks before relying on automatic classification. Local tests
mock Pi and GitHub; they do not verify live model accuracy, GitHub permissions,
or label publication.

## Rollback

Remove the triage workflow step to stop classification. Existing labels remain
unchanged unless a maintainer removes them. The action does not remove labels or
post comments.
