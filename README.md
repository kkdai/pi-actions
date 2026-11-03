# Pi Pull Request Review

Use [pi-coding-agent](https://github.com/earendil-works/pi) to review a pull request
diff, update a summary comment, and post inline review comments on code. The action
does not approve or reject pull requests.

For issue classification and labels, use the [triage action](triage/README.md) at
`narumiruna/pi-action/triage@main`.

## Usage

Create `.github/workflows/review.yml`:

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

concurrency:
  group: pi-review-${{ github.event.pull_request.number || inputs.pull-request }}
  cancel-in-progress: true

jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: narumiruna/pi-action/review@main
        with:
          pull-request: ${{ inputs.pull-request }}
          api-key: ${{ secrets.PI_API_KEY }}
          provider: openai
          model: gpt-6.1-sol
          thinking: medium
```

Pin the action to a commit SHA for production use. No checkout is needed with the
bundled prompt. The runner must provide Bash and GitHub CLI; `ubuntu-latest`
includes both. The action installs Node.js and Pi.

`pull_request_target` runs with the base repository's credentials and can review fork
pull requests. Do not check out a pull request head, load its prompts, or execute
its code in this workflow. Use only trusted action code and prompts.

To review an existing pull request, dispatch the workflow from the trusted `main`
branch:

```sh
gh workflow run review.yml --ref main -f pull-request=123
```

## Inputs

| Input          | Required             | Description                                                                                                            |
| -------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `pull-request` | For manual review    | Positive integer pull request number for `workflow_dispatch`. Ignored for pull request events.                         |
| `auth-json`    | One credential input | Contents of Pi's `auth.json`, including API keys or OAuth credentials.                                                 |
| `api-key`      | One credential input | API key for `provider`.                                                                                                |
| `base-url`     | No                   | API base URL override for an existing Pi provider. Its API protocol and model catalog stay unchanged.                  |
| `provider`     | No                   | Pi provider ID. Default: `openai`.                                                                                     |
| `model`        | No                   | Model ID in the selected provider's Pi catalog. Default: `gpt-6.1-sol`.                                                |
| `thinking`     | No                   | `off`, `minimal`, `low`, `medium` (default), `high`, `xhigh`, or `max`. Pi limits it to levels supported by the model. |
| `prompt`       | No                   | Markdown prompt file. Default: `.pi/prompts/review-pull-request.md`.                                                   |

Provide exactly one of `api-key` or `auth-json`. Store credentials in GitHub Actions
secrets. The workflow's `GITHUB_TOKEN` needs `contents: read` and
`pull-requests: write`.

### Pi auth.json

Run `/login` in Pi, then save the contents of `~/.pi/agent/auth.json` as the
`PI_AUTH_JSON` repository secret. Replace the action step with:

```yaml
- uses: narumiruna/pi-action/review@main
  with:
    pull-request: ${{ inputs.pull-request }}
    auth-json: ${{ secrets.PI_AUTH_JSON }}
    provider: openai
    model: gpt-6.1-sol
    thinking: high
```

The JSON must contain a credential for `provider`. The action copies only that
credential to a temporary file with mode `0600` and removes it after success or
failure. Refreshed OAuth credentials are not saved back to the GitHub secret;
update the secret if the provider expires or rotates them.

### Review prompt

The action uses [`.pi/prompts/review-pull-request.md`](.pi/prompts/review-pull-request.md).
If that file exists in the workspace, it takes precedence over the bundled copy.
Other `prompt` paths must exist and are resolved relative to the workspace.

To supply a repository prompt, check out a trusted revision before the action and
set `prompt` to the Markdown file path. Do not load prompts from an untrusted pull
request head.

Custom prompts must return a JSON object with `summary` and `findings`, as defined
in the bundled prompt. Each finding contains `severity`, `title`, `body`, and
`location`. A location contains `path`, `line`, `side` (`LEFT` or `RIGHT`), and an
optional `start_line` for a multiline range. Use `location: null` for a finding
without an exact diff location. Plain Markdown output is not supported.

## Review comments

- The first run creates a Pi summary comment in the PR conversation. Later runs
  update that same comment with the reviewed commit, summary, and current findings.
  Only Pi's marked `github-actions[bot]` comments can be updated. User comments
  and historical reviews are not changed.
- The summary keeps its original position. GitHub does not let the action insert
  a new comment before existing comments or move it to the top of the conversation.
- The summary starts with the review result. Finding sections show their counts.
  Inline findings use a table with severity, title, and a linked file name and
  line range. Each link opens the reviewed diff; its tooltip shows the full file
  path. A footer links to the reviewed commit with a short commit ID.
- Findings with valid diff locations become inline review threads. Single lines,
  multiline ranges, and removed lines are supported. Findings without valid
  locations remain in the summary with their full explanation.
- Inline findings are submitted together as a `COMMENT` review at the reviewed
  head commit. Identical findings at that commit are not posted twice. Findings
  at a new commit can create new threads; old threads are not deleted or resolved.
- A run with no findings only updates the summary. It does not post an empty review.

## Review limits

- Supported events are `pull_request`, `pull_request_target`, and `workflow_dispatch`.
  Use `pull_request_target` for fork reviews. Fork `pull_request` runs normally have
  no secrets and a read-only token.
- Pull request events use their base and head commits. Manual reviews fetch the
  current commit IDs from GitHub before reading the diff. Before publication, the
  action checks the current head. A detected mismatch fails the run without
  publishing its result. This check is not atomic with the comment writes.
- Pi runs without tools, extensions, skills, project configuration, or session
  storage. It does not run pull request code or inspect files outside the diff.
- GitHub diff limits and model context limits apply. The review covers only the
  returned diff. Retrieval errors, invalid model output, oversized comments, and
  GitHub API errors fail the action. Findings alone do not fail the action.
- The summary is saved before inline submission. If inline submission fails, the
  summary can already exist; rerun the workflow to complete publication.

## Development

Action manifests are in `review/action.yml` and `triage/action.yml`.
Action runtime sources are in `src/`: `review.ts`, `review-output.ts`,
`triage.ts`, and the shared `pi.ts`. TypeScript compiles them to ESM JavaScript
in `dist/`. Both composite actions run the committed `dist/` files, so action
users do not need to install development dependencies or build the action.
Bundled prompts remain in `.pi/prompts/`. Development tools remain in `scripts/`.

This is a private development package for the GitHub Actions. It does not expose
a supported npm library API.

```sh
npm ci
npm run ci
```

`npm run build` compiles the runtime with strict type checks. `npm test` builds
before running tests against the compiled files. Commit `dist/*.js` with every
source change; do not edit generated JavaScript directly. CI rebuilds the action
and rejects changed or untracked files in `dist/`.

Distribution tests run each manifest command from a copied action directory
that contains only `dist/`, `package.json`, bundled prompts, and the action
subdirectory. They also check missing runtime modules and prompts. No caller
checkout or local build tools are required to use the committed action revision.

### Verify GitHub comments

Local tests mock Pi and GitHub. They do not verify live model output, GitHub
permissions, or rendered comments.

Use a test PR to check the rendered comments after pushing an action revision:

1. Add known findings on an added line, a removed line, and a multiline range.
   Run a trusted workflow with the new action revision. Check the summary and
   the inline thread locations.
2. Run it again at the same head commit. Check that the summary comment ID is
   unchanged and identical inline findings are not duplicated.
3. Push a new commit. Check that the same summary shows the new head and that new
   inline comments are attached to it. Keep intentionally broken test PRs as drafts.
