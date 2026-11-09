import { spawnSync } from "node:child_process"
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve, sep } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

const roots: string[] = []
const original = {
  type: "oauth",
  access: "handoff-old-access",
  refresh: "handoff-old-refresh",
  expires: 1_900_000_000_000,
  accountId: "synthetic-account",
  metadata: { tenant: "synthetic-tenant" },
}
const rotated = {
  ...original,
  access: "handoff-new-access",
  refresh: "handoff-new-refresh",
  expires: original.expires + 3_600_000,
  metadata: { tenant: "synthetic-new-tenant" },
}
const auth = {
  openai: original,
  anthropic: { type: "api_key", key: "handoff-other-key", metadata: { keep: true } },
  custom: { type: "api_key", env: { CUSTOM_KEY: "handoff-env-key" }, extra: ["preserve"] },
  secondary: { ...original, accountId: "other-account" },
}
const regularToken = "handoff-regular-github-token"
const writerToken = "handoff-writer-token"
const neverStored = ["handoff-never-stored-access", "handoff-never-stored-refresh"]
const head = "b".repeat(40)
const issue = {
  number: 42,
  title: "Synthetic issue",
  body: "Synthetic body",
  state: "open",
  labels: [],
}

type Call = {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  handoff?: unknown
}
type PiRecord = {
  directory: string
  cwd: string
  mode: number
  directoryMode: number
  auth: unknown
  attachment: string
  attachmentPath: string
}

// All commands and credentials are synthetic. The subprocesses write only inside a test root.
const mockCommand = String.raw`#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } = require("node:fs");
const { basename, join } = require("node:path");
const env = process.env;
const args = process.argv.slice(2);
const command = basename(process.argv[1]);
const tracked = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "PAT_TOKEN", "PI_AUTH_TOKEN", "PI_AUTH_SECRET", "PI_AUTH_ENVIRONMENT", "PI_AUTH_OUTPUT", "PI_AUTH_JSON", "PI_API_KEY"];
let handoff;
try { handoff = JSON.parse(readFileSync(env.MOCK_HANDOFF, "utf8")); } catch {}
appendFileSync(join(env.MOCK_ROOT, "calls.jsonl"), JSON.stringify({
  command, args, cwd: process.cwd(), handoff,
  env: Object.fromEntries(tracked.filter(key => key in env).map(key => [key, env[key]])),
}) + "\n");
function fail(stage) {
  if (env.MOCK_FAILURE === stage) {
    console.error("mock " + stage + " failure " + env.MOCK_DIAGNOSTIC);
    process.exit(1);
  }
}
if (command === "pi") {
  const directory = env.PI_CODING_AGENT_DIR;
  const authPath = join(directory, "auth.json");
  const attachmentPath = args.find(value => value.startsWith("@")).slice(1);
  writeFileSync(join(env.MOCK_ROOT, "pi.json"), JSON.stringify({
    directory, cwd: process.cwd(), attachmentPath,
    mode: statSync(authPath).mode & 0o777,
    directoryMode: statSync(directory).mode & 0o777,
    auth: JSON.parse(readFileSync(authPath, "utf8")),
    attachment: readFileSync(attachmentPath, "utf8"),
  }));
  if (env.MOCK_AUTH_UPDATE === "missing") rmSync(authPath);
  else if (env.MOCK_AUTH_UPDATE === "directory") { rmSync(authPath); require("node:fs").mkdirSync(authPath); }
  else if (env.MOCK_AUTH_UPDATE !== "unchanged") writeFileSync(authPath, env.MOCK_AUTH_UPDATE);
  process.stderr.write(env.MOCK_PI_STDERR || "");
  if (env.MOCK_FAILURE === "pi") process.stdout.write(env.MOCK_DIAGNOSTIC);
  fail("pi");
  process.stdout.write(env.MOCK_OUTPUT);
} else if (command === "gh") {
  const endpoint = args.find(value => value.startsWith("repos/")) || "";
  const methodIndex = args.findIndex(value => value === "--method" || value === "-X");
  const method = methodIndex < 0 ? "GET" : args[methodIndex + 1];
  if (args[0] === "secret" || endpoint.includes("/environments/")) {
    if (env.MOCK_PERSIST !== "1") throw new Error("Producer must not access GitHub secrets");
    if (args[0] === "secret") {
      fail("save");
      writeFileSync(join(env.MOCK_ROOT, "saved-auth.json"), readFileSync(0, "utf8"));
    } else console.log(JSON.stringify({ name: "PI_AUTH_JSON" }));
  } else if (method !== "GET") {
    fail("publish");
    writeFileSync(join(env.MOCK_ROOT, "published.json"), readFileSync(args[args.indexOf("--input") + 1], "utf8"));
    console.log(JSON.stringify({ id: 1, html_url: "https://github.com/owner/repo/issues/42#issuecomment-1" }));
  } else if (endpoint.includes("/compare/")) {
    fail("before-pi");
    process.stdout.write("diff --git a/example.ts b/example.ts\n--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-old\n+new\n");
  } else if (args[1] === "graphql") {
    console.log(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: {
      nodes: [], pageInfo: { hasNextPage: false, endCursor: null },
    } } } } }));
  } else if (endpoint.endsWith("/comments")) {
    console.log("[[]]");
  } else if (endpoint.endsWith("/pulls/42")) {
    fail("state");
    process.stdout.write(env.MOCK_CHANGED_STATE === "1" ? "c".repeat(40) : env.MOCK_HEAD);
  } else if (endpoint.endsWith("/issues/42")) {
    const afterPi = existsSync(join(env.MOCK_ROOT, "pi.json"));
    fail(afterPi ? "state" : "before-pi");
    const issue = JSON.parse(env.MOCK_ISSUE);
    if (afterPi && env.MOCK_CHANGED_STATE === "1") issue.state = "closed";
    console.log(JSON.stringify(issue));
  } else if (endpoint.endsWith("/labels")) {
    console.log(env.MOCK_LABELS);
  } else {
    throw new Error("Unexpected mock request: " + JSON.stringify(args));
  }
} else {
  throw new Error("Unexpected executable: " + command);
}
`

