# Pi Issue Triage

Use Pi to classify an issue and add existing repository labels. The action does
not create labels, remove labels, or post comments.

## Usage

Create `.github/workflows/triage.yml`:

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

The action accepts the same `auth-json`, `api-key`, `base-url`, `provider`, `model`,
and `thinking` inputs as the [review action](../README.md#inputs), with the same
defaults. Provide exactly one of `api-key` or `auth-json` as a GitHub Actions secret.
For Pi OAuth credentials, use `auth-json` and the matching provider.

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

## Verify in GitHub

The [repository workflow](../.github/workflows/triage.yml) uses `PI_AUTH_JSON` with
`openai-codex`. It runs after the workflow is merged into the default branch.

A repository maintainer must configure the Pi credential secret after publishing
the action revision. Run the workflow on a test issue with suitable repository
labels. Check the selected labels, then rerun it and confirm that other labels
remain unchanged. Complete this check before relying on automatic classification.
Local integration tests mock Pi and GitHub; they do not verify live model accuracy,
GitHub permissions, or label publication.

## Rollback

Remove the triage workflow step to stop classification. Existing labels remain
unchanged unless a maintainer removes them. The action does not remove labels or
post comments.
