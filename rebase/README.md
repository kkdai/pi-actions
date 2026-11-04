# Pi Pull Request Rebase

Use GitHub's native rebase operation to update pull request branches that are
behind their base branch. The action does not use Pi, resolve conflicts, check out
code, or execute pull request code.

## Usage

Create `.github/workflows/rebase.yml`:

```yaml
name: PR Rebase

on:
  push:
    branches:
      - main
  pull_request_target:
    branches:
      - main
    types: [opened, reopened, synchronize, ready_for_review, edited]
  workflow_dispatch:
    inputs:
      pull-request:
        description: Pull request number (empty selects all PRs targeting the default branch)
        required: false
        type: string

permissions:
  contents: write
  pull-requests: write

concurrency:
  group: pi-rebase-${{ github.event.pull_request.number || inputs.pull-request || github.ref }}
  cancel-in-progress: false

jobs:
  rebase:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: narumiruna/pi-action/rebase@main
        with:
          pull-request: ${{ inputs.pull-request }}
```

Change `main` to your base branch. Pin the action to a trusted commit SHA for
production use. The runner must provide Bash and GitHub CLI (`gh`), including
`gh pr update-branch --rebase`; `ubuntu-latest` includes both. The action installs
Node.js. No checkout or Pi credentials are needed.

A push scans all open pull requests targeting the pushed branch, including all
pages of results. Only pull request numbers are returned to the action runtime.
A pull request event selects that pull request. Manual runs
select the supplied number, or all open pull requests targeting the repository's
default branch when the input is empty.

To run against one pull request from the trusted workflow branch:

```sh
gh workflow run rebase.yml --ref main -f pull-request=123
```

Omit `-f pull-request=123` to scan the default branch's pull requests.

## Inputs

| Input          | Required | Default               | Description                                                                                                                                        |
| -------------- | -------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pull-request` | No       | Empty                 | Positive integer pull request number for manual runs. Empty selects all open pull requests targeting the default branch. Ignored for other events. |
| `token`        | No       | `${{ github.token }}` | GitHub token with `contents: write` and `pull-requests: write` for the repository.                                                                 |

## Behavior and limits

- Supported events are `push`, `pull_request_target`, `pull_request`, and
  `workflow_dispatch`. Pull request activities other than those in the example
  are skipped. Tag pushes and deleted branches are skipped.
- The action reads the current pull request state before each update. It skips
  closed or merged requests, drafts, fork branches, and known merge conflicts.
  In a batch, it also skips requests whose base branch changed after discovery.
- Each eligible request uses `gh pr update-branch --rebase`. GitHub CLI checks
  whether the branch is behind and leaves an up-to-date branch unchanged. The
  action never falls back to a merge update or a local force push.
- GitHub CLI reads the current head and supplies `expectedHeadOid` to the update
  mutation. GitHub rejects the update if the head changed after that read. Draft
  state or the base branch can still change after the action's eligibility check;
  those checks are not atomic with the update.
- A known merge conflict is skipped without failing the run. If mergeability is
  still unknown, GitHub decides whether the update can proceed. Rebase-specific
  conflicts, branch protection, token restrictions, and other GitHub errors can
  fail the command. The action does not edit files to resolve conflicts.
- A failed request does not stop other requests in the batch, but the run fails.
  Successful earlier updates are not reversed. There are no automatic retries;
  resolve the cause and run the workflow again. GitHub can also report a temporary
  `rebase not prepared` error.
- A successful CLI response means GitHub accepted the update. The new head can
  take time to appear. The action does not poll for completion or verify CI.

## Security and CI

`pull_request_target` provides the base repository's credentials. Keep the
workflow and action revision trusted. Do not check out the pull request head or
execute its code before or after this action in the same privileged job.

The default token is limited to the workflow repository. Fork branches are
skipped even if a contributor allows maintainer edits. Repository rules and token
permissions must allow the branch update. Changes to workflow files can need
additional token permissions.

With `GITHUB_TOKEN`, resulting `push` events do not start other workflows.
Resulting `pull_request` events with `opened`, `synchronize`, or `reopened` can
create approval-required workflow runs. A user with repository write access must
approve those runs. See
[GitHub's token event rules](https://docs.github.com/en/actions/concepts/security/github_token#when-github_token-triggers-workflow-runs).

For CI that must run without this approval, use a suitable GitHub App installation
token or personal access token. Store it as a secret and pass it to `token`:

```yaml
- uses: narumiruna/pi-action/rebase@main
  with:
    pull-request: ${{ inputs.pull-request }}
    token: ${{ secrets.REBASE_TOKEN }}
```

Updates made with that token can trigger this workflow again. The native
up-to-date check prevents another rebase when the branch already includes the
base branch. Verify CI event delivery before relying on this automation.

## Verify in GitHub

Local tests mock GitHub CLI. They do not verify live permissions, branch
protection, GitHub's rebase operation, or subsequent workflow runs.

After publishing a trusted action revision, a repository maintainer must:

1. Create a disposable same-repository pull request and record its head commit.
   Add a non-conflicting commit to the base branch. Run the workflow and wait for
   the pull request head to change. Check that the new history contains the base
   branch and preserves the pull request changes.
2. Run the workflow again. Check that it reports the branch as up to date and
   does not change the head.
3. Check draft, fork, closed, and conflicting pull requests. Confirm that they
   are skipped without branch updates. Resolve a conflict manually before retrying.
4. Check that the selected token starts the required CI, or that a maintainer can
   approve the resulting runs. Confirm that repository rules remain enforced.

Complete these checks before relying on automatic rebasing.

## Rollback

Remove the action step or disable the workflow to stop future rebases. Rebasing
changes commit IDs; removing the action does not restore earlier history. Keep
recorded old heads for live tests. A maintainer must coordinate any branch
recovery with contributors before rewriting history again.
