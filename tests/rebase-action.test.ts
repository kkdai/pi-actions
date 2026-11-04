import { spawnSync } from "node:child_process"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, expect, test } from "vitest"

const actionPath = resolve("rebase")
const manifest = readFileSync(join(actionPath, "action.yml"), "utf8")
const runCommand = manifest.match(/^ {6}run: (node .+)$/m)?.[1]
const roots: string[] = []
const request = {
  state: "OPEN",
  isDraft: false,
  isCrossRepository: false,
  mergeable: "MERGEABLE",
  baseRefName: "main",
}
const event = { action: "opened", number: 999, pull_request: { number: 42 } }

type Command = { command: string; args: string[]; promptDisabled: string; token: string }

const mockCommand = String.raw`#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const { basename, join } = require("node:path");
const env = process.env;
const args = process.argv.slice(2);
const command = basename(process.argv[1]);
appendFileSync(join(env.MOCK_ROOT, "commands.jsonl"), JSON.stringify({
  command, args, promptDisabled: env.GH_PROMPT_DISABLED, token: env.GH_TOKEN,
}) + "\n");
if (command !== "gh") throw new Error("Only GitHub CLI may run");
if (args.includes("--repo") && args[args.indexOf("--repo") + 1] !== "owner/repo") {
  throw new Error("Expected an explicit repository");
}
function fail(stage) {
  if (env.MOCK_FAILURE === stage) {
    console.error(env.MOCK_FAILURE_MESSAGE || "mock " + stage + " failure");
    process.exit(1);
  }
}
if (args[0] === "api") {
  if (args[1] !== "repos/owner/repo/pulls" || args[args.indexOf("--method") + 1] !== "GET") {
    throw new Error("Only pull request discovery is allowed");
  }
  for (const flag of ["--paginate", "--jq", "state=open", "per_page=100"]) {
    if (!args.includes(flag)) throw new Error("Missing discovery option: " + flag);
  }
  if (args.includes("--slurp") || args[args.indexOf("--jq") + 1] !== ".[].number") {
    throw new Error("Discovery must filter each page to pull request numbers");
  }
  fail("list");
  const pages = env.MOCK_LARGE_PAGES
    ? Array.from({ length: 4 }, () => Array.from({ length: 100 }, () => ({
        number: 42, title: "A large request", body: "x".repeat(65536),
        base: { ref: "main" }, head: { ref: "topic" },
      })))
    : JSON.parse(env.MOCK_PAGES);
  appendFileSync(join(env.MOCK_ROOT, "discovery-bytes"), String(Buffer.byteLength(JSON.stringify(pages))));
  process.stdout.write(env.MOCK_DISCOVERY_OUTPUT || pages.flatMap(page =>
    page.map(request => JSON.stringify(request.number ?? null))
  ).join("\n"));
} else if (args[0] === "pr" && args[1] === "view") {
  fail("view-" + args[2]);
  const requests = JSON.parse(env.MOCK_REQUESTS);
  if (!(args[2] in requests)) throw new Error("Unexpected pull request number: " + args[2]);
  process.stdout.write(env.MOCK_VIEW_OUTPUT || JSON.stringify(requests[args[2]]));
} else if (args[0] === "pr" && args[1] === "update-branch") {
  if (!args.includes("--rebase")) throw new Error("Merge updates are not allowed");
  fail("update-" + args[2]);
  console.log(env.MOCK_UPDATE_OUTPUT);
} else {
  throw new Error("Unexpected GitHub command: " + JSON.stringify(args));
}
`

