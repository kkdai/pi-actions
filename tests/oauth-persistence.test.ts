import { spawnSync } from "node:child_process"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

const roots: string[] = []
const original = {
  type: "oauth",
  access: "synthetic-old-access",
  refresh: "synthetic-old-refresh",
  expires: 1_900_000_000_000,
  accountId: "synthetic-account",
  metadata: { tenant: "synthetic-tenant" },
}
const rotated = {
  ...original,
  access: "synthetic-new-access",
  refresh: "synthetic-new-refresh",
  expires: original.expires + 3_600_000,
  metadata: { tenant: "synthetic-new-tenant" },
}
const auth = {
  openai: original,
  anthropic: { type: "api_key", key: "synthetic-other-provider-key", metadata: { keep: true } },
}
const regularToken = "synthetic-regular-github-token"
const writerToken = "synthetic-secret-writer-token"
const secret = "PI_AUTH_JSON"
const environment = "OAuth / CI"
const preflightEndpoint = `repos/owner/repo/environments/${encodeURIComponent(environment)}/secrets/${secret}`
const base = "a".repeat(40)
const head = "b".repeat(40)
const pullRequest = { base: { sha: base }, head: { sha: head } }
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
  env: Record<string, string>
  host?: string
}
type PiRecord = {
  directory: string
  cwd: string
  mode: number
  directoryMode: number
  auth: unknown
  attachment: string
}

// These executables run in real subprocesses. Only their synthetic observations leave the runner directory.
const mockCommand = String.raw`#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } = require("node:fs");
const { basename, join } = require("node:path");
const env = process.env;
const args = process.argv.slice(2);
const command = basename(process.argv[1]);
const tracked = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "PI_AUTH_TOKEN", "PI_AUTH_JSON", "PI_API_KEY"];
appendFileSync(join(env.MOCK_ROOT, "calls.jsonl"), JSON.stringify({
  command, args, host: env.GH_HOST,
  env: Object.fromEntries(tracked.filter(key => key in env).map(key => [key, env[key]])),
}) + "\n");
function fail(stage) {
  if (env.MOCK_FAILURE === stage || (stage === "save" && env.MOCK_SAVE_FAILURE === "1")) {
    console.error("mock " + stage + " failure " + env.MOCK_SENSITIVE);
    process.exit(1);
  }
}
if (command === "pi") {
  const directory = env.PI_CODING_AGENT_DIR;
  const authPath = join(directory, "auth.json");
  const attachment = args.find(value => value.startsWith("@")).slice(1);
  writeFileSync(join(env.MOCK_ROOT, "pi.json"), JSON.stringify({
    directory, cwd: process.cwd(),
    mode: statSync(authPath).mode & 0o777,
    directoryMode: statSync(directory).mode & 0o777,
    auth: JSON.parse(readFileSync(authPath, "utf8")),
    attachment: readFileSync(attachment, "utf8"),
  }));
  if (env.MOCK_AUTH_UPDATE === "missing") rmSync(authPath);
  else if (env.MOCK_AUTH_UPDATE !== "unchanged") writeFileSync(authPath, env.MOCK_AUTH_UPDATE);
  // Both streams may contain refreshed values even when Pi exits unsuccessfully.
  process.stderr.write(env.MOCK_PI_STDERR || "");
  if (env.MOCK_FAILURE === "pi") process.stdout.write(env.MOCK_SENSITIVE);
  fail("pi");
  process.stdout.write(env.MOCK_OUTPUT);
} else if (command === "gh") {
  const endpoint = args.find(value => value.startsWith("repos/")) || "";
  const methodIndex = args.findIndex(value => value === "--method" || value === "-X");
  const method = methodIndex < 0 ? "GET" : args[methodIndex + 1];
  if (args[0] === "secret" && args[1] === "set") {
    writeFileSync(join(env.MOCK_ROOT, "saved.json"), readFileSync(0, "utf8"));
    fail("save");
  } else if (endpoint.includes("/environments/")) {
    fail("preflight");
    process.stdout.write(env.MOCK_PREFLIGHT_RESPONSE ?? JSON.stringify({ name: endpoint.split("/").pop() }));
  } else if (method !== "GET") {
    fail("publish");
    const input = args[args.indexOf("--input") + 1];
    writeFileSync(join(env.MOCK_ROOT, "published.json"), readFileSync(input, "utf8"));
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
    console.log(JSON.stringify([[{ name: "bug", description: "Synthetic bug label" }]]));
  } else {
    throw new Error("Unexpected mock request: " + JSON.stringify(args));
  }
} else {
  throw new Error("Unexpected executable: " + command);
}
`

