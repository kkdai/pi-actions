import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { afterEach, expect, test } from "vitest"

const script = resolve("triage/triage.mjs")
const defaultPrompt = ".pi/prompts/triage-issue.md"
const issueEndpoint = "repos/owner/repo/issues/42"
const labelsEndpoint = "repos/owner/repo/labels"
const roots: string[] = []
const issue = {
  number: 42,
  title: "The current issue title",
  body: "The current issue body from the API.",
  state: "open",
  labels: [{ name: "keep-me" }],
}
const labels = [
  { name: "bug", description: "Unexpected behavior." },
  { name: "needs docs", description: "Documentation changes." },
  { name: "keep-me", description: "An existing manual label." },
]
const event = {
  action: "opened",
  number: 999,
  issue: { number: 42, title: "Stale payload title", body: "Stale payload body" },
}

type Command = {
  command: string
  args: string[]
  githubToken?: string
  alternateToken?: string
  apiKeyInput?: string
  authJsonInput?: string
}

const mockCommand = String.raw`#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } = require("node:fs");
const { basename, join } = require("node:path");
const env = process.env;
const args = process.argv.slice(2);
const command = basename(process.argv[1]);
appendFileSync(join(env.MOCK_ROOT, "commands.jsonl"), JSON.stringify({
  command, args,
  githubToken: env.GH_TOKEN,
  alternateToken: env.GITHUB_TOKEN,
  apiKeyInput: env.PI_API_KEY,
  authJsonInput: env.PI_AUTH_JSON,
}) + "\n");
function fail(stage) {
  if (env.MOCK_FAILURE === stage) {
    console.error("mock " + stage + " failure");
    process.exit(1);
  }
}
const statePath = join(env.MOCK_ROOT, "issue-state.json");
function currentIssue(latest) {
  return existsSync(statePath)
    ? readFileSync(statePath, "utf8")
    : latest ? env.MOCK_LATEST_ISSUE : env.MOCK_ISSUE;
}
if (command === "gh") {
  const endpoint = args.find(value => value.startsWith("repos/"));
  const methodIndex = args.findIndex(value => value === "--method" || value === "-X");
  const method = methodIndex < 0 ? "GET" : args[methodIndex + 1];
  if (args[0] !== "api") throw new Error("Expected gh api");
  if (method === "GET" && endpoint === "repos/owner/repo/issues/42") {
    const countPath = join(env.MOCK_ROOT, "fetch-count");
    const count = Number(readFileSync(countPath, "utf8")) + 1;
    writeFileSync(countPath, String(count));
    if (count > 2) throw new Error("Unexpected additional issue fetch");
    fail(count === 1 ? "issue" : "latest");
    process.stdout.write(currentIssue(count === 2));
  } else if (method === "GET" && endpoint === "repos/owner/repo/labels") {
    if (!args.includes("--paginate") || !args.includes("--slurp")) {
      throw new Error("Repository labels must use --paginate --slurp");
    }
    fail("labels");
    process.stdout.write(env.MOCK_LABELS);
  } else if (method === "POST" && endpoint === "repos/owner/repo/issues/42/labels") {
    if (!args.includes("--input")) throw new Error("Expected a JSON input file");
    const payload = JSON.parse(readFileSync(args[args.indexOf("--input") + 1], "utf8"));
    fail("post");
    writeFileSync(join(env.MOCK_ROOT, "posted.json"), JSON.stringify(payload));
    const latest = JSON.parse(currentIssue(true));
    latest.labels = [...latest.labels, ...payload.labels.map(name => ({ name }))];
    writeFileSync(statePath, JSON.stringify(latest));
    console.log(JSON.stringify(latest.labels));
  } else {
    throw new Error("Unexpected GitHub request: " + JSON.stringify(args));
  }
} else if (command === "pi") {
  const directory = env.PI_CODING_AGENT_DIR;
  const modelPath = join(directory, "models.json");
  const attachmentPath = args.find(value => value.startsWith("@")).slice(1);
  writeFileSync(join(env.MOCK_ROOT, "pi.json"), JSON.stringify({
    args,
    cwd: process.cwd(),
    directory,
    auth: JSON.parse(readFileSync(join(directory, "auth.json"), "utf8")),
    mode: statSync(join(directory, "auth.json")).mode & 0o777,
    models: existsSync(modelPath) ? JSON.parse(readFileSync(modelPath, "utf8")) : null,
    attachmentPath,
    attachment: JSON.parse(readFileSync(attachmentPath, "utf8")),
    githubToken: env.GH_TOKEN,
    alternateToken: env.GITHUB_TOKEN,
    apiKeyInput: env.PI_API_KEY,
    authJsonInput: env.PI_AUTH_JSON,
  }));
  fail("pi");
  process.stdout.write(env.MOCK_SELECTION);
} else {
  throw new Error("Unexpected executable: " + command);
}
`

