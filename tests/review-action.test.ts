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

const actionPath = resolve(".")
const runCommand = readFileSync(join(actionPath, "action.yml"), "utf8").match(
  /^ {6}run: (node .+)$/m,
)?.[1]
const roots: string[] = []
const base = "a".repeat(40)
const head = "b".repeat(40)
const diff =
  "diff --git a/example.ts b/example.ts\n--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-old\n+new\n"

const summaryMarker = "<!-- pi-action:summary -->"
const noFindings = { summary: "No actionable findings found in the supplied diff.", findings: [] }
const finding = {
  severity: "high",
  title: "Preserve the expected behavior",
  body: "The changed line breaks the existing behavior. Restore the original behavior.",
  location: { path: "example.ts", line: 1, side: "RIGHT" },
}
const inlineBody = `<!-- pi-action:finding -->\n**High: ${finding.title}**\n\n${finding.body}`
const bot = { login: "github-actions[bot]", type: "Bot" }
const withFinding = JSON.stringify({ summary: "One issue found.", findings: [finding] })

const mockCommand = String.raw`#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } = require("node:fs");
const { basename, join } = require("node:path");
const env = process.env;
const args = process.argv.slice(2);
const command = basename(process.argv[1]);
appendFileSync(join(env.MOCK_ROOT, "commands.jsonl"), JSON.stringify({ command, args }) + "\n");
function fail(stage) {
  if (env.MOCK_FAILURE === stage) {
    console.error("mock " + stage + " failure");
    process.exit(1);
  }
}
if (command === "gh") {
  const endpoint = args.find(value => value.startsWith("repos/"));
  const method = args.includes("--method") ? args[args.indexOf("--method") + 1] : "GET";
  if (endpoint.includes("/compare/")) {
    fail("fetch");
    process.stdout.write(env.MOCK_EMPTY_DIFF ? "" : env.MOCK_DIFF);
  } else if (method === "GET" && endpoint.endsWith("/issues/42/comments")) {
    fail("list-summaries");
    process.stdout.write(env.MOCK_SUMMARIES);
  } else if (method === "GET" && endpoint.endsWith("/pulls/42/comments")) {
    fail("list-inline");
    process.stdout.write(env.MOCK_INLINE_COMMENTS);
  } else if (method === "GET" && endpoint.endsWith("/pulls/42")) {
    fail("head");
    process.stdout.write(env.MOCK_CURRENT_HEAD);
  } else if (method === "POST" && endpoint.endsWith("/reviews")) {
    fail("review");
    writeFileSync(join(env.MOCK_ROOT, "posted.json"), readFileSync(args[args.indexOf("--input") + 1], "utf8"));
    console.log(JSON.stringify({ id: 1, html_url: "https://github.com/owner/repo/pull/42#pullrequestreview-1" }));
  } else if ((method === "POST" && endpoint.endsWith("/issues/42/comments")) ||
    (method === "PATCH" && endpoint.includes("/issues/comments/"))) {
    fail("summary");
    writeFileSync(join(env.MOCK_ROOT, "summary.json"), readFileSync(args[args.indexOf("--input") + 1], "utf8"));
    const id = method === "PATCH" ? Number(endpoint.split("/").pop()) : 99;
    console.log(JSON.stringify({ id, html_url: "https://github.com/owner/repo/pull/42#issuecomment-" + id }));
  } else {
    throw new Error("Unexpected GitHub request: " + JSON.stringify(args));
  }
} else {
  const directory = env.PI_CODING_AGENT_DIR;
  const modelPath = join(directory, "models.json");
  writeFileSync(join(env.MOCK_ROOT, "pi.json"), JSON.stringify({
    args,
    cwd: process.cwd(),
    directory,
    auth: JSON.parse(readFileSync(join(directory, "auth.json"), "utf8")),
    mode: statSync(join(directory, "auth.json")).mode & 0o777,
    models: existsSync(modelPath) ? JSON.parse(readFileSync(modelPath, "utf8")) : null,
    diff: readFileSync(args.find(value => value.startsWith("@")).slice(1), "utf8"),
    githubToken: env.GH_TOKEN,
    alternateToken: env.GITHUB_TOKEN,
    apiKeyInput: env.PI_API_KEY,
    authJsonInput: env.PI_AUTH_JSON,
  }));
  fail("pi");
  process.stdout.write(env.MOCK_EMPTY_REVIEW ? "" : env.MOCK_REVIEW);
}
`

