# Pi GitHub Actions

Review pull requests and classify issues with
[pi-coding-agent](https://github.com/earendil-works/pi). Rebase outdated pull
request branches with GitHub.

| Action                        | Purpose                                                   | Documentation                    |
| ----------------------------- | --------------------------------------------------------- | -------------------------------- |
| `narumiruna/pi-action/review` | Review a diff, post findings, and resolve verified fixes. | [Review guide](review/README.md) |
| `narumiruna/pi-action/triage` | Classify an issue and add existing repository labels.     | [Triage guide](triage/README.md) |
| `narumiruna/pi-action/rebase` | Rebase outdated pull request branches without a checkout. | [Rebase guide](rebase/README.md) |

## Development

Use Node.js 26, as in CI, and run:

```sh
npm ci
npm run ci
```

The package is private and does not expose a supported npm library API.

| Path                                                          | Purpose                                                             |
| ------------------------------------------------------------- | ------------------------------------------------------------------- |
| `review/action.yml`, `triage/action.yml`, `rebase/action.yml` | Composite action manifests.                                         |
| `src/`                                                        | TypeScript runtime for review, triage, rebase, and shared Pi setup. |
| `dist/`                                                       | Compiled ESM JavaScript used by the actions.                        |
| `.pi/prompts/`                                                | Bundled review and triage prompts.                                  |
| `tests/`                                                      | Runtime, workflow, and distribution tests.                          |
| `scripts/`                                                    | Development scripts.                                                |

`npm run build` compiles the runtime with strict type checks. `npm test` builds
before running tests against the compiled files. `npm run ci` runs the code
checks, tests, and build.

Commit `dist/*.js` with every source change. Do not edit generated JavaScript
directly. CI rebuilds the action and rejects changed or untracked files in
`dist/`. Action users do not need a checkout, development dependencies, or a local
build when they use the bundled prompts.

Distribution tests run each manifest command from a copied action directory
containing only `dist/`, `package.json`, the action subdirectory, and any required
bundled prompts. They also check missing runtime modules and prompts.

### Verify in GitHub

Local tests mock Pi and GitHub. Follow the action-specific guides to verify live
behavior:

- [Review verification](review/README.md#verify-in-github)
- [Triage verification](triage/README.md#verify-in-github)
- [Rebase verification](rebase/README.md#verify-in-github)