function method(call: Command) {
  const index = call.args.findIndex((value) => value === "--method" || value === "-X")
  return index < 0 ? "GET" : call.args[index + 1]
}

function endpoint(call: Command) {
  return call.args.find((value) => value.startsWith("repos/"))
}

function stages(calls: Command[]) {
  return calls.map((call) => (call.command === "pi" ? "pi" : `${method(call)} ${endpoint(call)}`))
}

const classified = [`GET ${issueEndpoint}`, `GET ${labelsEndpoint}`, "pi"]
const refreshed = [...classified, `GET ${issueEndpoint}`]

function runAction(
  overrides: Record<string, string> = {},
  options: { event?: unknown; promptPath?: string } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "pi-triage-test-"))
  roots.push(root)
  const workspace = join(root, "workspace")
  const runner = join(root, "runner")
  const bin = join(root, "bin")
  for (const directory of [workspace, runner, bin]) mkdirSync(directory)
  for (const command of ["gh", "pi"]) {
    writeFileSync(join(bin, command), mockCommand, { mode: 0o755 })
  }
  const eventPath = join(root, "event.json")
  writeFileSync(eventPath, JSON.stringify(options.event ?? event))
  if (options.promptPath) {
    const fullPath = join(workspace, options.promptPath)
    mkdirSync(resolve(fullPath, ".."), { recursive: true })
    writeFileSync(fullPath, "Custom issue triage instructions.")
  }
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    GH_TOKEN: "github-token",
    GITHUB_TOKEN: "alternate-github-token",
    GITHUB_EVENT_NAME: "issues",
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_REPOSITORY: "owner/repo",
    GITHUB_WORKSPACE: workspace,
    RUNNER_TEMP: runner,
    PI_CODING_AGENT_DIR: join(root, "inherited-agent"),
    PI_PROVIDER: "openai",
    PI_MODEL: "gpt-6.1-sol",
    PI_API_KEY: "test-api-key",
    PI_AUTH_JSON: "",
    PI_BASE_URL: "",
    PI_THINKING: "",
    PI_PROMPT: "",
    MOCK_ROOT: root,
    MOCK_FAILURE: "",
    MOCK_ISSUE: JSON.stringify(issue),
    MOCK_LATEST_ISSUE: JSON.stringify(issue),
    MOCK_LABELS: JSON.stringify([[labels[0]], [], labels.slice(1)]),
    MOCK_SELECTION: JSON.stringify({ labels: ["bug", "needs docs"] }),
    ...overrides,
  }
  const json = (name: string) => JSON.parse(readFileSync(join(root, name), "utf8"))
  function invoke() {
    for (const name of ["commands.jsonl", "pi.json", "posted.json"]) {
      rmSync(join(root, name), { force: true })
    }
    writeFileSync(join(root, "fetch-count"), "0")
    const result = spawnSync(process.execPath, [script], {
      cwd: workspace,
      encoding: "utf8",
      timeout: 15_000,
      env,
    })
    expect(result.error).toBeUndefined()
    expect(readdirSync(runner)).toEqual([])
    const calls: Command[] = existsSync(join(root, "commands.jsonl"))
      ? readFileSync(join(root, "commands.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : []
    for (const call of calls) {
      expect(call.apiKeyInput).toBeUndefined()
      expect(call.authJsonInput).toBeUndefined()
      if (call.command === "pi") {
        expect(call.githubToken).toBeUndefined()
        expect(call.alternateToken).toBeUndefined()
      } else {
        // No test run may replace labels, remove labels, or write comments.
        expect(call.command).toBe("gh")
        expect(["GET", "POST"]).toContain(method(call))
        if (method(call) === "POST") {
          expect(endpoint(call)).toBe(`${issueEndpoint}/labels`)
          const input = call.args[call.args.indexOf("--input") + 1]
          expect(input.startsWith(`${runner}${sep}`)).toBe(true)
        } else {
          expect([issueEndpoint, labelsEndpoint]).toContain(endpoint(call))
        }
      }
    }
    const pi = existsSync(join(root, "pi.json")) ? json("pi.json") : undefined
    if (pi) {
      expect(pi.mode).toBe(0o600)
      expect(pi.cwd).toBe(pi.directory)
      expect(pi.directory.startsWith(`${runner}${sep}`)).toBe(true)
      expect(pi.attachmentPath.startsWith(`${runner}${sep}`)).toBe(true)
      expect(existsSync(pi.directory)).toBe(false)
      expect(Object.keys(pi.auth)).toEqual([env.PI_PROVIDER.trim()])
    }
    const posted = existsSync(join(root, "posted.json")) ? json("posted.json") : undefined
    return { result, root, workspace, calls, pi, posted }
  }
  return { ...invoke(), rerun: invoke }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test("classifies the live issue with isolated API key auth and the bundled prompt", () => {
  const { result, calls, pi, posted } = runAction()
  expect(result.status, result.stderr).toBe(0)
  expect(stages(calls)).toEqual([...refreshed, `POST ${issueEndpoint}/labels`])
  expect(pi.auth).toEqual({ openai: { type: "api_key", key: "test-api-key" } })
  expect(pi.models).toBeNull()
  expect(pi.attachment).toEqual({
    issue: { title: issue.title, body: issue.body },
    labels,
  })
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
    ]),
  )
  for (const [option, value] of [
    ["--provider", "openai"],
    ["--model", "gpt-6.1-sol"],
    ["--thinking", "medium"],
    ["--system-prompt", resolve(defaultPrompt)],
  ]) {
    expect(pi.args[pi.args.indexOf(option) + 1]).toBe(value)
  }
  expect(posted).toEqual({ labels: ["bug", "needs docs"] })
})