function createRoot() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-oauth-test-")))
  roots.push(root)
  return root
}

function runAction(action: string, overrides: Record<string, string> = {}, distribution?: string) {
  const root = createRoot()
  const workspace = join(root, "workspace")
  const runner = join(root, "runner")
  const bin = join(root, "bin")
  for (const path of [workspace, runner, bin]) mkdirSync(path)
  for (const command of ["gh", "pi"]) {
    writeFileSync(join(bin, command), mockCommand, { mode: 0o755 })
  }
  const actionPath = distribution ? join(distribution, action) : resolve(action)
  const manifest = readFileSync(join(actionPath, "action.yml"), "utf8")
  const runCommand = manifest.match(/^ {6}run: (node .+)$/m)?.[1]
  expect(runCommand).toBeDefined()
  const eventPath = join(root, "event.json")
  writeFileSync(
    eventPath,
    JSON.stringify(
      action === "review" ? { number: 42, pull_request: pullRequest } : { action: "opened", issue },
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
        GITHUB_TOKEN: "synthetic-alternate-token",
        GH_ENTERPRISE_TOKEN: "synthetic-enterprise-token",
        GITHUB_ENTERPRISE_TOKEN: "synthetic-alternate-enterprise-token",
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
        PI_AUTH_SECRET: secret,
        PI_AUTH_ENVIRONMENT: environment,
        PI_AUTH_TOKEN: writerToken,
        PI_BASE_URL: "",
        PI_THINKING: "medium",
        PI_PROMPT: "",
        MOCK_ROOT: root,
        MOCK_FAILURE: "",
        MOCK_SAVE_FAILURE: "",
        MOCK_CHANGED_STATE: "",
        MOCK_HEAD: head,
        MOCK_ISSUE: JSON.stringify(issue),
        MOCK_AUTH_UPDATE: JSON.stringify({ openai: rotated }),
        MOCK_OUTPUT: JSON.stringify(
          action === "review" ? { summary: "Synthetic review", findings: [] } : { labels: ["bug"] },
        ),
        MOCK_PI_STDERR: "",
        MOCK_SENSITIVE: [
          writerToken,
          regularToken,
          original.access,
          original.refresh,
          rotated.access,
          rotated.refresh,
          auth.anthropic.key,
        ].join(" "),
        ...overrides,
      },
    },
  )
  expect(result.error).toBeUndefined()
  expect(readdirSync(runner), "temporary runtime files must always be removed").toEqual([])
  const read = (name: string) =>
    existsSync(join(root, name)) ? readFileSync(join(root, name), "utf8") : undefined
  const calls: Call[] = (read("calls.jsonl") ?? "")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const pi: PiRecord | undefined = read("pi.json") ? JSON.parse(read("pi.json") ?? "") : undefined
  if (pi) expect(existsSync(pi.directory)).toBe(false)
  return {
    result,
    calls,
    pi,
    root,
    saves: calls.filter(isSave),
    preflights: calls.filter(isPreflight),
    publications: calls.filter(isPublication),
    saved: read("saved.json"),
    published: read("published.json"),
    output: read("action-output") ?? "",
    logs: `${result.stdout}\n${result.stderr}`,
  }
}