function createRoot() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-handoff-test-")))
  roots.push(root)
  return root
}

type Fixture = { root: string; runner: string; target: string }
function fixture(): Fixture {
  const root = createRoot()
  const runner = join(root, "runner")
  mkdirSync(runner)
  return { root, runner, target: join(runner, "handoff", "auth.json") }
}

function runAction(
  action: string,
  overrides: Record<string, string> = {},
  setup = fixture(),
  distribution?: string,
) {
  const { root, runner, target } = setup
  const workspace = join(root, "workspace")
  const bin = join(root, "bin")
  for (const path of [workspace, bin]) mkdirSync(path)
  for (const command of ["gh", "pi"])
    writeFileSync(join(bin, command), mockCommand, { mode: 0o755 })
  const actionPath = distribution ? join(distribution, action) : resolve(action)
  const manifest = readFileSync(join(actionPath, "action.yml"), "utf8")
  const runCommand = manifest.match(/^ {6}run: (node .+)$/m)?.[1]
  expect(runCommand).toBeDefined()
  const eventPath = join(root, "event.json")
  writeFileSync(
    eventPath,
    JSON.stringify(
      action === "review"
        ? { number: 42, pull_request: { base: { sha: "a".repeat(40) }, head: { sha: head } } }
        : { action: overrides.MOCK_ACTIVITY ?? "opened", issue },
    ),
  )
  const result = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", runCommand ?? "exit 1"],
    {
      cwd: workspace,
      encoding: "utf8",
      timeout: 300_000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GH_TOKEN: regularToken,
        GITHUB_TOKEN: "handoff-alternate-github-token",
        GH_ENTERPRISE_TOKEN: "handoff-enterprise-token",
        GITHUB_ENTERPRISE_TOKEN: "handoff-alternate-enterprise-token",
        PAT_TOKEN: "",
        GITHUB_ACTION_PATH: actionPath,
        GITHUB_EVENT_NAME: action === "review" ? "pull_request" : "issues",
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_REPOSITORY: "owner/repo",
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_WORKSPACE: workspace,
        GITHUB_OUTPUT: join(root, "action-output"),
        RUNNER_TEMP: runner,
        PI_CODING_AGENT_DIR: join(root, "ignored-inherited-agent"),
        PI_PROVIDER: "openai",
        PI_MODEL: "synthetic-model",
        PI_PULL_REQUEST: "",
        PI_API_KEY: "",
        PI_AUTH_JSON: JSON.stringify(auth),
        PI_AUTH_SECRET: "",
        PI_AUTH_ENVIRONMENT: "",
        PI_AUTH_TOKEN: "",
        PI_AUTH_OUTPUT: target,
        PI_BASE_URL: "",
        PI_THINKING: "medium",
        PI_PROMPT: "",
        MOCK_ROOT: root,
        MOCK_HANDOFF: target,
        MOCK_FAILURE: "",
        MOCK_CHANGED_STATE: "",
        MOCK_HEAD: head,
        MOCK_ISSUE: JSON.stringify(issue),
        MOCK_LABELS: JSON.stringify([[{ name: "bug", description: "Synthetic label" }]]),
        MOCK_AUTH_UPDATE: JSON.stringify({ openai: rotated }),
        MOCK_OUTPUT: JSON.stringify(
          action === "review" ? { summary: "Synthetic review", findings: [] } : { labels: ["bug"] },
        ),
        MOCK_PI_STDERR: "",
        MOCK_DIAGNOSTIC: "",
        ...overrides,
      },
    },
  )
  expect(result.error).toBeUndefined()
  const read = (name: string) =>
    existsSync(join(root, name)) ? readFileSync(join(root, name), "utf8") : undefined
  const calls: Call[] = (read("calls.jsonl") ?? "")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const pi: PiRecord | undefined = read("pi.json") ? JSON.parse(read("pi.json") ?? "") : undefined
  // Handoff directories can remain. Only isolated runtime directories and request files must be removed.
  for (const directory of new Set([pi?.directory, ...calls.map((call) => call.cwd)])) {
    if (directory?.startsWith(`${runner}${sep}`))
      expect(existsSync(directory), directory).toBe(false)
  }
  if (pi) expect(existsSync(pi.attachmentPath)).toBe(false)
  expect(
    readdirSync(runner).filter((name) => name.startsWith("pi-action-")),
    "isolated runtime directories must be removed even without Pi",
  ).toEqual([])
  return {
    result,
    calls,
    pi,
    ...setup,
    output: read("action-output") ?? "",
    published: read("published.json"),
    logs: `${result.stdout}\n${result.stderr}`,
  }
}

