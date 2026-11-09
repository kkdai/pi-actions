import { spawnSync } from "node:child_process"
import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

const roots: string[] = []
const writerToken = "synthetic-standalone-writer-token"
const inheritedTokens = [
  "synthetic-ordinary-github-token",
  "synthetic-alternate-github-token",
  "synthetic-inherited-enterprise-token",
  "synthetic-alternate-enterprise-token",
]
const oauth = {
  type: "oauth",
  access: "synthetic-standalone-access",
  refresh: "synthetic-standalone-refresh",
  expires: 1_900_000_000_000,
  accountId: "synthetic-account",
  metadata: { tenant: "synthetic-tenant", nested: [true, null, { retained: 42 }] },
}
const auth = {
  "openai-codex": oauth,
  anthropic: {
    type: "api_key",
    key: "synthetic-other-provider-key",
    env: { AUTH_REGION: "synthetic-region" },
    metadata: { retained: true },
  },
  other: { ...oauth, access: "synthetic-other-access", refresh: "synthetic-other-refresh" },
}
const sensitive = [
  writerToken,
  ...inheritedTokens,
  oauth.access,
  oauth.refresh,
  auth.anthropic.key,
  auth.other.access,
  auth.other.refresh,
  "synthetic-never-stored-access",
  "synthetic-never-stored-refresh",
]

type Call = { command: string; args: string[]; env: Record<string, string> }

// Every external command uses this local executable. No request leaves the fixture.
const mockCommand = String.raw`#!/usr/bin/env node
const { appendFileSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } = require("node:fs");
const { basename, join } = require("node:path");
const env = process.env;
const args = process.argv.slice(2);
const command = basename(process.argv[1]);
const tracked = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_HOST",
  "PI_AUTH_TOKEN", "PI_AUTH_JSON", "PI_AUTH_FILE", "PI_AUTH_ENVIRONMENT", "PI_AUTH_SECRET", "PI_API_KEY"];
appendFileSync(join(env.MOCK_ROOT, "calls.jsonl"), JSON.stringify({ command, args,
  env: Object.fromEntries(tracked.filter(key => key in env).map(key => [key, env[key]])),
}) + "\n");
if (command !== "gh") throw new Error("Unexpected subprocess: " + command);
const stage = args[0] === "secret" && args[1] === "set" ? "save" : "preflight";
if (env.MOCK_RACE_STAGE === stage) {
  renameSync(env.MOCK_AUTH_PATH, env.MOCK_AUTH_PATH + ".consumed");
  if (env.MOCK_RACE_KIND === "symlink") symlinkSync(env.MOCK_UNRELATED_PATH, env.MOCK_AUTH_PATH);
  else if (env.MOCK_RACE_KIND === "directory") {
    mkdirSync(env.MOCK_AUTH_PATH, { mode: 0o700 });
    writeFileSync(join(env.MOCK_AUTH_PATH, "unrelated"), "replacement directory contents");
  } else writeFileSync(env.MOCK_AUTH_PATH, "replacement file contents", { mode: 0o600 });
}
if (stage === "save") writeFileSync(join(env.MOCK_ROOT, "saved.json"), readFileSync(0, "utf8"));
if (env.MOCK_FAILURE === stage) {
  console.log("unsafe stdout " + env.MOCK_SENSITIVE);
  console.error("unsafe stderr " + env.MOCK_SENSITIVE);
  process.exit(1);
}
if (stage === "preflight") process.stdout.write(env.MOCK_METADATA);
else {
  console.log("unsafe success stdout " + env.MOCK_SENSITIVE);
  console.error("unsafe success stderr " + env.MOCK_SENSITIVE);
}
`

function createRoot() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-persist-auth-test-")))
  roots.push(root)
  return root
}

function fixture(contents = JSON.stringify(auth)) {
  const root = createRoot()
  const runner = join(root, "runner temporary files")
  const parent = join(runner, "private handoff")
  const path = join(parent, "auth.json")
  const bin = join(root, "bin")
  const workspace = join(root, "workspace")
  for (const directory of [runner, parent, bin, workspace]) mkdirSync(directory, { mode: 0o700 })
  writeFileSync(path, contents, { mode: 0o600 })
  const unrelated = join(parent, "unrelated.txt")
  writeFileSync(unrelated, "unrelated caller data", { mode: 0o600 })
  for (const command of ["gh", "pi", "npm", "git"]) {
    writeFileSync(join(bin, command), mockCommand, { mode: 0o755 })
  }
  return { root, runner, parent, path, bin, workspace, unrelated }
}
type Fixture = ReturnType<typeof fixture>