function runAction(overrides: Record<string, string> = {}, payload: unknown = event) {
  const root = mkdtempSync(join(tmpdir(), "pi-rebase-test-"))
  roots.push(root)
  const workspace = join(root, "workspace")
  const bin = join(root, "bin")
  for (const directory of [workspace, bin]) mkdirSync(directory)
  for (const command of ["gh", "git", "pi"]) {
    writeFileSync(join(bin, command), mockCommand, { mode: 0o755 })
  }
  const eventPath = join(root, "event.json")
  writeFileSync(eventPath, JSON.stringify(payload))
  const token = overrides.GH_TOKEN ?? "github-token"
  const result = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", runCommand ?? "exit 1"],
    {
      cwd: workspace,
      encoding: "utf8",
      timeout: 15_000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GH_TOKEN: "github-token",
        GITHUB_ACTION_PATH: actionPath,
        GITHUB_EVENT_NAME: "pull_request_target",
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_REPOSITORY: "owner/repo",
        GITHUB_WORKSPACE: workspace,
        PI_PULL_REQUEST: "",
        PI_API_KEY: "",
        PI_AUTH_JSON: "",
        MOCK_ROOT: root,
        MOCK_PAGES: JSON.stringify([[{ number: 42 }]]),
        MOCK_LARGE_PAGES: "",
        MOCK_DISCOVERY_OUTPUT: "",
        MOCK_REQUESTS: JSON.stringify({ 42: request }),
        MOCK_VIEW_OUTPUT: "",
        MOCK_UPDATE_OUTPUT: "PR branch updated",
        MOCK_FAILURE: "",
        MOCK_FAILURE_MESSAGE: "",
        ...overrides,
      },
    },
  )
  expect(result.error).toBeUndefined()
  const calls: Command[] = existsSync(join(root, "commands.jsonl"))
    ? readFileSync(join(root, "commands.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : []
  for (const call of calls) {
    expect(call.command).toBe("gh")
    expect(call.promptDisabled).toBe("1")
    expect(call.token).toBe(token)
  }
  expect(readdirSync(workspace)).toEqual([])
  expect(result.stdout + result.stderr).not.toContain(token)
  return { result, calls, root }
}

function updates(calls: Command[]) {
  return calls.filter((call) => call.args[1] === "update-branch")
}

function copyDistribution() {
  const root = mkdtempSync(join(tmpdir(), "pi-rebase-dist-"))
  roots.push(root)
  const directory = join(root, "action distribution")
  for (const path of ["dist", "package.json", "rebase"]) {
    cpSync(resolve(path), join(directory, path), { recursive: true })
  }
  return directory
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test("the manifest uses the compiled runtime and does not install Pi or check out code", () => {
  expect(runCommand).toBe('node "$GITHUB_ACTION_PATH/../dist/rebase.js"')
  expect(manifest).toContain(`GH_TOKEN: \${{ inputs.token }}`)
  expect(manifest).toContain(`default: \${{ github.token }}`)
  expect(manifest).toContain(`PI_PULL_REQUEST: \${{ inputs.pull-request }}`)
  expect(manifest).not.toMatch(/actions\/checkout|npm install|PI_API_KEY|PI_AUTH_JSON/)
})

test("passes a custom token to GitHub CLI without logging it", () => {
  expect(manifest).toContain(`GH_TOKEN: \${{ inputs.token }}`)
  const { result, calls } = runAction({ GH_TOKEN: "custom-app-token" })
  expect(result.status, result.stderr).toBe(0)
  expect(calls).toHaveLength(2)
  expect(calls.every((call) => call.token === "custom-app-token")).toBe(true)
})

test("runs from a distribution-only directory with spaces and no prompts or credentials", () => {
  const directory = copyDistribution()
  expect(readdirSync(directory).sort()).toEqual(["dist", "package.json", "rebase"])
  const { result, calls } = runAction({ GITHUB_ACTION_PATH: join(directory, "rebase") })
  expect(result.status, result.stderr).toBe(0)
  expect(updates(calls)).toHaveLength(1)
})

test.each(["dist/rebase.js", "dist/pi.js"])(
  "fails before commands when the distribution is missing %s",
  (path) => {
    const directory = copyDistribution()
    rmSync(join(directory, path))
    const { result, calls } = runAction({ GITHUB_ACTION_PATH: join(directory, "rebase") })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("MODULE_NOT_FOUND")
    expect(calls).toEqual([])
  },
)

test.each(["pull_request", "pull_request_target"])(
  "selects the %s event number, ignores manual input, and requests a native rebase",
  (name) => {
    const { result, calls } = runAction({ GITHUB_EVENT_NAME: name, PI_PULL_REQUEST: "99" })
    expect(result.status, result.stderr).toBe(0)
    expect(calls.map((call) => call.args)).toEqual([
      [
        "pr",
        "view",
        "42",
        "--repo",
        "owner/repo",
        "--json",
        "state,isDraft,isCrossRepository,mergeable,baseRefName",
      ],
      ["pr", "update-branch", "42", "--repo", "owner/repo", "--rebase"],
    ])
    expect(result.stdout).toContain("Pull request #42: PR branch updated")
  },
)

test.each(["opened", "reopened", "synchronize", "ready_for_review", "edited"])(
  "accepts pull request activity %s",
  (action) => {
    const { result, calls } = runAction({}, { ...event, action })
    expect(result.status, result.stderr).toBe(0)
    expect(updates(calls)).toHaveLength(1)
  },
)

test.each(["closed", "labeled", "converted_to_draft", undefined])(
  "skips pull request activity %s before commands",
  (action) => {
    const { result, calls } = runAction({}, { ...event, action })
    expect(result.status, result.stderr).toBe(0)
    expect(calls).toEqual([])
  },
)

test("manually selects one pull request without needing event metadata", () => {
  const { result, calls } = runAction({
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_EVENT_PATH: "",
    PI_PULL_REQUEST: " 42 ",
  })
  expect(result.status, result.stderr).toBe(0)
  expect(calls).toHaveLength(2)
  expect(updates(calls)[0].args[2]).toBe("42")
})

test.each(["push", "workflow_dispatch"])(
  "discovers every open PR targeting the selected branch on %s",
  (name) => {
    const payload =
      name === "push"
        ? { ref: "refs/heads/main", deleted: false }
        : { repository: { default_branch: "main" } }
    const { result, calls } = runAction(
      {
        GITHUB_EVENT_NAME: name,
        MOCK_PAGES: JSON.stringify([[{ number: 42 }], [], [{ number: 43 }, { number: 42 }]]),
        MOCK_REQUESTS: JSON.stringify({ 42: request, 43: request }),
      },
      payload,
    )
    expect(result.status, result.stderr).toBe(0)
    expect(calls[0].args).toEqual([
      "api",
      "repos/owner/repo/pulls",
      "--method",
      "GET",
      "--raw-field",
      "state=open",
      "--raw-field",
      "base=main",
      "--raw-field",
      "per_page=100",
      "--paginate",
      "--jq",
      ".[].number",
    ])
    expect(updates(calls).map((call) => call.args[2])).toEqual(["42", "43"])
  },
)

test("filters more than 20 MiB of paginated metadata before buffering it", () => {
  const { result, calls, root } = runAction(
    { GITHUB_EVENT_NAME: "push", MOCK_LARGE_PAGES: "1" },
    { ref: "refs/heads/main" },
  )
  expect(result.status, result.stderr).toBe(0)
  expect(Number(readFileSync(join(root, "discovery-bytes"), "utf8"))).toBeGreaterThan(
    20 * 1024 * 1024,
  )
  expect(updates(calls)).toHaveLength(1)
  expect(calls[0].args).toContain(".[].number")
})

test("passes a pushed branch name as one API argument, not as shell code", () => {
  const branch = "release/next-$(touch-injected)"
  const { result, calls } = runAction(
    {
      GITHUB_EVENT_NAME: "push",
      PI_PULL_REQUEST: "99",
      MOCK_REQUESTS: JSON.stringify({ 42: { ...request, baseRefName: branch } }),
    },
    { ref: `refs/heads/${branch}`, deleted: false },
  )
  expect(result.status, result.stderr).toBe(0)
  expect(calls[0].args).toContain(`base=${branch}`)
  expect(updates(calls)).toHaveLength(1)
})

test.each([
  { ref: "refs/heads/main", deleted: true },
  { ref: "refs/tags/v1", deleted: false },
])("skips deleted branches and tags: %j", (payload) => {
  const { result, calls } = runAction({ GITHUB_EVENT_NAME: "push" }, payload)
  expect(result.status, result.stderr).toBe(0)
  expect(calls).toEqual([])
})

test("accepts an empty discovery result without updating branches", () => {
  const { result, calls } = runAction(
    { GITHUB_EVENT_NAME: "push", MOCK_PAGES: "[[],[]]" },
    { ref: "refs/heads/main" },
  )
  expect(result.status, result.stderr).toBe(0)
  expect(calls).toHaveLength(1)
  expect(result.stdout).toContain("No open pull requests to rebase.")
})

test.each([
  ["closed", { state: "CLOSED" }],
  ["merged", { state: "MERGED" }],
  ["draft", { isDraft: true }],
  ["fork", { isCrossRepository: true }],
  ["conflicting", { mergeable: "CONFLICTING" }],
])("skips a currently %s pull request without an update", (_name, fields) => {
  const { result, calls } = runAction({
    MOCK_REQUESTS: JSON.stringify({ 42: { ...request, ...fields } }),
  })
  expect(result.status, result.stderr).toBe(0)
  expect(calls).toHaveLength(1)
  expect(updates(calls)).toEqual([])
  expect(result.stdout).toContain("Skipping pull request #42:")
})

test("skips a pull request retargeted after discovery", () => {
  const { result, calls } = runAction(
    {
      GITHUB_EVENT_NAME: "push",
      MOCK_REQUESTS: JSON.stringify({ 42: { ...request, baseRefName: "release" } }),
    },
    { ref: "refs/heads/main" },
  )
  expect(result.status, result.stderr).toBe(0)
  expect(calls).toHaveLength(2)
  expect(updates(calls)).toEqual([])
  expect(result.stdout).toContain("base branch changed")
})

test("lets GitHub decide when mergeability has not yet been calculated", () => {
  const { result, calls } = runAction({
    MOCK_REQUESTS: JSON.stringify({ 42: { ...request, mergeable: "UNKNOWN" } }),
  })
  expect(result.status, result.stderr).toBe(0)
  expect(updates(calls)).toHaveLength(1)
})

test("reports the native CLI result when the branch is already up to date", () => {
  const { result } = runAction({ MOCK_UPDATE_OUTPUT: "PR branch already up-to-date" })
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain("Pull request #42: PR branch already up-to-date")
})

test.each(["issues", "schedule", "", "pull_request_review"])(
  "rejects unsupported event name %j before commands",
  (name) => {
    const { result, calls } = runAction({ GITHUB_EVENT_NAME: name })
    expect(result.status).toBe(1)
    expect(calls).toEqual([])
  },
)

test.each(["0", "-1", "1.5", "1e2", "01", "abc", "9007199254740992"])(
  "rejects invalid manual number %j before commands",
  (number) => {
    const { result, calls } = runAction({
      GITHUB_EVENT_NAME: "workflow_dispatch",
      PI_PULL_REQUEST: number,
    })
    expect(result.status).toBe(1)
    expect(calls).toEqual([])
  },
)

test.each([undefined, null, "42", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  "rejects invalid event number %j instead of falling back to the top-level number",
  (number) => {
    const { result, calls } = runAction({}, { ...event, number: 42, pull_request: { number } })
    expect(result.status).toBe(1)
    expect(calls).toEqual([])
  },
)

test.each([
  ["missing event path", { GITHUB_EVENT_PATH: "" }],
  ["missing repository", { GITHUB_REPOSITORY: "" }],
  ["invalid repository", { GITHUB_REPOSITORY: "owner/repo/extra" }],
])("rejects %s before commands", (_name, overrides) => {
  const { result, calls } = runAction(overrides)
  expect(result.status).toBe(1)
  expect(calls).toEqual([])
})

test.each([null, [], "not an event"])("rejects non-object event %j", (payload) => {
  const { result, calls } = runAction({}, payload)
  expect(result.status).toBe(1)
  expect(calls).toEqual([])
})

test.each([{}, { ref: "main" }, { ref: "refs/heads/" }, { ref: 42 }])(
  "rejects invalid push ref %j before commands",
  (payload) => {
    const { result, calls } = runAction({ GITHUB_EVENT_NAME: "push" }, payload)
    expect(result.status).toBe(1)
    expect(calls).toEqual([])
  },
)

test.each([{}, { repository: {} }, { repository: { default_branch: "" } }])(
  "rejects missing default branch in a manual batch: %j",
  (payload) => {
    const { result, calls } = runAction({ GITHUB_EVENT_NAME: "workflow_dispatch" }, payload)
    expect(result.status).toBe(1)
    expect(calls).toEqual([])
  },
)

test.each([
  "Not JSON",
  "null",
  "{}",
  "[]",
  '"42"',
  "0",
  "-1",
  "1.5",
  "9007199254740992",
  "42\nnull",
])("rejects invalid discovery output %j without branch updates", (output) => {
  const { result, calls } = runAction(
    { GITHUB_EVENT_NAME: "push", MOCK_DISCOVERY_OUTPUT: output },
    { ref: "refs/heads/main" },
  )
  expect(result.status).toBe(1)
  expect(calls).toHaveLength(1)
  expect(updates(calls)).toEqual([])
})

test.each([
  "Not JSON",
  "null",
  "[]",
  "{}",
  JSON.stringify({ ...request, state: "unknown" }),
  JSON.stringify({ ...request, state: ["OPEN"] }),
  JSON.stringify({ ...request, isDraft: null }),
  JSON.stringify({ ...request, isCrossRepository: "false" }),
  JSON.stringify({ ...request, mergeable: "invalid" }),
  JSON.stringify({ ...request, mergeable: ["MERGEABLE"] }),
  JSON.stringify({ ...request, baseRefName: null }),
])("rejects invalid live pull request output %j without updating it", (output) => {
  const { result, calls } = runAction({ MOCK_VIEW_OUTPUT: output })
  expect(result.status).toBe(1)
  expect(calls).toHaveLength(1)
  expect(updates(calls)).toEqual([])
})

test.each(["list", "view-42", "update-42"])("reports a %s command failure", (stage) => {
  const { result, calls } = runAction(
    { GITHUB_EVENT_NAME: "push", MOCK_FAILURE: stage },
    { ref: "refs/heads/main" },
  )
  expect(result.status).toBe(1)
  expect(result.stderr).toContain(`mock ${stage} failure`)
  expect(calls).toHaveLength(stage === "list" ? 1 : stage === "view-42" ? 2 : 3)
})

test.each(["view-42", "update-42"])(
  "continues other pull requests after a %s failure, but fails the run",
  (stage) => {
    const { result, calls } = runAction(
      {
        GITHUB_EVENT_NAME: "push",
        MOCK_FAILURE: stage,
        MOCK_PAGES: JSON.stringify([[{ number: 42 }, { number: 43 }]]),
        MOCK_REQUESTS: JSON.stringify({ 42: request, 43: request }),
      },
      { ref: "refs/heads/main" },
    )
    expect(result.status).toBe(1)
    expect(updates(calls).map((call) => call.args[2])).toContain("43")
    expect(result.stdout).toContain("Pull request #43: PR branch updated")
  },
)

test("escapes command failures before writing GitHub error annotations", () => {
  const { result } = runAction({
    MOCK_FAILURE: "update-42",
    MOCK_FAILURE_MESSAGE: "conflict 100%\n::warning::untrusted text\rmore",
  })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain("conflict 100%25%0A::warning::untrusted text%0Dmore")
  expect(result.stderr).not.toContain("\n::warning::")
})