function consumeHandoff(run: ReturnType<typeof runAction>, failure = "") {
  const actionPath = resolve("persist-auth")
  const manifest = readFileSync(join(actionPath, "action.yml"), "utf8")
  const command = manifest.match(/^ {6}run: (node .+)$/m)?.[1]
  const result = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", command ?? "exit 1"],
    {
      cwd: join(run.root, "workspace"),
      encoding: "utf8",
      timeout: 15_000,
      env: {
        ...process.env,
        PATH: `${join(run.root, "bin")}:${process.env.PATH}`,
        GITHUB_ACTION_PATH: actionPath,
        GITHUB_REPOSITORY: "owner/repo",
        GITHUB_SERVER_URL: "https://github.com",
        RUNNER_TEMP: run.runner,
        PI_AUTH_FILE: run.target,
        PI_AUTH_JSON: JSON.stringify(auth),
        PI_AUTH_TOKEN: writerToken,
        PI_AUTH_ENVIRONMENT: "pi-oauth",
        PI_AUTH_SECRET: "PI_AUTH_JSON",
        PAT_TOKEN: writerToken,
        MOCK_ROOT: run.root,
        MOCK_HANDOFF: run.target,
        MOCK_FAILURE: failure,
        MOCK_DIAGNOSTIC: "",
        MOCK_PERSIST: "1",
      },
    },
  )
  expect(result.error).toBeUndefined()
  expect(existsSync(run.target)).toBe(false)
  const calls: Call[] = readFileSync(join(run.root, "calls.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  for (const call of calls.slice(run.calls.length))
    expect(call.env).toEqual({ GH_TOKEN: writerToken })
  for (const value of [
    writerToken,
    original.access,
    original.refresh,
    rotated.access,
    rotated.refresh,
  ]) {
    expect(normalLogs(result.stdout + result.stderr)).not.toContain(value)
  }
  return result
}

function normalLogs(logs: string) {
  return logs
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("::add-mask::"))
    .join("\n")
}
function isPublication(call: Call) {
  return (
    call.command === "gh" &&
    call.args.some((arg) => ["POST", "PATCH", "PUT", "DELETE"].includes(arg))
  )
}
function expectSafe(run: ReturnType<typeof runAction>) {
  const publicData = [
    normalLogs(run.logs),
    run.output,
    run.published ?? "",
    run.pi?.attachment ?? "",
    JSON.stringify(run.calls.map((call) => call.args)),
  ].join("\n")
  for (const value of [
    regularToken,
    writerToken,
    "handoff-alternate-github-token",
    "handoff-enterprise-token",
    "handoff-alternate-enterprise-token",
    original.access,
    original.refresh,
    rotated.access,
    rotated.refresh,
    auth.anthropic.key,
    auth.custom.env.CUSTOM_KEY,
    ...neverStored,
  ])
    expect(publicData, `credential must not be exposed: ${value}`).not.toContain(value)
  expect(run.output, "handoff JSON must not be an action output").toBe("")
  for (const call of run.calls) {
    expect(call.args[0]).not.toBe("secret")
    expect(call.args.some((arg) => arg.includes("/environments/"))).toBe(false)
    expect(Object.values(call.env)).not.toContain(writerToken)
    if (call.command === "pi") expect(call.env).toEqual({})
  }
  // Never-stored credentials cannot be made safe by issuing add-mask commands after a failed refresh.
  for (const value of neverStored) expect(run.logs).not.toContain(value)
}
function expectFailure(
  run: ReturnType<typeof runAction>,
  message = /auth|oauth|credential|handoff|output|path|temp|file|directory/i,
) {
  expect(run.result.status, run.logs).toBe(1)
  expect(normalLogs(run.logs)).toMatch(message)
  expectSafe(run)
}
function copyDistribution(action: string) {
  const directory = join(createRoot(), "action distribution with spaces")
  for (const path of ["dist", "package.json", ".pi/prompts", action]) {
    cpSync(resolve(path), join(directory, path), { recursive: true })
  }
  expect(readdirSync(directory).sort()).toEqual([".pi", action, "dist", "package.json"].sort())
  return directory
}
function expectHandoff(
  run: ReturnType<typeof runAction>,
  expected: unknown = { ...auth, openai: rotated },
) {
  expect(existsSync(run.target), "producer must retain a valid OAuth handoff").toBe(true)
  expect(lstatSync(run.target).isFile()).toBe(true)
  expect(lstatSync(run.target).isSymbolicLink()).toBe(false)
  expect(statSync(run.target).mode & 0o777).toBe(0o600)
  expect(statSync(dirname(run.target)).mode & 0o777).toBe(0o700)
  expect(JSON.parse(readFileSync(run.target, "utf8"))).toEqual(expected)
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const invalidDocuments: [string, string][] = [
  ["missing auth", ""],
  ["malformed JSON", "{"],
  ["null map", "null"],
  ["array map", "[]"],
  ["empty map", "{}"],
  ["no OAuth", JSON.stringify({ openai: auth.anthropic })],
  ["selected API key despite another OAuth", JSON.stringify({ ...auth, openai: auth.anthropic })],
  ["missing selected provider", JSON.stringify({ secondary: original })],
  ...[
    null,
    [],
    "not a credential",
    {},
    { type: "unknown", key: "synthetic-key" },
    { type: "api_key", key: 42 },
    { type: "api_key", key: null },
    { type: "api_key", env: "not a map" },
    { type: "api_key", env: [] },
    { type: "api_key", env: null },
    { type: "api_key", env: { KEY: 42 } },
    { type: "api_key", env: { KEY: null } },
    { type: "oauth", access: " ", refresh: original.refresh, expires: original.expires },
    { type: "oauth", access: original.access, refresh: "\t", expires: original.expires },
    { type: "oauth", refresh: original.refresh, expires: original.expires },
    { type: "oauth", access: original.access, expires: original.expires },
    { type: "oauth", access: original.access, refresh: original.refresh },
    { ...original, access: 42 },
    { ...original, refresh: null },
    { ...original, expires: "1900000000000" },
    { ...original, expires: null },
  ].map((credential, index): [string, string] => [
    `invalid unrelated provider ${index}`,
    JSON.stringify({ ...auth, unrelated: credential }),
  ]),
  ...[
    { ...original, access: " " },
    { ...original, refresh: " " },
    { ...original, expires: "invalid" },
  ].map((credential, index): [string, string] => [
    `invalid selected OAuth ${index}`,
    JSON.stringify({ ...auth, openai: credential }),
  ]),
  [
    "nonfinite unrelated OAuth expiry",
    `{"openai":${JSON.stringify(original)},"other":{"type":"oauth","access":"synthetic-access","refresh":"synthetic-refresh","expires":1e999}}`,
  ],
]
const badRefreshes: [string, string][] = [
  ["missing file", "missing"],
  ["unreadable regular file replaced by directory", "directory"],
  ["malformed JSON", "{"],
  ["null map", "null"],
  ["array map", "[]"],
  ["missing selected provider", "{}"],
  ...[
    { type: "api_key", key: "synthetic-new-key" },
    { ...rotated, access: "" },
    { ...rotated, access: " " },
    { ...rotated, refresh: "" },
    { ...rotated, refresh: " " },
    { type: "oauth", access: rotated.access, expires: rotated.expires },
    { type: "oauth", access: rotated.access, refresh: rotated.refresh },
    { ...rotated, expires: "2000000000000" },
    { ...rotated, expires: null },
  ].map((credential, index): [string, string] => [
    `invalid OAuth ${index}`,
    JSON.stringify({ openai: credential }),
  ]),
  [
    "nonfinite expiry",
    '{"openai":{"type":"oauth","access":"handoff-new-access","refresh":"handoff-new-refresh","expires":1e999}}',
  ],
]

describe.each(["review", "triage"])("%s OAuth handoff", (action) => {
  test("exports the full merged document without a writer token or secret calls", () => {
    const run = runAction(action)
    expect(run.result.status, run.logs).toBe(0)
    expectHandoff(run)
    expect(
      run.calls.some(
        (call) =>
          call.args[0] === "secret" || call.args.some((arg) => arg.includes("/environments/")),
      ),
    ).toBe(false)
    expect(run.calls.filter(isPublication).length).toBeGreaterThan(0)
    expectSafe(run)
  })

  test("isolates the selected credential and removes Pi work and request files", () => {
    const run = runAction(action)
    expect(run.result.status, run.logs).toBe(0)
    expectHandoff(run)
    expect(run.pi?.auth).toEqual({ openai: original })
    expect(run.pi?.mode).toBe(0o600)
    expect(run.pi?.directoryMode).toBe(0o700)
    expect(run.pi?.cwd).toBe(run.pi?.directory)
    expect(run.pi?.directory.startsWith(`${run.runner}${sep}`)).toBe(true)
    expect(run.pi?.directory).not.toBe(dirname(run.target))
    expect(existsSync(join(run.root, "ignored-inherited-agent"))).toBe(false)
    expectSafe(run)
  })

  test("does not pass an inherited PAT to Pi or ordinary GitHub calls", () => {
    const token = "handoff-inherited-pat-token"
    const run = runAction(action, { PAT_TOKEN: token })
    expect(run.result.status, run.logs).toBe(0)
    for (const call of run.calls) expect(call.env.PAT_TOKEN).toBeUndefined()
    expect(normalLogs(run.logs)).not.toContain(token)
    expect(run.output).not.toContain(token)
    expectHandoff(run)
    expectSafe(run)
  })

  test("completes credential handoff before state checks and publication, without writing a secret", () => {
    const run = runAction(action)
    expect(run.result.status, run.logs).toBe(0)
    const piIndex = run.calls.findIndex((call) => call.command === "pi")
    expect(piIndex).toBeGreaterThanOrEqual(0)
    const laterCalls = run.calls.slice(piIndex + 1)
    expect(laterCalls.filter(isPublication).length).toBeGreaterThan(0)
    for (const call of laterCalls) expect(call.handoff).toEqual({ ...auth, openai: rotated })
    expectHandoff(run)
    expectSafe(run)
  })

  test.each(["unchanged", "formatted", "reordered"])(
    "exports a valid %s document for consumer unchanged detection",
    (format) => {
      const run = runAction(action, {
        MOCK_AUTH_UPDATE:
          format === "unchanged"
            ? "unchanged"
            : JSON.stringify(
                {
                  openai:
                    format === "reordered"
                      ? Object.fromEntries(Object.entries(original).reverse())
                      : original,
                },
                null,
                2,
              ),
      })
      expect(run.result.status, run.logs).toBe(0)
      expectHandoff(run, auth)
      expectSafe(run)
    },
  )

  test("preserves selected-provider metadata omitted by Pi", () => {
    const tokens = {
      type: rotated.type,
      access: rotated.access,
      refresh: rotated.refresh,
      expires: rotated.expires,
    }
    const run = runAction(action, { MOCK_AUTH_UPDATE: JSON.stringify({ openai: tokens }) })
    expect(run.result.status, run.logs).toBe(0)
    expectHandoff(run, { ...auth, openai: { ...original, ...tokens } })
    expectSafe(run)
  })

  test("preserves original unrelated providers even if Pi adds another provider", () => {
    const run = runAction(action, {
      MOCK_AUTH_UPDATE: JSON.stringify({
        openai: rotated,
        anthropic: { type: "api_key", key: "not-authoritative" },
      }),
    })
    expect(run.result.status, run.logs).toBe(0)
    expectHandoff(run)
    expectSafe(run)
  })

  test.each([
    ["key omitted", { type: "api_key" }],
    ["key empty", { type: "api_key", key: "" }],
    ["key and env", { type: "api_key", key: "env:TEST_KEY", env: { TEST_KEY: "synthetic-key" } }],
    ["empty env", { type: "api_key", env: {} }],
  ])("accepts canonical api_key with %s", (_name, credential) => {
    const document = { ...auth, custom: credential }
    const run = runAction(action, { PI_AUTH_JSON: JSON.stringify(document) })
    expect(run.result.status, run.logs).toBe(0)
    expectHandoff(run, { ...document, openai: rotated })
    expectSafe(run)
  })

  test.each([
    ["secret", { PI_AUTH_SECRET: "PI_AUTH_JSON" }],
    ["environment", { PI_AUTH_ENVIRONMENT: "pi-oauth" }],
    ["writer token", { PI_AUTH_TOKEN: writerToken }],
    [
      "complete inline mode",
      {
        PI_AUTH_SECRET: "PI_AUTH_JSON",
        PI_AUTH_ENVIRONMENT: "pi-oauth",
        PI_AUTH_TOKEN: writerToken,
      },
    ],
  ])("rejects mixed-mode %s before any command", (_name, overrides) => {
    const run = runAction(action, overrides)
    expectFailure(run, /auth|inline|combine|exclusive|output|handoff/i)
    expect(run.calls).toEqual([])
    expect(existsSync(run.target)).toBe(false)
  })

  test.each(invalidDocuments)("validates the full document before Pi: %s", (_name, document) => {
    const run = runAction(action, { PI_AUTH_JSON: document })
    expectFailure(run)
    expect(run.calls).toEqual([])
    expect(existsSync(run.target)).toBe(false)
  })

  test("rejects API-key input in handoff mode before commands", () => {
    const run = runAction(action, { PI_AUTH_JSON: "", PI_API_KEY: "handoff-input-api-key" })
    expectFailure(run)
    expect(run.calls).toEqual([])
    expect(normalLogs(run.logs)).not.toContain("handoff-input-api-key")
    expect(existsSync(run.target)).toBe(false)
  })

  test.each(["pi", "empty output", "invalid JSON", "state", "changed state", "publish"])(
    "retains valid rotation after %s failure",
    (stage) => {
      const overrides: Record<string, string> = {}
      if (["pi", "state", "publish"].includes(stage)) overrides.MOCK_FAILURE = stage
      if (stage === "empty output") overrides.MOCK_OUTPUT = ""
      if (stage === "invalid JSON") overrides.MOCK_OUTPUT = "{"
      if (stage === "changed state") overrides.MOCK_CHANGED_STATE = "1"
      const run = runAction(action, overrides)
      expectFailure(
        run,
        /Pi failed|empty|json|review|classification|state|changed|publish|command/i,
      )
      expectHandoff(run)
      expect(run.pi).toBeDefined()
      if (stage !== "publish") expect(run.calls.filter(isPublication)).toHaveLength(0)
      expect(run.published).toBeUndefined()
    },
  )

  test.each(["success", "pi failure", "invalid result", "before-pi failure"])(
    "hands off to the real standalone entry point after %s",
    (stage) => {
      const overrides: Record<string, string> = {}
      if (stage === "pi failure") overrides.MOCK_FAILURE = "pi"
      if (stage === "invalid result") overrides.MOCK_OUTPUT = "{"
      if (stage === "before-pi failure") overrides.MOCK_FAILURE = "before-pi"
      const run = runAction(action, overrides)
      const expected = stage === "before-pi failure" ? auth : { ...auth, openai: rotated }
      expectHandoff(run, expected)
      expect(run.result.status).toBe(stage === "success" ? 0 : 1)
      const saved = consumeHandoff(run)
      expect(saved.status, saved.stdout + saved.stderr).toBe(0)
      const path = join(run.root, "saved-auth.json")
      if (stage === "before-pi failure") expect(existsSync(path)).toBe(false)
      else expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(expected)
      expect(run.result.status).toBe(stage === "success" ? 0 : 1)
    },
  )

  test("standalone save failure cannot undo an already published result", () => {
    const run = runAction(action)
    expect(run.result.status, run.logs).toBe(0)
    expect(run.published).toBeDefined()
    const saved = consumeHandoff(run, "save")
    expect(saved.status).toBe(1)
    expect(readFileSync(join(run.root, "published.json"), "utf8")).toBe(run.published)
  })

  test("exports the original document when fetching task input fails before Pi", () => {
    const run = runAction(action, { MOCK_FAILURE: "before-pi" })
    expectFailure(run, /before-pi|fetch|input|github|command/i)
    expect(run.pi).toBeUndefined()
    expectHandoff(run, auth)
    expect(run.calls.filter(isPublication)).toHaveLength(0)
  })

  test("rejects invalid events before creating a handoff", () => {
    const run = runAction(action, { GITHUB_EVENT_NAME: "push" })
    expectFailure(run, /event|requires/i)
    expect(run.pi).toBeUndefined()
    expect(existsSync(run.target)).toBe(false)
    expect(run.calls).toEqual([])
  })

  test.each([
    ["missing prompt", { PI_PROMPT: "missing-prompt.md" }],
    ["invalid thinking level", { PI_THINKING: "invalid" }],
    ["missing model", { PI_MODEL: "" }],
  ])("rejects pre-Pi %s without side effects", (_name, overrides) => {
    const run = runAction(action, overrides)
    expectFailure(run, /prompt|thinking|model|required/i)
    expect(run.pi).toBeUndefined()
    expect(run.calls).toEqual([])
    expect(existsSync(run.target)).toBe(false)
  })

  test.each(badRefreshes)(
    "deletes the handoff after post-Pi %s; never restores the old refresh token",
    (_name, update) => {
      const run = runAction(action, { MOCK_AUTH_UPDATE: update })
      expectFailure(run)
      expect(run.pi).toBeDefined()
      expect(existsSync(run.target)).toBe(false)
      expect(run.calls.filter(isPublication)).toHaveLength(0)
    },
  )

  test.each(["missing", "{", "unchanged"])(
    "suppresses never-stored OAuth diagnostics after failed Pi with %s credentials",
    (update) => {
      const run = runAction(action, {
        MOCK_FAILURE: "pi",
        MOCK_AUTH_UPDATE: update,
        MOCK_DIAGNOSTIC: `${original.access} ${original.refresh} ${rotated.access} ${rotated.refresh} ${regularToken}`,
        MOCK_PI_STDERR: `refresh_token_reused OAuth response ${JSON.stringify({ access_token: neverStored[0], refresh_token: neverStored[1], expires_in: "invalid" })}`,
      })
      expectFailure(run, /Pi failed with exit code 1/i)
      expect(run.calls.filter((call) => call.command === "pi")).toHaveLength(1)
      expect(run.calls.filter(isPublication)).toHaveLength(0)
      if (update === "unchanged") {
        expectHandoff(run, auth)
        expect(normalLogs(run.logs)).toMatch(/login|log in|sign in|re.?auth/i)
      } else {
        expect(existsSync(run.target)).toBe(false)
        expect(normalLogs(run.logs)).toMatch(/auth|credential|handoff|persist/i)
      }
    },
  )

  test("suppresses successful Pi stderr without losing the handoff", () => {
    const run = runAction(action, {
      MOCK_PI_STDERR: `${rotated.access} ${rotated.refresh} ${neverStored.join(" ")}`,
    })
    expect(run.result.status, run.logs).toBe(0)
    expectHandoff(run)
    expectSafe(run)
  })

  test("supports an existing private handoff directory without changing its other files", () => {
    const setup = fixture()
    mkdirSync(dirname(setup.target), { mode: 0o700 })
    const sibling = join(dirname(setup.target), "caller-owned.txt")
    writeFileSync(sibling, "keep this file", { mode: 0o640 })
    const run = runAction(action, {}, setup)
    expect(run.result.status, run.logs).toBe(0)
    expectHandoff(run)
    expect(readFileSync(sibling, "utf8")).toBe("keep this file")
    expect(statSync(sibling).mode & 0o777).toBe(0o640)
    expectSafe(run)
  })

  test("creates each nested handoff directory with private permissions", () => {
    const setup = fixture()
    setup.target = join(setup.runner, "handoff", "nested", "auth.json")
    const run = runAction(action, {}, setup)
    expect(run.result.status, run.logs).toBe(0)
    expectHandoff(run)
    expect(statSync(join(setup.runner, "handoff")).mode & 0o777).toBe(0o700)
    expectSafe(run)
  })

  test.each([
    "existing file",
    "existing directory",
    "file symlink",
    "dangling symlink",
    "parent symlink",
    "ancestor symlink",
    "outside temp",
    "prefix sibling",
    "traversal",
    "relative path",
    "runner directory",
  ])("rejects unsafe destination %s before Pi without overwriting caller data", (kind) => {
    const setup = fixture()
    const outside = join(setup.root, "caller-owned")
    mkdirSync(outside)
    const sentinel = join(outside, "sentinel.json")
    writeFileSync(sentinel, "caller-owned sentinel", { mode: 0o640 })
    let target = setup.target
    if (["existing file", "existing directory", "file symlink", "dangling symlink"].includes(kind))
      mkdirSync(dirname(target), { mode: 0o700 })
    if (kind === "existing file") writeFileSync(target, "existing credentials", { mode: 0o640 })
    if (kind === "existing directory") mkdirSync(target)
    if (kind === "file symlink") symlinkSync(sentinel, target)
    if (kind === "dangling symlink") symlinkSync(join(outside, "absent.json"), target)
    if (kind === "parent symlink") symlinkSync(outside, dirname(target))
    if (kind === "ancestor symlink") {
      symlinkSync(outside, join(setup.runner, "linked"))
      target = join(setup.runner, "linked", "nested", "auth.json")
    }
    if (kind === "outside temp") target = join(outside, "auth.json")
    if (kind === "prefix sibling") target = join(`${setup.runner}-sibling`, "auth.json")
    if (kind === "traversal") target = `${setup.runner}/../caller-owned/auth.json`
    if (kind === "relative path") target = "relative/auth.json"
    if (kind === "runner directory") target = setup.runner
    const run = runAction(action, { PI_AUTH_OUTPUT: target }, setup)
    expectFailure(run)
    expect(run.calls).toEqual([])
    expect(readFileSync(sentinel, "utf8")).toBe("caller-owned sentinel")
    expect(statSync(sentinel).mode & 0o777).toBe(0o640)
    expect(readdirSync(outside)).toEqual(["sentinel.json"])
    if (kind === "existing file") {
      expect(readFileSync(target, "utf8")).toBe("existing credentials")
      expect(statSync(target).mode & 0o777).toBe(0o640)
    } else if (kind === "existing directory" || kind === "runner directory") {
      expect(lstatSync(target).isDirectory()).toBe(true)
    } else if (kind === "file symlink" || kind === "dangling symlink") {
      expect(lstatSync(target).isSymbolicLink()).toBe(true)
    } else if (kind === "parent symlink") {
      expect(lstatSync(dirname(target)).isSymbolicLink()).toBe(true)
    } else if (kind === "ancestor symlink") {
      expect(lstatSync(join(setup.runner, "linked")).isSymbolicLink()).toBe(true)
      expect(existsSync(join(outside, "nested"))).toBe(false)
    } else if (kind === "relative path") {
      expect(existsSync(join(setup.root, "workspace", target))).toBe(false)
    } else {
      expect(existsSync(target)).toBe(false)
    }
  })

  test("rejects a missing RUNNER_TEMP rather than selecting a fallback directory", () => {
    const run = runAction(action, { RUNNER_TEMP: "" })
    expectFailure(run)
    expect(run.calls).toEqual([])
    expect(existsSync(run.target)).toBe(false)
  })

  test("declares an optional auth-output input and forwards it to the runtime", () => {
    const manifest = readFileSync(resolve(action, "action.yml"), "utf8")
    const input = manifest.match(/^ {2}auth-output:\n((?: {4}.+\n)+)/m)?.[1]
    expect(input).toBeDefined()
    expect(input).toMatch(/^ {4}required: false$/m)
    expect(manifest).toMatch(/PI_AUTH_OUTPUT: \$\{\{ inputs\.auth-output \}\}/)
  })

  test("hands off credentials from a copied distribution without source or development dependencies", () => {
    const directory = copyDistribution(action)
    const run = runAction(action, {}, fixture(), directory)
    expect(run.result.status, run.logs).toBe(0)
    expect(existsSync(join(directory, "src"))).toBe(false)
    expect(existsSync(join(directory, "node_modules"))).toBe(false)
    expectHandoff(run)
    expectSafe(run)
  })
})

describe("triage successful no-op handoffs", () => {
  const cases: [string, Record<string, string>, boolean][] = [
    ["unsupported activity before withPi", { MOCK_ACTIVITY: "labeled" }, false],
    ["closed issue", { MOCK_ISSUE: JSON.stringify({ ...issue, state: "closed" }) }, false],
    ["repository without labels", { MOCK_LABELS: "[[]]" }, false],
    ["no selected labels", { MOCK_OUTPUT: '{"labels":[]}' }, true],
    [
      "labels already present",
      { MOCK_ISSUE: JSON.stringify({ ...issue, labels: [{ name: "bug" }] }) },
      true,
    ],
  ]
  test.each(cases)("exports valid credentials for %s", (_name, overrides, invokesPi) => {
    const run = runAction("triage", overrides)
    expect(run.result.status, run.logs).toBe(0)
    expectHandoff(run, invokesPi ? { ...auth, openai: rotated } : auth)
    expect(Boolean(run.pi)).toBe(invokesPi)
    expect(run.calls.filter(isPublication)).toHaveLength(0)
    expectSafe(run)
  })

  test("validates unrelated providers even for unsupported activity", () => {
    const run = runAction("triage", {
      MOCK_ACTIVITY: "labeled",
      PI_AUTH_JSON: JSON.stringify({ ...auth, unrelated: { type: "api_key", env: { KEY: 42 } } }),
    })
    expectFailure(run)
    expect(run.calls).toEqual([])
    expect(existsSync(run.target)).toBe(false)
  })

  test("rejects mixed-mode inputs even for unsupported activity", () => {
    const run = runAction("triage", { MOCK_ACTIVITY: "labeled", PI_AUTH_TOKEN: writerToken })
    expectFailure(run, /auth|inline|combine|exclusive|output|handoff/i)
    expect(run.calls).toEqual([])
    expect(existsSync(run.target)).toBe(false)
  })
})