function isSave(call: Call) {
  return call.command === "gh" && call.args[0] === "secret" && call.args[1] === "set"
}
function isPreflight(call: Call) {
  return (
    call.command === "gh" &&
    call.args[0] === "api" &&
    call.args.some((arg) => arg.includes("/environments/"))
  )
}
function isPublication(call: Call) {
  return (
    call.command === "gh" &&
    call.args.some((arg) => ["POST", "PATCH", "PUT", "DELETE"].includes(arg))
  )
}
function normalLogs(logs: string) {
  return logs
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("::add-mask::"))
    .join("\n")
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
    writerToken,
    regularToken,
    "synthetic-alternate-token",
    "synthetic-enterprise-token",
    "synthetic-alternate-enterprise-token",
    original.access,
    original.refresh,
    rotated.access,
    rotated.refresh,
    auth.anthropic.key,
  ]) {
    expect(publicData, `credential must not be exposed: ${value}`).not.toContain(value)
  }
}
function expectFailure(run: ReturnType<typeof runAction>, message: RegExp) {
  expect(run.result.status, run.logs).toBe(1)
  expect(normalLogs(run.logs)).toMatch(message)
}
function copyDistribution(action: string) {
  const directory = join(createRoot(), "action distribution")
  for (const path of ["dist", "package.json", ".pi/prompts", action]) {
    cpSync(resolve(path), join(directory, path), { recursive: true })
  }
  expect(readdirSync(directory).sort()).toEqual([".pi", action, "dist", "package.json"].sort())
  return directory
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const disabled = { PI_AUTH_SECRET: "", PI_AUTH_ENVIRONMENT: "", PI_AUTH_TOKEN: "" }
const invalidInputs: [string, Record<string, string>][] = [
  ["secret only", { ...disabled, PI_AUTH_SECRET: secret }],
  ["environment only", { ...disabled, PI_AUTH_ENVIRONMENT: environment }],
  ["token only", { ...disabled, PI_AUTH_TOKEN: writerToken }],
  ["missing token", { PI_AUTH_TOKEN: "" }],
  ["missing environment", { PI_AUTH_ENVIRONMENT: "" }],
  ["missing secret", { PI_AUTH_SECRET: "" }],
  ["API key input", { PI_AUTH_JSON: "", PI_API_KEY: "synthetic-api-key" }],
  ["selected API key", { PI_AUTH_JSON: JSON.stringify({ openai: auth.anthropic }) }],
  ["missing auth", { PI_AUTH_JSON: "" }],
  ["malformed auth", { PI_AUTH_JSON: "{" }],
  ["missing selected provider", { PI_AUTH_JSON: JSON.stringify({ anthropic: original }) }],
  ["blank access", { PI_AUTH_JSON: JSON.stringify({ openai: { ...original, access: " " } }) }],
  ["blank refresh", { PI_AUTH_JSON: JSON.stringify({ openai: { ...original, refresh: " " } }) }],
  ["control character in environment", { PI_AUTH_ENVIRONMENT: "OAuth\nCI" }],
  ["overlong environment", { PI_AUTH_ENVIRONMENT: "x".repeat(256) }],
  ["invalid GitHub server", { GITHUB_SERVER_URL: "not a URL" }],
  ["insecure GitHub server", { GITHUB_SERVER_URL: "http://github.com" }],
  ["embedded server credentials", { GITHUB_SERVER_URL: "https://user:password@github.com" }],
  ...[
    "bad-name",
    "name with spaces",
    "1NAME",
    "GITHUB_AUTH",
    "github_auth",
    "GitHub_auth",
    "A".repeat(101),
  ].map((name): [string, Record<string, string>] => [
    `invalid secret ${name}`,
    { PI_AUTH_SECRET: name },
  ]),
  ...[
    { ...original, access: "" },
    { ...original, access: 42 },
    { ...original, refresh: "" },
    { ...original, refresh: null },
    { type: "oauth", access: original.access, expires: original.expires },
    { type: "oauth", refresh: original.refresh, expires: original.expires },
    { type: "oauth", access: original.access, refresh: original.refresh },
    { ...original, expires: "1900000000000" },
    { ...original, expires: null },
    { ...original, type: "unknown" },
  ].map((credential, index): [string, Record<string, string>] => [
    `invalid OAuth ${index}`,
    { PI_AUTH_JSON: JSON.stringify({ openai: credential }) },
  ]),
  [
    "nonfinite OAuth expiry",
    {
      PI_AUTH_JSON:
        '{"openai":{"type":"oauth","access":"synthetic-access","refresh":"synthetic-refresh","expires":1e999}}',
    },
  ],
]

const badRefreshes: [string, string][] = [
  ["missing file", "missing"],
  ["malformed JSON", "{"],
  ["null document", "null"],
  ["array document", "[]"],
  ["missing provider", "{}"],
  [
    "wrong credential type",
    JSON.stringify({ openai: { type: "api_key", key: "synthetic-new-key" } }),
  ],
  ["empty access", JSON.stringify({ openai: { ...rotated, access: "" } })],
  ["empty refresh", JSON.stringify({ openai: { ...rotated, refresh: "" } })],
  [
    "missing refresh",
    JSON.stringify({ openai: { type: "oauth", access: rotated.access, expires: rotated.expires } }),
  ],
  [
    "missing expiry",
    JSON.stringify({ openai: { type: "oauth", access: rotated.access, refresh: rotated.refresh } }),
  ],
  ["string expiry", JSON.stringify({ openai: { ...rotated, expires: "2000000000000" } })],
  [
    "nonfinite expiry",
    '{"openai":{"type":"oauth","access":"synthetic-new-access","refresh":"synthetic-new-refresh","expires":1e999}}',
  ],
]

describe.each(["review", "triage"])("%s OAuth persistence", (action) => {
  test("saves a merged document exactly once immediately after Pi exits", () => {
    const run = runAction(action)
    expect(run.result.status, run.logs).toBe(0)
    expect(run.preflights).toHaveLength(1)
    expect(run.preflights[0].args).toEqual(["api", preflightEndpoint])
    expect(run.saves).toHaveLength(1)
    expect(run.saves[0].args).toEqual([
      "secret",
      "set",
      secret,
      "--env",
      environment,
      "--repo",
      "owner/repo",
    ])
    expect(JSON.parse(run.saved ?? "null")).toEqual({ ...auth, openai: rotated })
    const piIndex = run.calls.findIndex((call) => call.command === "pi")
    expect(run.calls[piIndex + 1]).toBe(run.saves[0])
    expect(run.calls.indexOf(run.preflights[0])).toBeLessThan(piIndex)
    expect(run.publications.length).toBeGreaterThan(0)
    expectSafe(run)
  })

  test("uses private selected-provider files and isolates writer and normal tokens", () => {
    const run = runAction(action)
    expect(run.result.status, run.logs).toBe(0)
    expect(run.pi?.auth).toEqual({ openai: original })
    expect(run.pi?.mode).toBe(0o600)
    expect(run.pi?.directoryMode).toBe(0o700)
    expect(run.pi?.cwd).toBe(run.pi?.directory)
    expect(run.pi?.directory.startsWith(`${join(run.root, "runner")}${sep}`)).toBe(true)
    expect(run.preflights).toHaveLength(1)
    expect(run.saves).toHaveLength(1)
    for (const call of run.calls) {
      for (const key of ["PI_AUTH_TOKEN", "PI_AUTH_JSON", "PI_API_KEY"])
        expect(call.env[key]).toBeUndefined()
      if (isPreflight(call) || isSave(call)) {
        expect(call.env).toEqual({ GH_TOKEN: writerToken })
      } else if (call.command === "pi") {
        expect(call.env).toEqual({})
      } else {
        expect(call.env.GH_TOKEN).toBe(regularToken)
        expect(Object.values(call.env)).not.toContain(writerToken)
      }
    }
    expectSafe(run)
  })

  test.each(["unchanged", "formatted", "reordered"])(
    "does not write %s OAuth credentials",
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
      expect(run.preflights).toHaveLength(1)
      expect(run.saves).toHaveLength(0)
    },
  )

  test.each([
    ["OAuth", { PI_AUTH_JSON: JSON.stringify(auth) }],
    ["API key input", { PI_AUTH_JSON: "", PI_API_KEY: "synthetic-api-key" }],
    ["API key document", { PI_AUTH_JSON: JSON.stringify({ openai: auth.anthropic }) }],
  ])("leaves legacy %s calls without secret operations", (_name, overrides) => {
    const run = runAction(action, { ...disabled, ...overrides, MOCK_AUTH_UPDATE: "unchanged" })
    expect(run.result.status, run.logs).toBe(0)
    expect(run.preflights).toHaveLength(0)
    expect(run.saves).toHaveLength(0)
    expect(run.publications.length).toBeGreaterThan(0)
  })

  test.each(invalidInputs)("rejects %s before any command", (_name, overrides) => {
    const run = runAction(action, overrides)
    expectFailure(run, /auth|oauth|secret|environment|token|server/i)
    expect(run.calls).toEqual([])
    expectSafe(run)
  })

  test.each(["_auth", "A".repeat(100)])("accepts valid secret name %s", (name) => {
    const run = runAction(action, { PI_AUTH_SECRET: name })
    expect(run.result.status, run.logs).toBe(0)
    expect(run.saves).toHaveLength(1)
    expect(run.saves[0].args[2]).toBe(name)
  })

  test("rejects an invalid caller repository before commands", () => {
    const run = runAction(action, { GITHUB_REPOSITORY: "owner/repo/other" })
    expectFailure(run, /repository|owner\/repo/i)
    expect(run.calls).toEqual([])
  })

  test("fails preflight safely without Pi or a repository-secret fallback", () => {
    const run = runAction(action, { MOCK_FAILURE: "preflight" })
    expectFailure(run, /environment|secret|preflight|access|permission/i)
    expect(run.preflights).toHaveLength(1)
    expect(run.calls).toHaveLength(1)
    expect(run.pi).toBeUndefined()
    expect(run.saves).toHaveLength(0)
    expectSafe(run)
  })

  test.each(["", "{", "null", "[]", "{}", '{"name":"WRONG_SECRET"}'])(
    "rejects invalid preflight metadata %j without Pi",
    (response) => {
      const run = runAction(action, { MOCK_PREFLIGHT_RESPONSE: response })
      expectFailure(run, /access|environment|secret/i)
      expect(run.calls).toHaveLength(1)
      expect(run.pi).toBeUndefined()
      expect(run.saves).toHaveLength(0)
      expectSafe(run)
    },
  )

  test("pins writer operations to the caller's GitHub host", () => {
    const run = runAction(action, { GH_HOST: "unrelated.example" })
    expect(run.result.status, run.logs).toBe(0)
    for (const call of [...run.preflights, ...run.saves]) expect(call.host).toBe("github.com")
  })

  test("uses only the writer credential for an enterprise GitHub host", () => {
    const run = runAction(action, { GITHUB_SERVER_URL: "https://github.example.test" })
    expect(run.result.status, run.logs).toBe(0)
    for (const call of [...run.preflights, ...run.saves]) {
      expect(call.host).toBe("github.example.test")
      expect(call.env).toEqual({ GH_TOKEN: writerToken, GH_ENTERPRISE_TOKEN: writerToken })
    }
    expect(run.calls.find((call) => call.command === "pi")?.env).toEqual({})
    expectSafe(run)
  })

  test("preserves provider metadata omitted by Pi's refreshed credential", () => {
    const tokens = {
      type: rotated.type,
      access: rotated.access,
      refresh: rotated.refresh,
      expires: rotated.expires,
    }
    const run = runAction(action, { MOCK_AUTH_UPDATE: JSON.stringify({ openai: tokens }) })
    expect(run.result.status, run.logs).toBe(0)
    expect(JSON.parse(run.saved ?? "null")).toEqual({ ...auth, openai: { ...original, ...tokens } })
  })

  test("rejects an oversized merged secret without a write or publication", () => {
    const run = runAction(action, {
      MOCK_AUTH_UPDATE: JSON.stringify({ openai: { ...rotated, padding: "x".repeat(48 * 1024) } }),
    })
    expectFailure(run, /48 KB|exceeds/i)
    expect(run.saves).toHaveLength(0)
    expect(run.publications).toHaveLength(0)
    expectSafe(run)
  })

  test("does not write if fetching input fails before Pi", () => {
    const run = runAction(action, { MOCK_FAILURE: "before-pi", MOCK_SENSITIVE: "" })
    expectFailure(run, /before-pi|fetch|input|github|command/i)
    expect(run.preflights).toHaveLength(1)
    expect(run.pi).toBeUndefined()
    expect(run.saves).toHaveLength(0)
    expect(run.publications).toHaveLength(0)
  })

  test.each(badRefreshes)("does not overwrite a secret after %s", (_name, update) => {
    const run = runAction(action, { MOCK_AUTH_UPDATE: update })
    expectFailure(run, /auth|oauth|credential|refresh|persist/i)
    expect(run.pi).toBeDefined()
    expect(run.saves).toHaveLength(0)
    expect(run.publications).toHaveLength(0)
    expectSafe(run)
  })

  test("saves rotation after a Pi failure and retains its safe error context", () => {
    const run = runAction(action, { MOCK_FAILURE: "pi" })
    expectFailure(run, /Pi failed with exit code 1/i)
    expect(run.saves).toHaveLength(1)
    expect(JSON.parse(run.saved ?? "null")).toEqual({ ...auth, openai: rotated })
    expect(run.publications).toHaveLength(0)
    expectSafe(run)
  })

  test("unchanged refresh failure gives login guidance without retry or write", () => {
    const run = runAction(action, {
      MOCK_FAILURE: "pi",
      MOCK_AUTH_UPDATE: "unchanged",
      MOCK_PI_STDERR: "refresh_token_reused",
      MOCK_SENSITIVE: [
        writerToken,
        regularToken,
        original.access,
        original.refresh,
        auth.anthropic.key,
      ].join(" "),
    })
    expectFailure(run, /Pi failed with exit code 1/i)
    expect(normalLogs(run.logs)).toMatch(/login|log in|sign in|re.?auth/i)
    expect(run.calls.filter((call) => call.command === "pi")).toHaveLength(1)
    expect(run.saves).toHaveLength(0)
    expect(run.publications).toHaveLength(0)
    expectSafe(run)
  })

  test.each(["enabled", "disabled"])(
    "suppresses never-stored tokens from malformed OAuth refresh responses with persistence %s",
    (mode) => {
      const neverStoredAccess = "synthetic-never-stored-access"
      const neverStoredRefresh = "synthetic-never-stored-refresh"
      const run = runAction(action, {
        ...(mode === "disabled" ? disabled : {}),
        MOCK_FAILURE: "pi",
        MOCK_AUTH_UPDATE: "unchanged",
        MOCK_PI_STDERR: `OAuth refresh response missing fields: ${JSON.stringify({
          access_token: neverStoredAccess,
          refresh_token: neverStoredRefresh,
          expires_in: "invalid",
        })}`,
      })
      expect(run.logs).not.toContain(neverStoredAccess)
      expect(run.logs).not.toContain(neverStoredRefresh)
      expectFailure(run, /Pi failed with exit code 1/i)
      expect(run.saves).toHaveLength(0)
      expect(run.publications).toHaveLength(0)
      expectSafe(run)
    },
  )

  test.each(["missing", "{"])(
    "suppresses Pi errors when refreshed auth is unreadable: %s",
    (update) => {
      const run = runAction(action, { MOCK_FAILURE: "pi", MOCK_AUTH_UPDATE: update })
      expectFailure(run, /Pi failed/i)
      expect(normalLogs(run.logs)).toMatch(/persist|credential/i)
      expect(run.saves).toHaveLength(0)
      expect(run.publications).toHaveLength(0)
      expectSafe(run)
    },
  )

  test("save failure is fatal and prevents publication", () => {
    const run = runAction(action, { MOCK_SAVE_FAILURE: "1" })
    expectFailure(run, /save|persist|secret|write/i)
    expect(run.saves).toHaveLength(1)
    expect(run.publications).toHaveLength(0)
    expectSafe(run)
  })

  test("combined Pi and save failure retains both sanitized error contexts", () => {
    const run = runAction(action, { MOCK_FAILURE: "pi", MOCK_SAVE_FAILURE: "1" })
    expectFailure(run, /Pi failed with exit code 1/i)
    expect(normalLogs(run.logs)).toMatch(/save|persist|secret|write/i)
    expect(run.saves).toHaveLength(1)
    expect(run.publications).toHaveLength(0)
    expectSafe(run)
  })

  test.each([
    "empty output",
    "malformed output",
    "state error",
    "changed state",
    "publication error",
  ])("saves valid rotation before %s", (stage) => {
    const overrides: Record<string, string> = { MOCK_SENSITIVE: "" }
    if (stage === "empty output") overrides.MOCK_OUTPUT = ""
    if (stage === "malformed output") overrides.MOCK_OUTPUT = "{"
    if (stage === "state error") overrides.MOCK_FAILURE = "state"
    if (stage === "changed state") overrides.MOCK_CHANGED_STATE = "1"
    if (stage === "publication error") overrides.MOCK_FAILURE = "publish"
    const run = runAction(action, overrides)
    expectFailure(run, /empty|json|review|classification|label|state|changed|publish|command/i)
    expect(run.saves).toHaveLength(1)
    expect(JSON.parse(run.saved ?? "null")).toEqual({ ...auth, openai: rotated })
    const piIndex = run.calls.findIndex((call) => call.command === "pi")
    expect(run.calls[piIndex + 1]).toBe(run.saves[0])
    if (stage !== "publication error") expect(run.publications).toHaveLength(0)
    expect(run.published).toBeUndefined()
    expectSafe(run)
  })

  test("captures successful Pi stderr without exposing credentials", () => {
    const run = runAction(action, {
      MOCK_PI_STDERR: `${rotated.access} ${rotated.refresh} ${writerToken}`,
    })
    expect(run.result.status, run.logs).toBe(0)
    expect(run.saves).toHaveLength(1)
    expectSafe(run)
  })

  test("persists from a copied distribution without source or development dependencies", () => {
    const directory = copyDistribution(action)
    const run = runAction(action, {}, directory)
    expect(run.result.status, run.logs).toBe(0)
    expect(existsSync(join(directory, "src"))).toBe(false)
    expect(existsSync(join(directory, "node_modules"))).toBe(false)
    expect(run.saves).toHaveLength(1)
    expect(JSON.parse(run.saved ?? "null")).toEqual({ ...auth, openai: rotated })
    expectSafe(run)
  })
})