function runAction(overrides: Record<string, string> = {}, promptPath?: string) {
  const root = mkdtempSync(join(tmpdir(), "pi-review-test-"))
  roots.push(root)
  const workspace = join(root, "workspace")
  const runner = join(root, "runner")
  const bin = join(root, "bin")
  for (const directory of [workspace, runner, bin]) mkdirSync(directory)
  for (const command of ["gh", "pi"]) {
    writeFileSync(join(bin, command), mockCommand, { mode: 0o755 })
  }
  const eventPath = join(root, "event.json")
  writeFileSync(
    eventPath,
    JSON.stringify({ number: 42, pull_request: { base: { sha: base }, head: { sha: head } } }),
  )
  if (promptPath) {
    const fullPath = join(workspace, promptPath)
    mkdirSync(resolve(fullPath, ".."), { recursive: true })
    writeFileSync(fullPath, "Custom review instructions.")
  }
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
        GITHUB_TOKEN: "alternate-github-token",
        GITHUB_ACTION_PATH: actionPath,
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_REPOSITORY: "owner/repo",
        GITHUB_WORKSPACE: workspace,
        RUNNER_TEMP: runner,
        PI_PROVIDER: "openai",
        PI_MODEL: "gpt-6.1-sol",
        PI_API_KEY: "test-api-key",
        PI_AUTH_JSON: "",
        PI_BASE_URL: "",
        PI_THINKING: "medium",
        PI_PROMPT: ".pi/prompts/review-pull-request.md",
        MOCK_ROOT: root,
        MOCK_DIFF: diff,
        MOCK_REVIEW: JSON.stringify(noFindings),
        MOCK_SUMMARIES: "[[]]",
        MOCK_INLINE_COMMENTS: "[[]]",
        MOCK_CURRENT_HEAD: head,
        ...overrides,
      },
    },
  )
  expect(result.error).toBeUndefined()
  const json = (name: string) => JSON.parse(readFileSync(join(root, name), "utf8"))
  expect(readdirSync(runner)).toEqual([])
  return { result, root, workspace, json }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test("the review manifest launches the source entry point from its action directory", () => {
  expect(runCommand).toBe('node "$GITHUB_ACTION_PATH/src/review.mjs"')
})

test("runs the manifest from a source-only action directory with spaces", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-review-source-"))
  roots.push(root)
  const directory = join(root, "action source")
  for (const path of ["src", ".pi/prompts"]) {
    cpSync(resolve(path), join(directory, path), { recursive: true })
  }
  const { result, json } = runAction({ GITHUB_ACTION_PATH: directory })
  expect(result.status, result.stderr).toBe(0)
  const args = json("pi.json").args
  expect(args[args.indexOf("--system-prompt") + 1]).toBe(
    join(directory, ".pi/prompts/review-pull-request.md"),
  )
})

test("reviews the event's exact commits with the API key and bundled prompt", () => {
  const { result, json, root } = runAction()
  expect(result.status, result.stderr).toBe(0)
  const commands = readFileSync(join(root, "commands.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  expect(commands[0]).toEqual({
    command: "gh",
    args: [
      "api",
      `repos/owner/repo/compare/${base}...${head}`,
      "--header",
      "Accept: application/vnd.github.diff",
    ],
  })
  const pi = json("pi.json")
  expect(pi.auth).toEqual({ openai: { type: "api_key", key: "test-api-key" } })
  expect(pi.mode).toBe(0o600)
  expect(pi.cwd).toBe(pi.directory)
  expect(pi.models).toBeNull()
  expect(pi.diff).toBe(diff)
  expect(pi.args).toEqual(
    expect.arrayContaining([
      "--print",
      "--no-tools",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-approve",
      "--provider",
      "openai",
      "--model",
      "gpt-6.1-sol",
      "--thinking",
      "medium",
      resolve(".pi/prompts/review-pull-request.md"),
    ]),
  )
  for (const name of ["githubToken", "alternateToken", "apiKeyInput", "authJsonInput"]) {
    expect(pi[name]).toBeUndefined()
  }
  const summary = json("summary.json")
  expect(summary).toEqual({ body: expect.stringContaining(summaryMarker) })
  expect(summary.body).toContain(noFindings.summary)
  expect(summary.body).toContain(head)
  expect(summary.body).toContain("This review covers only the supplied diff.")
  expect(existsSync(join(root, "posted.json"))).toBe(false)
  expect(result.stdout).toContain(
    "Summary posted: https://github.com/owner/repo/pull/42#issuecomment-99",
  )
})

