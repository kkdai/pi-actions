# Pi GitHub Actions

Review pull requests and classify issues with
[pi-coding-agent](https://github.com/earendil-works/pi).

| Action                        | Purpose                                                   | Documentation                        |
| ----------------------------- | --------------------------------------------------------- | ------------------------------------ |
| `narumiruna/pi-action/review` | Review a diff, post findings, and resolve verified fixes. | [Review setup](#pull-request-review) |
| `narumiruna/pi-action/triage` | Classify an issue and add existing repository labels.     | [Triage guide](triage/README.md)     |

The review action does not approve or reject pull requests. The triage action does
not create or remove labels or post comments.

## Pull request review

Save an API key for your provider as the `PI_API_KEY` GitHub Actions secret. Then
create `.github/workflows/review.yml`:

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

The example reviews pull requests that target `main`. Change the branch name if
needed. Pin the action to a trusted commit SHA for production use.

No checkout is needed with the bundled prompt. The runner must provide Bash and
GitHub CLI (`gh`); `ubuntu-latest` includes both. The action installs Node.js and Pi.

### Workflow security

`pull_request_target` uses the base repository's credentials and supports reviews
of fork pull requests. Keep the workflow, action code, and prompts trusted:

- Do not check out the pull request head.
- Do not execute pull request code or load prompts from it.
- If you need a checkout for a custom prompt, use a trusted revision.

The action also supports `pull_request`, but fork runs normally have no secrets
and a read-only `GITHUB_TOKEN`.

### Manual reviews

The example also supports `workflow_dispatch`. To review an existing pull request,
run the workflow from the trusted `main` branch:

```sh
gh workflow run review.yml --ref main -f pull-request=123
```

The `pull-request` input is required for manual runs. Pull request events use the
number from the event and ignore this input.

## Inputs

These inputs apply to the review action. The triage action shares the credential,
provider, model, and thinking inputs; see the [triage guide](triage/README.md) for
its prompt and workflow.

| Input          | Required             | Default                              | Description                                                                                                        |
| -------------- | -------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `pull-request` | Manual runs only     | —                                    | Positive integer pull request number for `workflow_dispatch`. Ignored for pull request events.                     |
| `api-key`      | One credential input | —                                    | API key for the selected provider.                                                                                 |
| `auth-json`    | One credential input | —                                    | Contents of Pi's `auth.json`, with an API key or OAuth credential for the selected provider.                       |
| `base-url`     | No                   | —                                    | HTTP or HTTPS API base URL override for an existing Pi provider. The API protocol and model catalog do not change. |
| `provider`     | No                   | `openai`                             | Pi provider ID.                                                                                                    |
| `model`        | No                   | `gpt-6.1-sol`                        | Model ID in the selected provider's Pi catalog.                                                                    |
| `thinking`     | No                   | `medium`                             | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Pi limits the level to those supported by the model. |
| `prompt`       | No                   | `.pi/prompts/review-pull-request.md` | Path to a Markdown system prompt, relative to the workspace. The default has a bundled copy.                       |

Provide exactly one of `api-key` or `auth-json`, stored as a GitHub Actions secret.
The review workflow's `GITHUB_TOKEN` needs `contents: read` and
`pull-requests: write`.

### Use Pi credentials

To use credentials from an existing Pi login:

1. Run `/login` in Pi.
2. Save the contents of `~/.pi/agent/auth.json` as the `PI_AUTH_JSON` repository
   secret.
3. Replace `api-key` with `auth-json` and select the provider whose credential is
   in the file. For an `openai-codex` login, use:

```yaml
- uses: narumiruna/pi-action/review@main
  with:
    pull-request: ${{ inputs.pull-request }}
    auth-json: ${{ secrets.PI_AUTH_JSON }}
    provider: openai-codex
    model: gpt-6.1-sol
    thinking: medium
```

The action copies only the selected provider's credential to a temporary
`auth.json` file with mode `0600`. It removes the temporary directory after success
or failure. Refreshed OAuth credentials are not saved back to the GitHub secret;
update the secret if the provider expires or rotates them.

### Use a custom review prompt

The default prompt is
[`.pi/prompts/review-pull-request.md`](.pi/prompts/review-pull-request.md). A copy at
that path in the workspace takes precedence over the bundled copy. Other prompt
paths must exist in the workspace.

To use a repository prompt, check out a trusted revision before the action and
set `prompt` to the Markdown file path. Never load a prompt from an untrusted pull
request head.

When earlier unresolved Pi findings are available, the input is a JSON object
with `diff` and `unresolved_threads`. Each thread includes its ID, finding, file
location, original diff hunk, and original commit. Otherwise, the input is the raw
diff.

Custom prompts must return only a JSON object with `summary` and `findings`, using
the schema in the bundled prompt:

- `summary` is a non-empty string.
- `findings` is an array. Use `[]` when there are no findings.
  - Each finding has `severity`, `title`, `body`, and `location`.
  - `severity` is `critical`, `high`, `medium`, or `low`.
  - `title` and `body` are non-empty strings.
  - `location` has a repository-relative `path`, a file `line` number, and a
    `side`: `LEFT` for removed lines or `RIGHT` for new-side lines.
    - For a multiline range, add `start_line`. The range must be on one side
      within one diff hunk, and `line` is its last line.
    - Use `location: null` when there is no exact location in the diff.

The optional `resolved_threads` array identifies verified fixes. Each entry must
have exactly `id` and `reason`:

- `id` must identify a supplied unresolved thread and must not be repeated.
- `reason` must be a non-empty string of at most 300 characters. Use one short
  sentence in simple technical English. Explain the code change and why it fixes
  the issue; the action posts this text before resolving the thread.

Omit `resolved_threads` or return `[]` to leave all earlier threads open. Existing
custom prompts that return only `summary` and `findings` remain valid.

Other fields, Markdown fences, and prose outside the JSON object are not
supported. The finding body can contain Markdown.

## Review comments

### Summary comment

The first run creates a Pi summary comment in the pull request conversation.
Later runs update the same comment with the current summary, findings, and
reviewed commit. The action updates only its marked `github-actions[bot]`
comments; it does not edit user comments or historical review bodies.

The summary starts with the review result. Finding sections show their counts:

- **Inline findings** appear in a table with severity, title, and a linked file
  name and line range. Links open the reviewed diff; tooltips show full file paths.
- **Summary-only findings** include the full explanation when no valid diff
  location is available.

A footer links to the reviewed commit. With no findings, the comment contains
only the summary and footer, without an empty findings table.

The comment keeps its original position. GitHub does not let the action move it
to the top of the conversation.

### Inline review threads

Findings with valid diff locations are submitted together as a `COMMENT` review
at the reviewed head commit. Single lines, multiline ranges, and removed lines
are supported. The action does not submit an empty review.

Identical findings at the same commit are not posted twice. A new commit can
create new threads. Old threads are not deleted.

### Automatic resolution

On later reviews, Pi rechecks unresolved threads started by its marked
`github-actions[bot]` findings from earlier commits. It resolves a thread only
when the current diff shows a concrete change that fixes that specific issue.

Before resolving the thread, the action posts a reply with the reviewed commit
and a short explanation in simple technical English. If the reply fails, the
thread stays open.

The action leaves a thread open when the evidence is incomplete. An outdated
comment, a finding absent from the new review, or a reply that says "Fixed" is not
proof of a fix. Findings first posted at the current head are not rechecked.
Already resolved threads and threads started by humans or other bots are not
changed.

## Review limits and failures

- **Diff-only code context:** Pi receives the current diff and any eligible
  earlier Pi findings with their original diff hunks. It does not inspect other
  repository files or run pull request code. A fix outside the supplied current
  diff cannot be verified. GitHub diff limits and model context limits apply.
- **Isolated Pi run:** Tools, extensions, skills, project configuration, and
  session storage are disabled. GitHub tokens are not passed to Pi.
- **Commit selection:** Pull request events use their base and head commits.
  Manual runs fetch the current commit IDs from GitHub before reading the diff.
- **Changed pull request:** The action checks the current head before initial
  publication, before each fix reply, and before resolving each thread. A
  mismatch stops further writes. These checks are not atomic with GitHub writes;
  rerun on the latest commit.
- **Action failures:** Diff retrieval errors, empty diffs, model errors, invalid
  model output, oversized comments, and GitHub API errors fail the action.
  Findings alone do not fail it.
- **Partial publication:** The summary is saved before inline submission and
  thread resolution. A failed run can leave a summary, inline findings, or fix
  replies already posted. Rerun to complete publication. A same-head retry reuses
  an existing fix reply instead of posting another one.

## Development

Use Node.js 26, as in CI, and run:

```sh
npm ci
npm run ci
```

The package is private and does not expose a supported npm library API.

| Path                                     | Purpose                                                                 |
| ---------------------------------------- | ----------------------------------------------------------------------- |
| `review/action.yml`, `triage/action.yml` | Composite action manifests.                                             |
| `src/`                                   | TypeScript runtime: review, review output, triage, and shared Pi setup. |
| `dist/`                                  | Compiled ESM JavaScript used by both actions.                           |
| `.pi/prompts/`                           | Bundled review and triage prompts.                                      |
| `tests/`                                 | Runtime, workflow, and distribution tests.                              |
| `scripts/`                               | Development scripts.                                                    |

`npm run build` compiles the runtime with strict type checks. `npm test` builds
before running tests against the compiled files. `npm run ci` runs the code
checks, tests, and build.

Commit `dist/*.js` with every source change. Do not edit generated JavaScript
directly. CI rebuilds the action and rejects changed or untracked files in
`dist/`. Action users do not need a checkout, development dependencies, or a local
build when they use the bundled prompts.

Distribution tests run each manifest command from a copied action directory
containing only `dist/`, `package.json`, bundled prompts, and the action
subdirectory. They also check missing runtime modules and prompts.

### Verify comments in GitHub

Local tests mock Pi and GitHub. They do not verify live model output, GitHub
permissions, or rendered comments. After publishing an action revision, use a test
pull request to check:

1. Add known findings on an added line, a removed line, and a multiline range.
   Run a trusted workflow with the new action revision. Check the summary and
   inline thread locations.
2. Run it again at the same head commit. Check that the summary comment ID is
   unchanged and identical inline findings are not duplicated.
3. Push a new commit. Check that the same summary shows the new head and that new
   inline comments are attached to it. Keep intentionally broken test pull
   requests as drafts.
4. Fix one earlier finding with a change visible in the current diff, but leave
   another finding unfixed. Check that the next review posts a short fix reply
   and resolves only the fixed thread. Rerun and check that the reply is not
   duplicated.

For live label checks, follow the [triage verification guide](triage/README.md#verify-in-github).