test("keeps quoted issue content and label names in JSON files, not command arguments", () => {
  const quotedIssue = {
    ...issue,
    title: 'Failure in "quoted" input: $(touch injected)',
    body: '```sh\nprintf "%s" "$HOME"\n```\n::error::untrusted issue text\n',
  }
  const quotedLabel = { name: 'needs "docs", please', description: "A quoted label name." }
  const { result, calls, pi, posted, workspace } = runAction({
    MOCK_ISSUE: JSON.stringify(quotedIssue),
    MOCK_LATEST_ISSUE: JSON.stringify(quotedIssue),
    MOCK_LABELS: JSON.stringify([[quotedLabel]]),
    MOCK_SELECTION: JSON.stringify({ labels: [quotedLabel.name] }),
  })
  expect(result.status, result.stderr).toBe(0)
  expect(pi.attachment).toEqual({
    issue: { title: quotedIssue.title, body: quotedIssue.body },
    labels: [quotedLabel],
  })
  expect(posted).toEqual({ labels: [quotedLabel.name] })
  const argumentsJson = JSON.stringify(calls.map((call) => call.args))
  for (const content of [quotedIssue.title, quotedIssue.body, quotedLabel.name]) {
    expect(argumentsJson).not.toContain(JSON.stringify(content).slice(1, -1))
  }
  expect(existsSync(join(workspace, "injected"))).toBe(false)
})