test("loads only the selected OAuth credential from auth-json", () => {
  const credential = {
    type: "oauth",
    access: "access-token",
    refresh: "refresh-token",
    expires: 9999999999999,
  }
  const { result, json } = runAction({
    PI_API_KEY: "",
    PI_AUTH_JSON: JSON.stringify({
      openai: credential,
      "unused-provider": { type: "api_key", key: "unused-key" },
    }),
    PI_PROVIDER: "openai",
    PI_MODEL: "gpt-6.1-sol",
    PI_THINKING: "high",
  })
  expect(result.status, result.stderr).toBe(0)
  expect(json("pi.json").auth).toEqual({ openai: credential })
  expect(json("pi.json").args).toEqual(expect.arrayContaining(["openai", "gpt-6.1-sol", "high"]))
  expect(result.stdout).toContain("::add-mask::access-token")
  expect(result.stdout).toContain("::add-mask::refresh-token")
  expect(result.stdout).not.toContain("unused-key")
})

test("loads an API key credential from auth-json", () => {
  const credential = { type: "api_key", key: "stored-api-key" }
  const { result, json } = runAction({
    PI_API_KEY: "",
    PI_AUTH_JSON: JSON.stringify({ openai: credential }),
  })
  expect(result.status, result.stderr).toBe(0)
  expect(json("pi.json").auth).toEqual({ openai: credential })
})

test.each(["", 123])("rejects an invalid auth-json API key %j", (key) => {
  const { result, root } = runAction({
    PI_API_KEY: "",
    PI_AUTH_JSON: JSON.stringify({ openai: { type: "api_key", key } }),
  })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain("non-empty string")
  expect(existsSync(join(root, "commands.jsonl"))).toBe(false)
})

test("sets the provider base URL without replacing its model catalog", () => {
  const { result, json } = runAction({ PI_BASE_URL: "https://proxy.example.com/v1" })
  expect(result.status, result.stderr).toBe(0)
  expect(json("pi.json").models).toEqual({
    providers: { openai: { baseUrl: "https://proxy.example.com/v1" } },
  })
})

test.each(["off", "minimal", "low", "medium", "high", "xhigh", "max"])(
  "passes thinking=%s to Pi",
  (thinking) => {
    const { result, json } = runAction({ PI_THINKING: thinking })
    expect(result.status, result.stderr).toBe(0)
    const args = json("pi.json").args
    expect(args[args.indexOf("--thinking") + 1]).toBe(thinking)
  },
)

test.each(["custom prompt.md", ".pi/prompts/review-pull-request.md"])(
  "loads the workspace prompt at %s",
  (prompt) => {
    const { result, json, workspace } = runAction({ PI_PROMPT: prompt }, prompt)
    expect(result.status, result.stderr).toBe(0)
    expect(json("pi.json").args).toContain(join(workspace, prompt))
  },
)

test.each([
  [{ PI_API_KEY: "" }, "Provide exactly one"],
  [{ PI_AUTH_JSON: "{}" }, "Provide exactly one"],
  [{ PI_API_KEY: "", PI_AUTH_JSON: "invalid-secret-json" }, "valid JSON"],
  [{ PI_API_KEY: "", PI_AUTH_JSON: "{}" }, "credential for provider"],
  [{ PI_PROVIDER: "" }, "provider and model"],
  [{ PI_MODEL: "" }, "provider and model"],
  [{ PI_THINKING: "invalid" }, "Invalid thinking"],
  [{ PI_BASE_URL: "file:///tmp/model" }, "HTTP or HTTPS"],
  [{ PI_PROMPT: "missing.md" }, "prompt file does not exist"],
  [{ GITHUB_EVENT_NAME: "pull_request_target" }, "pull_request event"],
])("rejects invalid inputs %j before invoking commands", (overrides, message) => {
  const { result, root } = runAction(overrides)
  expect(result.status).toBe(1)
  expect(result.stderr).toContain(message)
  expect(result.stderr).not.toContain("invalid-secret-json")
  expect(existsSync(join(root, "commands.jsonl"))).toBe(false)
})