function readOptional(path: string) {
  return existsSync(path) ? readFileSync(path, "utf8") : ""
}

function run(f: Fixture, overrides: Record<string, string> = {}, distribution = resolve(".")) {
  const entry = join(distribution, "dist/persist-auth.js")
  expect(existsSync(entry), "the standalone distribution entry point must exist").toBe(true)
  const result = spawnSync(process.execPath, [entry], {
    cwd: f.workspace,
    encoding: "utf8",
    timeout: 300_000,
    env: {
      ...process.env,
      PATH: `${f.bin}:${process.env.PATH}`,
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_WORKSPACE: f.workspace,
      GITHUB_OUTPUT: join(f.root, "action-output"),
      GITHUB_STEP_SUMMARY: join(f.root, "step-summary"),
      GITHUB_ACTION_PATH: join(distribution, "persist-auth"),
      RUNNER_TEMP: f.runner,
      GH_TOKEN: inheritedTokens[0],
      GITHUB_TOKEN: inheritedTokens[1],
      GH_ENTERPRISE_TOKEN: inheritedTokens[2],
      GITHUB_ENTERPRISE_TOKEN: inheritedTokens[3],
      PI_AUTH_FILE: f.path,
      PI_AUTH_TOKEN: writerToken,
      // GitHub Actions supplies input defaults through the composite manifest.
      PI_AUTH_ENVIRONMENT: "pi-oauth",
      PI_AUTH_SECRET: "PI_AUTH_JSON",
      PI_AUTH_JSON: "",
      PI_API_KEY: "",
      MOCK_ROOT: f.root,
      MOCK_AUTH_PATH: f.path,
      MOCK_UNRELATED_PATH: f.unrelated,
      MOCK_METADATA: JSON.stringify({ name: "PI_AUTH_JSON" }),
      MOCK_FAILURE: "",
      MOCK_RACE_STAGE: "",
      MOCK_RACE_KIND: "",
      MOCK_SENSITIVE: sensitive.join(" "),
      ...overrides,
    },
  })
  expect(result.error).toBeUndefined()
  const calls: Call[] = readOptional(join(f.root, "calls.jsonl"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  return {
    ...f,
    result,
    calls,
    saves: calls.filter((call) => call.args[0] === "secret"),
    saved: readOptional(join(f.root, "saved.json")),
    logs: `${result.stdout}\n${result.stderr}`,
    output: readOptional(join(f.root, "action-output")),
    summary: readOptional(join(f.root, "step-summary")),
  }
}
type Run = ReturnType<typeof run>

function publicLogs(logs: string) {
  return logs
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("::add-mask::"))
    .join("\n")
}
function expectSafe(result: Run) {
  const published = [
    publicLogs(result.logs),
    result.output,
    result.summary,
    JSON.stringify(result.calls.map((call) => call.args)),
  ].join("\n")
  for (const value of sensitive) expect(published).not.toContain(value)
  expect(result.output).toBe("")
  expect(result.summary).toBe("")
}
function expectConsumed(result: Run) {
  expect(existsSync(result.path), "consume only the validated input file").toBe(false)
  expect(readFileSync(result.unrelated, "utf8")).toBe("unrelated caller data")
  expectSafe(result)
}
function expectRejected(result: Run) {
  expect(result.result.status, publicLogs(result.logs)).toBe(1)
  expect(result.saves).toEqual([])
  expectSafe(result)
}
function copyDistribution() {
  const directory = join(createRoot(), "standalone distribution with spaces")
  for (const path of ["dist", "persist-auth", "package.json"]) {
    cpSync(resolve(path), join(directory, path), { recursive: true })
  }
  expect(readdirSync(directory).sort()).toEqual(["dist", "package.json", "persist-auth"])
  return directory
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test("manifest sets Node.js 26 and runs only the standalone entry point", () => {
  const manifest = readFileSync(resolve("persist-auth/action.yml"), "utf8")
  expect(manifest).toMatch(/using: composite/)
  expect(manifest).toMatch(/uses: actions\/setup-node@/)
  expect(manifest).toMatch(/node-version: ["']?26["']?(?:\s|$)/)
  expect(manifest.match(/^\s+uses:/gm)).toHaveLength(1)
  expect(manifest.match(/^\s+run:/gm)).toHaveLength(1)
  expect(manifest).toContain('run: node "$GITHUB_ACTION_PATH/../dist/persist-auth.js"')
  expect(manifest).not.toMatch(/checkout|npm install|pi --|coding-agent/i)
  for (const [input, required] of [
    ["auth-file", true],
    ["token", true],
    ["environment", false],
    ["secret-name", false],
    ["auth-json", false],
  ] as const) {
    expect(manifest).toMatch(
      new RegExp(`^  ${input}:\\n(?:(?: {4}.+|)\\n)*?    required: ${required}`, "m"),
    )
  }
  expect(manifest).toMatch(/environment:\n(?: {4}.+\n)*? {4}default: pi-oauth/)
  expect(manifest).toMatch(/secret-name:\n(?: {4}.+\n)*? {4}default: PI_AUTH_JSON/)
  for (const [variable, input] of [
    ["PI_AUTH_FILE", "auth-file"],
    ["PI_AUTH_TOKEN", "token"],
    ["PI_AUTH_ENVIRONMENT", "environment"],
    ["PI_AUTH_SECRET", "secret-name"],
    ["PI_AUTH_JSON", "auth-json"],
  ]) {
    expect(manifest).toContain(`${variable}: \${{ inputs.${input} }}`)
  }
})

describe("standalone persistence", () => {
  test("preserves the complete document and uses the default environment secret", () => {
    const result = run(fixture())
    expect(result.result.status, result.logs).toBe(0)
    expect(JSON.parse(result.saved)).toEqual(auth)
    expect(result.calls.map((call) => [call.command, call.args])).toEqual([
      ["gh", ["api", "repos/owner/repo/environments/pi-oauth/secrets/PI_AUTH_JSON"]],
      ["gh", ["secret", "set", "PI_AUTH_JSON", "--env", "pi-oauth", "--repo", "owner/repo"]],
    ])
    expectConsumed(result)
  })

  test("uses an encoded custom environment and the caller repository", () => {
    const environment = "OAuth / CI ü"
    const result = run(fixture(), {
      PI_AUTH_ENVIRONMENT: environment,
      PI_AUTH_SECRET: "CUSTOM_AUTH",
      GITHUB_REPOSITORY: "another-owner/another.repo",
      MOCK_METADATA: '{"name":"custom_auth"}',
    })
    expect(result.result.status, result.logs).toBe(0)
    expect(result.calls[0].args).toEqual([
      "api",
      `repos/another-owner/another.repo/environments/${encodeURIComponent(environment)}/secrets/CUSTOM_AUTH`,
    ])
    expect(result.saves[0].args).toEqual([
      "secret",
      "set",
      "CUSTOM_AUTH",
      "--env",
      environment,
      "--repo",
      "another-owner/another.repo",
    ])
    expectConsumed(result)
  })

  test.each([
    ["github.com", false],
    ["tenant.ghe.com", false],
    ["github.enterprise.example", true],
  ])("scopes the writer token to secret subprocesses on %s", (host, enterprise) => {
    const changed = { ...auth, "openai-codex": { ...oauth, access: "synthetic-old-access" } }
    const saved = run(fixture(), {
      GITHUB_SERVER_URL: `https://${host}`,
      PI_AUTH_JSON: JSON.stringify(changed),
    })
    expect(saved.result.status, saved.logs).toBe(0)
    expect(saved.calls).toHaveLength(2)
    for (const call of saved.calls) {
      expect(call.command).toBe("gh")
      expect(call.env).toEqual({
        GH_HOST: host,
        GH_TOKEN: writerToken,
        ...(enterprise ? { GH_ENTERPRISE_TOKEN: writerToken } : {}),
      })
    }
    expectConsumed(saved)
  })

  test("skips the write for semantic equality, including reordered object keys", () => {
    const reordered = Object.fromEntries(
      Object.entries(auth)
        .reverse()
        .map(([provider, credential]) => [
          provider,
          Object.fromEntries(Object.entries(credential).reverse()),
        ]),
    )
    const result = run(fixture(JSON.stringify(reordered, null, 2)), {
      PI_AUTH_JSON: JSON.stringify(auth),
    })
    expect(result.result.status, result.logs).toBe(0)
    expect(result.saves).toEqual([])
    expectConsumed(result)
  })

  test.each([0, -1, 1.5])("accepts finite numeric OAuth expiry %s", (expires) => {
    const document = { provider: { ...oauth, expires } }
    const result = run(fixture(JSON.stringify(document)))
    expect(result.result.status, result.logs).toBe(0)
    expect(JSON.parse(result.saved)).toEqual(document)
    expectConsumed(result)
  })

  test("saves changed provider metadata instead of dropping it", () => {
    const updated = { ...auth, anthropic: { ...auth.anthropic, metadata: { retained: false } } }
    const result = run(fixture(JSON.stringify(updated)), { PI_AUTH_JSON: JSON.stringify(auth) })
    expect(result.result.status, result.logs).toBe(0)
    expect(JSON.parse(result.saved)).toEqual(updated)
    expectConsumed(result)
  })

  test.each([
    { type: "api_key" },
    { type: "api_key", env: { API_KEY: "synthetic-env-reference" } },
    { type: "api_key", key: "", env: {} },
  ])("accepts canonical API-key providers alongside OAuth: %j", (credential) => {
    const document = { oauth, additional: credential }
    const result = run(fixture(JSON.stringify(document)))
    expect(result.result.status, result.logs).toBe(0)
    expect(JSON.parse(result.saved)).toEqual(document)
    expectConsumed(result)
  })
})

const invalidDocuments: [string, string][] = [
  ["malformed JSON", "{"],
  ["null document", "null"],
  ["array document", "[]"],
  ["string document", '"synthetic"'],
  ["empty provider map", "{}"],
  ["API-key-only document", JSON.stringify({ anthropic: auth.anthropic })],
  ["nonfinite expiry", '{"provider":{"type":"oauth","access":"a","refresh":"b","expires":1e400}}'],
  ...[
    null,
    [],
    "credential",
    42,
    {},
    { type: "unknown" },
    { type: "api-key", key: "synthetic" },
    { type: "api_key", key: 42 },
    { type: "api_key", key: null },
    { type: "api_key", env: null },
    { type: "api_key", env: [] },
    { type: "api_key", env: { API_KEY: 42 } },
    { type: "api_key", env: "API_KEY" },
    { type: "oauth", access: oauth.access, refresh: oauth.refresh },
    { ...oauth, access: " " },
    { ...oauth, access: 42 },
    { ...oauth, access: null },
    { ...oauth, refresh: "\t" },
    { ...oauth, refresh: 42 },
    { ...oauth, refresh: null },
    { ...oauth, expires: "1900000000000" },
    { ...oauth, expires: null },
    { ...oauth, expires: {} },
  ].map((credential, index): [string, string] => [
    `invalid unrelated provider ${index}`,
    JSON.stringify({ "openai-codex": oauth, unrelated: credential }),
  ]),
  [
    "oversized document",
    JSON.stringify({ provider: { ...oauth, metadata: "x".repeat(48 * 1024) } }),
  ],
  [
    "oversized UTF-8 document",
    JSON.stringify({ provider: { ...oauth, metadata: "ü".repeat(25 * 1024) } }),
  ],
]

describe("validation and handled failure cleanup", () => {
  test.each(invalidDocuments)("rejects and consumes %s", (_name, contents) => {
    const result = run(fixture(contents))
    expectRejected(result)
    expectConsumed(result)
  })

  test.each([
    "{",
    "{}",
    '{"provider":{"type":"api_key","key":"synthetic"}}',
    JSON.stringify({ ...auth, unrelated: { type: "oauth", access: "incomplete" } }),
  ])("rejects an invalid original document: %s", (original) => {
    const result = run(fixture(), { PI_AUTH_JSON: original })
    expectRejected(result)
    expectConsumed(result)
  })

  test.each([
    ["missing token", { PI_AUTH_TOKEN: "" }],
    ["blank token", { PI_AUTH_TOKEN: " " }],
    ["invalid secret", { PI_AUTH_SECRET: "bad-secret-name" }],
    ["reserved secret", { PI_AUTH_SECRET: "github_AUTH" }],
    ["control character in environment", { PI_AUTH_ENVIRONMENT: "OAuth\nCI" }],
    ["overlong environment", { PI_AUTH_ENVIRONMENT: "x".repeat(256) }],
    ["invalid repository", { GITHUB_REPOSITORY: "owner/repo/other" }],
    ["traversal repository", { GITHUB_REPOSITORY: "owner/.." }],
    ["insecure server", { GITHUB_SERVER_URL: "http://github.com" }],
    ["server credentials", { GITHUB_SERVER_URL: "https://user:password@github.com" }],
    ["malformed server", { GITHUB_SERVER_URL: "not-a-url" }],
  ] satisfies [string, Record<string, string>][])(
    "rejects %s and consumes private input",
    (_name, env) => {
      const result = run(fixture(), env)
      expectRejected(result)
      expectConsumed(result)
    },
  )

  test.each(["null", "[]", "{}", '{"name":42}', '{"name":"WRONG_SECRET"}', "malformed"])(
    "rejects malformed secret metadata: %s",
    (metadata) => {
      const result = run(fixture(), { MOCK_METADATA: metadata })
      expectRejected(result)
      expectConsumed(result)
    },
  )

  test.each(["preflight", "save"])("sanitizes both diagnostic streams on %s failure", (stage) => {
    const result = run(fixture(), { MOCK_FAILURE: stage })
    expect(result.result.status, publicLogs(result.logs)).toBe(1)
    expect(result.saves).toHaveLength(stage === "save" ? 1 : 0)
    expect(publicLogs(result.logs)).toMatch(/environment|secret|permission/i)
    expectConsumed(result)
  })

  test("accepts a document at the 48 KiB limit", () => {
    const base = { provider: { ...oauth, metadata: "" } }
    const padding = 48 * 1024 - Buffer.byteLength(JSON.stringify(base), "utf8")
    const document = { provider: { ...oauth, metadata: "x".repeat(padding) } }
    expect(Buffer.byteLength(JSON.stringify(document), "utf8")).toBe(48 * 1024)
    const result = run(fixture(JSON.stringify(document)))
    expect(result.result.status, result.logs).toBe(0)
    expect(JSON.parse(result.saved)).toEqual(document)
    expectConsumed(result)
  })
})

describe("private input ownership", () => {
  test("fails safely when the input is missing", () => {
    const f = fixture()
    rmSync(f.path)
    const result = run(f)
    expectRejected(result)
    expect(existsSync(f.unrelated)).toBe(true)
  })

  test.each([0o000, 0o400, 0o644, 0o660, 0o700])(
    "rejects file mode %i without deleting it",
    (mode) => {
      const f = fixture()
      chmodSync(f.path, mode)
      const result = run(f)
      expectRejected(result)
      expect(lstatSync(f.path).mode & 0o777).toBe(mode)
    },
  )

  test.each([0o750, 0o755, 0o777])("rejects parent mode %i without deleting input", (mode) => {
    const f = fixture()
    chmodSync(f.parent, mode)
    const result = run(f)
    expectRejected(result)
    expect(readFileSync(f.path, "utf8")).toBe(JSON.stringify(auth))
  })

  test("rejects multiple hard links without deleting either link", () => {
    const f = fixture()
    const alias = join(f.parent, "auth-alias.json")
    linkSync(f.path, alias)
    const result = run(f)
    expectRejected(result)
    expect(lstatSync(f.path).nlink).toBe(2)
    expect(readFileSync(alias, "utf8")).toBe(JSON.stringify(auth))
  })

  test("rejects a directory without deleting caller contents", () => {
    const f = fixture()
    rmSync(f.path)
    mkdirSync(f.path, { mode: 0o700 })
    writeFileSync(join(f.path, "keep"), "caller data")
    const result = run(f)
    expectRejected(result)
    expect(readFileSync(join(f.path, "keep"), "utf8")).toBe("caller data")
  })

  test.each(["missing", "relative", "outside", "prefix sibling", "traversal"])(
    "rejects %s paths without deleting private files",
    (kind) => {
      const f = fixture()
      const outside = join(f.root, "runner temporary files sibling")
      mkdirSync(outside, { mode: 0o700 })
      const outsideFile = join(outside, "auth.json")
      writeFileSync(outsideFile, JSON.stringify(auth), { mode: 0o600 })
      const paths: Record<string, string> = {
        missing: "",
        relative: "../runner temporary files/private handoff/auth.json",
        outside: outsideFile,
        "prefix sibling": outsideFile,
        traversal: `${f.runner}/../runner temporary files sibling/auth.json`,
      }
      const result = run(f, { PI_AUTH_FILE: paths[kind] })
      expectRejected(result)
      expect(existsSync(f.path)).toBe(true)
      expect(readFileSync(outsideFile, "utf8")).toBe(JSON.stringify(auth))
    },
  )

  test.each(["file", "parent", "ancestor"])(
    "rejects a symlinked %s below canonical RUNNER_TEMP",
    (kind) => {
      const f = fixture()
      let path = f.path
      if (kind === "file") {
        path = join(f.parent, "linked-auth.json")
        symlinkSync(f.path, path)
      } else if (kind === "parent") {
        const alias = join(f.runner, "linked-parent")
        symlinkSync(f.parent, alias, "dir")
        path = join(alias, "auth.json")
      } else {
        const alias = join(f.runner, "linked-ancestor")
        symlinkSync(f.runner, alias, "dir")
        path = join(alias, "private handoff/auth.json")
      }
      const result = run(f, { PI_AUTH_FILE: path })
      expectRejected(result)
      expect(readFileSync(f.path, "utf8")).toBe(JSON.stringify(auth))
      expect(
        lstatSync(
          kind === "file"
            ? path
            : join(f.runner, kind === "parent" ? "linked-parent" : "linked-ancestor"),
        ).isSymbolicLink(),
      ).toBe(true)
    },
  )

  test("canonicalizes RUNNER_TEMP itself before checking its descendants", () => {
    const f = fixture()
    const alias = join(f.root, "runner alias")
    symlinkSync(f.runner, alias, "dir")
    const result = run(f, { RUNNER_TEMP: alias })
    expect(result.result.status, result.logs).toBe(0)
    expectConsumed(result)
  })

  test.each(["preflight", "save"])("does not unlink a file substituted during %s", (stage) => {
    const result = run(fixture(), { MOCK_RACE_STAGE: stage, MOCK_RACE_KIND: "file" })
    expect(readFileSync(result.path, "utf8")).toBe("replacement file contents")
    if (result.saved) expect(JSON.parse(result.saved)).toEqual(auth)
    expect(readFileSync(result.unrelated, "utf8")).toBe("unrelated caller data")
    expectSafe(result)
  })

  test("reports cleanup failure after a successful save without deleting a replacement directory", () => {
    const result = run(fixture(), { MOCK_RACE_STAGE: "save", MOCK_RACE_KIND: "directory" })
    expect(result.result.status, publicLogs(result.logs)).toBe(1)
    expect(JSON.parse(result.saved)).toEqual(auth)
    expect(readFileSync(join(result.path, "unrelated"), "utf8")).toBe(
      "replacement directory contents",
    )
    expectSafe(result)
  })

  test.each(["symlink", "directory"])(
    "preserves a substituted %s after failed write and cleanup",
    (kind) => {
      const result = run(fixture(), {
        MOCK_RACE_STAGE: "save",
        MOCK_RACE_KIND: kind,
        MOCK_FAILURE: "save",
      })
      expect(result.result.status, publicLogs(result.logs)).toBe(1)
      expect(publicLogs(result.logs)).toMatch(/save|secret|write/i)
      expect(publicLogs(result.logs)).toMatch(/clean|remov|consum|replac|chang|identity/i)
      expect(readFileSync(result.unrelated, "utf8")).toBe("unrelated caller data")
      if (kind === "symlink") expect(lstatSync(result.path).isSymbolicLink()).toBe(true)
      else
        expect(readFileSync(join(result.path, "unrelated"), "utf8")).toBe(
          "replacement directory contents",
        )
      expectSafe(result)
    },
  )
})

describe("standalone distribution", () => {
  test("runs from a copied path with spaces without source or dependencies", () => {
    const distribution = copyDistribution()
    expect(existsSync(join(distribution, "src"))).toBe(false)
    expect(existsSync(join(distribution, "node_modules"))).toBe(false)
    const result = run(fixture(), {}, distribution)
    expect(result.result.status, result.logs).toBe(0)
    expect(JSON.parse(result.saved)).toEqual(auth)
    expectConsumed(result)
  })

  test("fails when a required generated storage module is missing", () => {
    const distribution = copyDistribution()
    rmSync(join(distribution, "dist/oauth-secret.js"))
    const result = run(fixture(), {}, distribution)
    expect(result.result.status).not.toBe(0)
    expect(result.calls).toEqual([])
    expect(publicLogs(result.logs)).toMatch(/module|import|resolve/i)
    expectSafe(result)
  })
})