test("the bundled prompt lists only the four automatic issue-type labels", () => {
  const { result, pi } = runAction({ MOCK_SELECTION: '{"labels":["bug"]}' })
  expect(result.status, result.stderr).toBe(0)
  const promptPath = pi.args[pi.args.indexOf("--system-prompt") + 1]
  const prompt = readFileSync(promptPath, "utf8")
  const supported = [...prompt.matchAll(/^- `([^`]+)`:/gm)].map((match) => match[1])
  expect(supported).toEqual(["bug", "documentation", "enhancement", "question"])
})

test.each(["opened", "edited", "reopened"])("accepts the %s issue activity", (action) => {
  const { result, posted } = runAction({}, { event: { action, issue: { number: 42 } } })
  expect(result.status, result.stderr).toBe(0)
  expect(posted).toEqual({ labels: ["bug", "needs docs"] })
})

test.each(["closed", "labeled", "unlabeled", "deleted", undefined])(
  "skips activity %s without invoking commands",
  (action) => {
    const { result, calls } = runAction({}, { event: { ...event, action } })
    expect(result.status, result.stderr).toBe(0)
    expect(calls).toEqual([])
  },
)

test.each(["pull_request", "pull_request_target", "push", ""])(
  "rejects event name %j before invoking commands",
  (name) => {
    const { result, calls } = runAction({ GITHUB_EVENT_NAME: name })
    expect(result.status).toBe(1)
    expect(calls).toEqual([])
  },
)

test.each([undefined, null, 0, -1, 1.5, "42", true, Number.MAX_SAFE_INTEGER + 1])(
  "rejects issue number %j instead of using event.number",
  (number) => {
    const { result, calls } = runAction({}, { event: { ...event, number: 42, issue: { number } } })
    expect(result.status).toBe(1)
    expect(calls).toEqual([])
  },
)

test.each([{}, { issue: null }])("rejects a missing issue in %j", (payload) => {
  const { result, calls } = runAction({}, { event: { action: "opened", number: 42, ...payload } })
  expect(result.status).toBe(1)
  expect(calls).toEqual([])
})

test("rejects a pull request in the event before invoking commands", () => {
  const { result, calls } = runAction(
    {},
    { event: { ...event, issue: { number: 42, pull_request: { url: "https://example.com/pr" } } } },
  )
  expect(result.status).toBe(1)
  expect(calls).toEqual([])
})

test("skips a currently closed issue without Pi or writes", () => {
  const { result, calls, pi, posted } = runAction({
    MOCK_ISSUE: JSON.stringify({ ...issue, state: "closed" }),
  })
  expect(result.status, result.stderr).toBe(0)
  expect(stages(calls)[0]).toBe(`GET ${issueEndpoint}`)
  expect(calls.every((call) => call.command === "gh" && method(call) === "GET")).toBe(true)
  expect(pi).toBeUndefined()
  expect(posted).toBeUndefined()
})

test("rejects a pull request returned by the initial issue fetch", () => {
  const { result, pi, posted } = runAction({
    MOCK_ISSUE: JSON.stringify({ ...issue, pull_request: { url: "https://example.com/pr" } }),
  })
  expect(result.status).toBe(1)
  expect(pi).toBeUndefined()
  expect(posted).toBeUndefined()
})

test.each([
  ["malformed JSON", "Not JSON."],
  ["null response", "null"],
  ["array response", "[]"],
  ["wrong issue number", JSON.stringify({ ...issue, number: 43 })],
  ["non-string title", JSON.stringify({ ...issue, title: null })],
  ["non-string body", JSON.stringify({ ...issue, body: 7 })],
  ["missing body", JSON.stringify({ ...issue, body: undefined })],
  ["invalid state", JSON.stringify({ ...issue, state: "deleted" })],
  ["missing labels", JSON.stringify({ ...issue, labels: undefined })],
  ["non-array labels", JSON.stringify({ ...issue, labels: {} })],
  ["null label", JSON.stringify({ ...issue, labels: [null] })],
  ["non-object label", JSON.stringify({ ...issue, labels: ["bug"] })],
  ["non-string label name", JSON.stringify({ ...issue, labels: [{ name: 7 }] })],
])("rejects %s from both issue fetches without writing", (_name, response) => {
  for (const input of ["MOCK_ISSUE", "MOCK_LATEST_ISSUE"]) {
    const { result, calls, pi, posted } = runAction({ [input]: response })
    expect(result.status).toBe(1)
    expect(stages(calls)).toEqual(input === "MOCK_ISSUE" ? [`GET ${issueEndpoint}`] : refreshed)
    if (input === "MOCK_ISSUE") expect(pi).toBeUndefined()
    expect(posted).toBeUndefined()
  }
})

test("normalizes a null live issue body to an empty attachment string", () => {
  const emptyBodyIssue = JSON.stringify({ ...issue, body: null })
  const { result, pi } = runAction({
    MOCK_ISSUE: emptyBodyIssue,
    MOCK_LATEST_ISSUE: emptyBodyIssue,
  })
  expect(result.status, result.stderr).toBe(0)
  expect(pi.attachment.issue).toEqual({ title: issue.title, body: "" })
})

test("normalizes a null label description in the classification input", () => {
  const { result, pi, posted } = runAction({
    MOCK_LABELS: JSON.stringify([[{ name: "bug", description: null }]]),
    MOCK_SELECTION: '{"labels":["bug"]}',
  })
  expect(result.status, result.stderr).toBe(0)
  expect(pi.attachment.labels).toEqual([{ name: "bug", description: "" }])
  expect(posted).toEqual({ labels: ["bug"] })
})

test("skips Pi and writes when all repository label pages are empty", () => {
  const { result, calls, pi, posted } = runAction({ MOCK_LABELS: "[[],[]]" })
  expect(result.status, result.stderr).toBe(0)
  expect(stages(calls)).toEqual([`GET ${issueEndpoint}`, `GET ${labelsEndpoint}`])
  expect(pi).toBeUndefined()
  expect(posted).toBeUndefined()
})

test.each([
  ["malformed JSON", "Not JSON."],
  ["non-array pages", "{}"],
  ["non-array page", "[{}]"],
  ["null label", "[[null]]"],
  ["non-object label", '[["bug"]]'],
  ["missing label name", "[[{}]]"],
  ["blank label name", JSON.stringify([[{ name: "  " }]])],
  ["non-string label name", JSON.stringify([[{ name: 7 }]])],
  ["non-string description", JSON.stringify([[{ name: "bug", description: 7 }]])],
])("rejects repository labels with %s before Pi or writes", (_name, response) => {
  const { result, calls, pi, posted } = runAction({ MOCK_LABELS: response })
  expect(result.status).toBe(1)
  expect(stages(calls)).toEqual([`GET ${issueEndpoint}`, `GET ${labelsEndpoint}`])
  expect(pi).toBeUndefined()
  expect(posted).toBeUndefined()
})

test("accepts an empty selection without refreshing or writing the issue", () => {
  const { result, calls, posted } = runAction({ MOCK_SELECTION: '{"labels":[]}' })
  expect(result.status, result.stderr).toBe(0)
  expect(stages(calls)).toEqual(classified)
  expect(posted).toBeUndefined()
})

test("deduplicates names and adds only labels missing from the refreshed issue", () => {
  const { result, calls, posted } = runAction({
    MOCK_SELECTION: '\n{"labels":["bug","needs docs","bug","needs docs"]}\n',
    MOCK_LATEST_ISSUE: JSON.stringify({
      ...issue,
      labels: [...issue.labels, { name: "bug" }, { name: "new manual label" }],
    }),
  })
  expect(result.status, result.stderr).toBe(0)
  expect(stages(calls)).toEqual([...refreshed, `POST ${issueEndpoint}/labels`])
  expect(posted).toEqual({ labels: ["needs docs"] })
})

test("deduplicates selected labels before a POST", () => {
  const { result, posted } = runAction({
    MOCK_SELECTION: '{"labels":["bug","bug","needs docs","bug"]}',
  })
  expect(result.status, result.stderr).toBe(0)
  expect(posted).toEqual({ labels: ["bug", "needs docs"] })
})

test("does not write when all selected labels are already present at refresh", () => {
  const { result, calls, posted } = runAction({
    MOCK_LATEST_ISSUE: JSON.stringify({
      ...issue,
      labels: [...issue.labels, { name: "bug" }, { name: "needs docs" }],
    }),
  })
  expect(result.status, result.stderr).toBe(0)
  expect(stages(calls)).toEqual(refreshed)
  expect(posted).toBeUndefined()
})

test("does not add the same selected labels on repeated runs", () => {
  const first = runAction()
  expect(first.result.status, first.result.stderr).toBe(0)
  expect(first.posted).toEqual({ labels: ["bug", "needs docs"] })
  const second = first.rerun()
  expect(second.result.status, second.result.stderr).toBe(0)
  expect(stages(second.calls)).toEqual(refreshed)
  expect(second.posted).toBeUndefined()
})

test.each([
  ["title changed", { ...issue, title: "A new title" }],
  ["body changed", { ...issue, body: "A new body" }],
  ["closed", { ...issue, state: "closed" }],
  ["became a pull request", { ...issue, pull_request: { url: "https://example.com/pr" } }],
])("does not write when the refreshed issue %s", (_name, latest) => {
  const { result, calls, posted } = runAction({ MOCK_LATEST_ISSUE: JSON.stringify(latest) })
  expect(result.status).toBe(1)
  expect(stages(calls)).toEqual(refreshed)
  expect(posted).toBeUndefined()
})

test.each([
  ["empty output", ""],
  ["malformed JSON", "Not JSON."],
  ["fenced JSON", '```json\n{"labels":["bug"]}\n```'],
  ["trailing prose", '{"labels":["bug"]}\nDone.'],
  ["array root", '["bug"]'],
  ["null root", "null"],
  ["missing labels", "{}"],
  ["extra key", '{"labels":["bug"],"reason":"A bug."}'],
  ["non-array labels", '{"labels":"bug"}'],
  ["non-string label", '{"labels":["bug",7]}'],
  ["null label", '{"labels":[null]}'],
  ["object label", '{"labels":[{"name":"bug"}]}'],
  ["unknown label", '{"labels":["bug","not-in-repository"]}'],
  ["wrong case", '{"labels":["Bug"]}'],
  ["extra name whitespace", '{"labels":[" bug "]}'],
])("rejects %s from Pi before refreshing or writing", (_name, selection) => {
  const { result, calls, posted } = runAction({ MOCK_SELECTION: selection })
  expect(result.status).toBe(1)
  expect(stages(calls)).toEqual(classified)
  expect(posted).toBeUndefined()
})

test("loads only the selected OAuth credential from auth-json", () => {
  const credential = {
    type: "oauth",
    access: "access-token",
    refresh: "refresh-token",
    expires: 9999999999999,
  }
  const { result, pi } = runAction({
    PI_API_KEY: "",
    PI_AUTH_JSON: JSON.stringify({
      openai: credential,
      "unused-provider": { type: "api_key", key: "unused-key" },
    }),
  })
  expect(result.status, result.stderr).toBe(0)
  expect(pi.auth).toEqual({ openai: credential })
  expect(result.stdout).toContain("::add-mask::access-token")
  expect(result.stdout).toContain("::add-mask::refresh-token")
  expect(result.stdout + result.stderr).not.toContain("unused-key")
})

test("loads only the selected API key credential from auth-json", () => {
  const credential = { type: "api_key", key: "stored-api-key" }
  const { result, pi } = runAction({
    PI_API_KEY: "",
    PI_AUTH_JSON: JSON.stringify({
      openai: credential,
      "unused-provider": { type: "api_key", key: "unused-key" },
    }),
  })
  expect(result.status, result.stderr).toBe(0)
  expect(pi.auth).toEqual({ openai: credential })
})

test.each(["off", "minimal", "low", "medium", "high", "xhigh", "max"])(
  "passes thinking=%s to Pi",
  (thinking) => {
    const { result, pi } = runAction({ PI_THINKING: thinking })
    expect(result.status, result.stderr).toBe(0)
    expect(pi.args[pi.args.indexOf("--thinking") + 1]).toBe(thinking)
  },
)

test.each(["https://proxy.example.com/v1", "http://127.0.0.1:8080/v1"])(
  "sets base-url=%s without replacing the model catalog",
  (baseUrl) => {
    const { result, pi } = runAction({ PI_BASE_URL: baseUrl })
    expect(result.status, result.stderr).toBe(0)
    expect(pi.models).toEqual({ providers: { openai: { baseUrl } } })
  },
)

test.each(["custom triage prompt.md", defaultPrompt])("uses the workspace prompt %s", (prompt) => {
  const { result, pi, workspace } = runAction({ PI_PROMPT: prompt }, { promptPath: prompt })
  expect(result.status, result.stderr).toBe(0)
  expect(pi.args[pi.args.indexOf("--system-prompt") + 1]).toBe(join(workspace, prompt))
})

const invalidInputs: [string, Record<string, string>][] = [
  ["missing credentials", { PI_API_KEY: "" }],
  ["both credential inputs", { PI_AUTH_JSON: "{}" }],
  ["malformed auth-json", { PI_API_KEY: "", PI_AUTH_JSON: "invalid-secret-json" }],
  ["missing selected credential", { PI_API_KEY: "", PI_AUTH_JSON: "{}" }],
  [
    "unsupported credential type",
    { PI_API_KEY: "", PI_AUTH_JSON: '{"openai":{"type":"password","key":"secret"}}' },
  ],
  [
    "empty stored API key",
    { PI_API_KEY: "", PI_AUTH_JSON: '{"openai":{"type":"api_key","key":""}}' },
  ],
  [
    "non-string stored API key",
    { PI_API_KEY: "", PI_AUTH_JSON: '{"openai":{"type":"api_key","key":123}}' },
  ],
  ["missing provider", { PI_PROVIDER: "" }],
  ["missing model", { PI_MODEL: "" }],
  ["invalid thinking level", { PI_THINKING: "invalid" }],
  ["non-HTTP base URL", { PI_BASE_URL: "file:///tmp/model" }],
  ["malformed base URL", { PI_BASE_URL: "not a URL" }],
  ["missing custom prompt", { PI_PROMPT: "missing.md" }],
]

test.each(invalidInputs)("rejects %s before invoking commands", (_name, overrides) => {
  const { result, calls } = runAction(overrides)
  expect(result.status).toBe(1)
  expect(result.stderr).not.toContain("invalid-secret-json")
  expect(calls).toEqual([])
})

test.each([
  ["issue", [`GET ${issueEndpoint}`]],
  ["labels", [`GET ${issueEndpoint}`, `GET ${labelsEndpoint}`]],
  ["pi", classified],
  ["latest", refreshed],
  ["post", [...refreshed, `POST ${issueEndpoint}/labels`]],
])("cleans credentials and stops after a %s command failure", (stage, expected) => {
  const { result, calls, posted } = runAction({ MOCK_FAILURE: stage })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain(`mock ${stage} failure`)
  expect(result.stderr).not.toContain("test-api-key")
  expect(stages(calls)).toEqual(expected)
  expect(posted).toBeUndefined()
})