test.each(["fetch", "pi", "list-summaries", "head", "summary"])(
  "cleans credentials after a %s failure",
  (stage) => {
    const { result, root } = runAction({ MOCK_FAILURE: stage })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`mock ${stage} failure`)
    expect(existsSync(join(root, "summary.json"))).toBe(false)
    expect(existsSync(join(root, "posted.json"))).toBe(false)
  },
)

test.each([
  [{ MOCK_EMPTY_DIFF: "1" }, "diff is empty"],
  [{ MOCK_EMPTY_REVIEW: "1" }, "empty review"],
])("does not post an empty result %j", (overrides, message) => {
  const { result, root } = runAction(overrides)
  expect(result.status).toBe(1)
  expect(result.stderr).toContain(message)
  expect(existsSync(join(root, "summary.json"))).toBe(false)
  expect(existsSync(join(root, "posted.json"))).toBe(false)
})

function commands(root: string) {
  return readFileSync(join(root, "commands.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
}

test("creates the summary before submitting inline comments at the exact head", () => {
  const { result, json, root } = runAction({ MOCK_REVIEW: withFinding })
  expect(result.status, result.stderr).toBe(0)
  const posted = json("posted.json")
  expect(posted).toEqual({
    body: expect.stringContaining("#issuecomment-99"),
    event: "COMMENT",
    commit_id: head,
    comments: [{ path: "example.ts", line: 1, side: "RIGHT", body: inlineBody }],
  })
  const calls = commands(root)
  const writes = calls.filter((call) => call.args.includes("POST"))
  expect(writes.map((call) => call.args[3])).toEqual([
    "repos/owner/repo/issues/42/comments",
    "repos/owner/repo/pulls/42/reviews",
  ])
  for (const endpoint of ["issues/42/comments", "pulls/42/comments"]) {
    expect(calls).toContainEqual({
      command: "gh",
      args: ["api", `repos/owner/repo/${endpoint}`, "--paginate", "--slurp"],
    })
  }
})

test("updates the first Pi summary across paginated comments and preserves other authors", () => {
  const pages = [
    [
      { id: 1, user: { login: "owner", type: "User" }, body: summaryMarker },
      { id: 2, user: { login: "other[bot]", type: "Bot" }, body: summaryMarker },
      { id: 3, user: bot, body: "Another workflow comment." },
    ],
    [
      { id: 4, user: bot, body: `${summaryMarker}\nOld finding.` },
      { id: 5, user: bot, body: `${summaryMarker}\nDuplicate old summary.` },
    ],
  ]
  const { result, root, json } = runAction({ MOCK_SUMMARIES: JSON.stringify(pages) })
  expect(result.status, result.stderr).toBe(0)
  const writes = commands(root).filter(
    (call) => call.args.includes("PATCH") || call.args.includes("POST"),
  )
  expect(writes).toHaveLength(1)
  expect(writes[0].args.slice(0, 4)).toEqual([
    "api",
    "--method",
    "PATCH",
    "repos/owner/repo/issues/comments/4",
  ])
  expect(json("summary.json").body).not.toContain("Old finding.")
  expect(result.stdout).toContain("Summary updated:")
})

test("does not replace a human or another bot comment that contains the summary marker", () => {
  const pages = [
    [
      { id: 1, user: { login: "owner", type: "User" }, body: summaryMarker },
      { id: 2, user: { login: "other[bot]", type: "Bot" }, body: summaryMarker },
    ],
  ]
  const { result, root } = runAction({ MOCK_SUMMARIES: JSON.stringify(pages) })
  expect(result.status, result.stderr).toBe(0)
  expect(commands(root).some((call) => call.args.includes("PATCH"))).toBe(false)
  expect(result.stdout).toContain("Summary posted:")
})

test("posts multiline and deleted-line findings using GitHub review coordinates", () => {
  const rangedDiff = [
    "diff --git a/example.ts b/example.ts",
    "--- a/example.ts",
    "+++ b/example.ts",
    "@@ -8,2 +8,3 @@",
    " context",
    "-removed",
    "+first",
    "+second",
    "",
  ].join("\n")
  const { result, json } = runAction({
    MOCK_DIFF: rangedDiff,
    MOCK_REVIEW: JSON.stringify({
      summary: "Two issues found.",
      findings: [
        { ...finding, location: { path: "example.ts", line: 10, start_line: 9, side: "RIGHT" } },
        { ...finding, location: { path: "example.ts", line: 9, side: "LEFT" } },
      ],
    }),
  })
  expect(result.status, result.stderr).toBe(0)
  expect(json("posted.json").comments).toEqual([
    {
      path: "example.ts",
      line: 10,
      side: "RIGHT",
      start_line: 9,
      start_side: "RIGHT",
      body: inlineBody,
    },
    { path: "example.ts", line: 9, side: "LEFT", body: inlineBody },
  ])
})

test("keeps an out-of-diff finding in the summary without posting an invalid inline review", () => {
  const { result, json, root } = runAction({
    MOCK_REVIEW: JSON.stringify({
      summary: "One issue found.",
      findings: [{ ...finding, location: { ...finding.location, line: 999 } }],
    }),
  })
  expect(result.status, result.stderr).toBe(0)
  expect(json("summary.json").body).toContain(finding.body)
  expect(existsSync(join(root, "posted.json"))).toBe(false)
})

const postedFinding = {
  user: bot,
  commit_id: head,
  original_commit_id: head,
  path: "example.ts",
  line: null,
  original_line: 1,
  side: "RIGHT",
  start_line: null,
  original_start_line: null,
  start_side: null,
  body: inlineBody,
}

test("updates the summary but skips identical inline findings already posted at the same head", () => {
  const { result, root } = runAction({
    MOCK_REVIEW: withFinding,
    MOCK_INLINE_COMMENTS: JSON.stringify([[], [postedFinding]]),
  })
  expect(result.status, result.stderr).toBe(0)
  expect(existsSync(join(root, "summary.json"))).toBe(true)
  expect(existsSync(join(root, "posted.json"))).toBe(false)
})

test("uses the original commit and coordinates when GitHub remaps an existing finding", () => {
  const { result, root } = runAction({
    MOCK_REVIEW: withFinding,
    MOCK_INLINE_COMMENTS: JSON.stringify([
      [{ ...postedFinding, commit_id: base, line: 42, original_line: 1 }],
    ]),
  })
  expect(result.status, result.stderr).toBe(0)
  expect(existsSync(join(root, "summary.json"))).toBe(true)
  expect(existsSync(join(root, "posted.json"))).toBe(false)
})

test.each([
  { original_commit_id: base },
  { user: { login: "other[bot]", type: "Bot" } },
  { body: "A different finding." },
  { original_line: 2 },
])("does not suppress a new inline finding because of a different comment %j", (override) => {
  const { result, json } = runAction({
    MOCK_REVIEW: withFinding,
    MOCK_INLINE_COMMENTS: JSON.stringify([[{ ...postedFinding, ...override }]]),
  })
  expect(result.status, result.stderr).toBe(0)
  expect(json("posted.json").comments).toHaveLength(1)
})

test("does not submit duplicate inline findings in the same batch", () => {
  const { result, json } = runAction({
    MOCK_REVIEW: JSON.stringify({ summary: "One issue found.", findings: [finding, finding] }),
  })
  expect(result.status, result.stderr).toBe(0)
  expect(json("posted.json").comments).toHaveLength(1)
})

test("does not publish a stale summary or inline review if the pull request head changes", () => {
  const { result, root } = runAction({ MOCK_REVIEW: withFinding, MOCK_CURRENT_HEAD: base })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain("head changed")
  expect(existsSync(join(root, "summary.json"))).toBe(false)
  expect(existsSync(join(root, "posted.json"))).toBe(false)
})

test("rejects invalid model output before making comment API requests", () => {
  const { result, root } = runAction({ MOCK_REVIEW: "Not JSON." })
  expect(result.status).toBe(1)
  expect(commands(root).filter((call) => call.command === "gh")).toHaveLength(1)
  expect(existsSync(join(root, "summary.json"))).toBe(false)
  expect(existsSync(join(root, "posted.json"))).toBe(false)
})

test("cleans credentials without writes when listing inline comments fails", () => {
  const { result, root } = runAction({ MOCK_REVIEW: withFinding, MOCK_FAILURE: "list-inline" })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain("mock list-inline failure")
  expect(existsSync(join(root, "summary.json"))).toBe(false)
  expect(existsSync(join(root, "posted.json"))).toBe(false)
})

test("cleans credentials and reports failure if inline submission fails after the summary update", () => {
  const { result, root } = runAction({ MOCK_REVIEW: withFinding, MOCK_FAILURE: "review" })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain("mock review failure")
  expect(existsSync(join(root, "summary.json"))).toBe(true)
  expect(existsSync(join(root, "posted.json"))).toBe(false)
})
