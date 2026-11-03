import { expect, test } from "vitest"
import { buildReview, summaryMarker } from "../dist/review-output.js"

const head = "b".repeat(40)
const pullRequestUrl = "https://github.com/owner/repo/pull/42"
const fileDiffUrl = `${pullRequestUrl}/files/${head}#diff-c2367a00abc15282c1e43ae86544aef6825813116411291ec398336737cee78c`
const diff = [
  "diff --git a/example.ts b/example.ts",
  "--- a/example.ts",
  "+++ b/example.ts",
  "@@ -1,3 +1,4 @@",
  " first",
  "-old",
  "+new",
  "+extra",
  " last",
  "",
].join("\n")

type Location = {
  path: string
  line: number
  side: "LEFT" | "RIGHT"
  start_line?: number
}

function finding(location: Location | null = null, overrides: Record<string, unknown> = {}) {
  return {
    severity: "high",
    title: "Check the result",
    body: "The result can be missing. Check it before use.",
    location,
    ...overrides,
  }
}

function raw(findings: unknown[] = [], summary = "Review complete.") {
  return JSON.stringify({ summary, findings })
}

const addition: Location = { path: "example.ts", line: 2, side: "RIGHT" }

test("renders a marked summary for a review without findings", () => {
  const result = buildReview(
    raw([], "No actionable findings in the supplied diff."),
    diff,
    head,
    pullRequestUrl,
  )
  expect(summaryMarker).toBe("<!-- pi-action:summary -->")
  expect(result).toEqual({
    body: `${summaryMarker}\n## Pi review\n\nNo actionable findings in the supplied diff.\n\n---\n\n<sub>Reviewed commit: [\`bbbbbbb\`](${pullRequestUrl}/commits/${head}) · This review covers only the supplied diff.</sub>`,
    comments: [],
  })
})

test.each([
  "",
  "plain prose",
  '```json\n{"summary":"ok","findings":[]}\n```',
  'Review: {"summary":"ok","findings":[]}',
  '{"summary":"ok","findings":[]} trailing',
  '{"summary":"ok","findings":[]} {}',
  '{"summary":"ok","findings":[],}',
])("rejects malformed or wrapped JSON: %j", (value) => {
  expect(() => buildReview(value, diff, head, pullRequestUrl)).toThrow(/JSON object/)
})

test("accepts JSON whitespace but not non-string raw input", () => {
  expect(buildReview(` \n${raw()}\t`, diff, head, pullRequestUrl).comments).toEqual([])
  expect(() => buildReview({ summary: "ok", findings: [] }, diff, head, pullRequestUrl)).toThrow(
    /JSON object/,
  )
})

test.each([
  null,
  [],
  "summary",
  1,
  {},
  { summary: "ok" },
  { findings: [] },
  { summary: "", findings: [] },
  { summary: " \n", findings: [] },
  { summary: 1, findings: [] },
  { summary: "ok", findings: null },
  { summary: "ok", findings: {} },
  { summary: "ok", findings: [], extra: true },
])("rejects invalid top-level schema: %j", (value) => {
  expect(() => buildReview(JSON.stringify(value), diff, head, pullRequestUrl)).toThrow(/schema/)
})

test.each([
  null,
  [],
  {},
  finding(null, { severity: "urgent" }),
  finding(null, { severity: "High" }),
  finding(null, { title: "" }),
  finding(null, { title: " \n" }),
  finding(null, { title: 12 }),
  finding(null, { body: "" }),
  finding(null, { body: "\t" }),
  finding(null, { body: false }),
  finding(null, { location: undefined }),
  finding(null, { extra: true }),
])("rejects invalid findings before rendering: %j", (value) => {
  expect(() => buildReview(raw([finding(addition), value]), diff, head, pullRequestUrl)).toThrow(
    /schema/,
  )
})

test.each([
  [],
  "example.ts:2",
  {},
  { ...addition, path: "" },
  { ...addition, path: 1 },
  { ...addition, line: "2" },
  { ...addition, line: 0 },
  { ...addition, line: -1 },
  { ...addition, line: 1.5 },
  { ...addition, line: Number.MAX_SAFE_INTEGER + 1 },
  { ...addition, side: "right" },
  { ...addition, start_line: 0 },
  { ...addition, start_line: "1" },
  { ...addition, start_line: null },
  { ...addition, start_line: 1.5 },
  { ...addition, start_side: "RIGHT" },
])("rejects invalid location types instead of using summary fallback: %j", (location) => {
  expect(() => buildReview(raw([finding(null, { location })]), diff, head, pullRequestUrl)).toThrow(
    /schema/,
  )
})

test("anchors a single-line addition and lists it without duplicating its full body", () => {
  const result = buildReview(raw([finding(addition)]), diff, head, pullRequestUrl)
  expect(result.comments).toEqual([
    {
      ...addition,
      body: "<!-- pi-action:finding -->\n**High: Check the result**\n\nThe result can be missing. Check it before use.",
    },
  ])
  expect(result.body).toContain(
    `### Inline findings (1)\n\n- **High: Check the result**  \n  [\`example.ts:2\`](${fileDiffUrl}R2)`,
  )
  expect(result.body).not.toContain("The result can be missing")
})

test("puts the summary first, separates finding locations, and keeps metadata last", () => {
  const result = buildReview(
    raw([
      finding(addition),
      finding(addition, { severity: "medium", title: "Keep the checkbox state" }),
      finding(null, { severity: "low", title: "Check the fallback" }),
    ]),
    diff,
    head,
    pullRequestUrl,
  )
  expect(result.body).toBe(
    [
      `${summaryMarker}\n## Pi review`,
      "Review complete.",
      `### Inline findings (2)\n\n- **High: Check the result**  \n  [\`example.ts:2\`](${fileDiffUrl}R2)\n\n- **Medium: Keep the checkbox state**  \n  [\`example.ts:2\`](${fileDiffUrl}R2)`,
      "### Summary-only findings (1)\n\n#### Low: Check the fallback\n\nGeneral finding\n\nThe result can be missing. Check it before use.",
      "---",
      `<sub>Reviewed commit: [\`bbbbbbb\`](${pullRequestUrl}/commits/${head}) · This review covers only the supplied diff.</sub>`,
    ].join("\n\n"),
  )
})

test.each([
  ["a[`b`].ts", "`` a[`b`].ts:1 ``"],
  ["a``b.ts", "``` a``b.ts:1 ```"],
])("keeps backticks in the location link label for %s", (path, label) => {
  const patch = `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`
  const result = buildReview(
    raw([finding({ path, line: 1, side: "RIGHT" })]),
    patch,
    head,
    pullRequestUrl,
  )
  expect(result.body).toContain(`[${label}](${pullRequestUrl}/files/${head}#diff-`)
  expect(result.comments).toHaveLength(1)
})

test.each(["critical", "high", "medium", "low"])("capitalizes %s inline severity", (severity) => {
  const result = buildReview(raw([finding(addition, { severity })]), diff, head, pullRequestUrl)
  const capitalized = severity[0].toUpperCase() + severity.slice(1)
  expect(result.comments[0].body).toContain(`**${capitalized}: Check the result**`)
})

test("anchors deleted lines on LEFT and context lines on RIGHT", () => {
  const deleted: Location = { path: "example.ts", line: 2, side: "LEFT" }
  const context: Location = { path: "example.ts", line: 4, side: "RIGHT" }
  const result = buildReview(raw([finding(deleted), finding(context)]), diff, head, pullRequestUrl)
  expect(result.comments).toHaveLength(2)
  expect(result.comments[0]).toMatchObject(deleted)
  expect(result.comments[1]).toMatchObject(context)
  expect(result.body).toContain(`[\`example.ts:2\` (removed)](${fileDiffUrl}L2)`)
  expect(result.body).toContain(`[\`example.ts:4\`](${fileDiffUrl}R4)`)
  expect(result.body).not.toContain("(LEFT)")
  expect(result.body).not.toContain("(RIGHT)")
})

test("renders a RIGHT range with start_side and omits range fields for one line", () => {
  const result = buildReview(
    raw([
      finding({ ...addition, start_line: 2, line: 4 }),
      finding({ ...addition, start_line: 2 }),
    ]),
    diff,
    head,
    pullRequestUrl,
  )
  expect(result.comments[0]).toMatchObject({
    path: "example.ts",
    start_line: 2,
    start_side: "RIGHT",
    line: 4,
    side: "RIGHT",
  })
  expect(result.comments[1]).not.toHaveProperty("start_line")
  expect(result.comments[1]).not.toHaveProperty("start_side")
  expect(result.body).toContain(`[\`example.ts:2-4\`](${fileDiffUrl}R2-R4)`)
  expect(result.body).toContain(`[\`example.ts:2\`](${fileDiffUrl}R2)`)
})

test("renders a multiline deletion with LEFT start_side", () => {
  const patch = "--- a/old.ts\n+++ /dev/null\n@@ -4,2 +0,0 @@\n-one\n-two\n"
  const result = buildReview(
    raw([finding({ path: "old.ts", start_line: 4, line: 5, side: "LEFT" })]),
    patch,
    head,
    pullRequestUrl,
  )
  expect(result.comments[0]).toMatchObject({
    path: "old.ts",
    start_line: 4,
    start_side: "LEFT",
    line: 5,
    side: "LEFT",
  })
  expect(result.body).toContain("[`old.ts:4-5` (removed)]")
  expect(result.body).toContain("L4-L5)")
})

test.each([
  { ...addition, path: "missing.ts" },
  { ...addition, path: "a/example.ts" },
  { ...addition, path: "../example.ts" },
  { ...addition, line: 100 },
  { ...addition, line: Number.MAX_SAFE_INTEGER },
  { ...addition, start_line: 3, line: 2 },
  { ...addition, start_line: 1, line: 100 },
  { ...addition, line: 3, side: "LEFT" as const },
  { ...addition, line: 1, side: "LEFT" as const },
])("preserves unanchorable findings and other valid findings: %j", (location) => {
  const result = buildReview(
    raw([finding(location, { title: "Unanchored" }), finding(addition, { title: "Anchored" })]),
    diff,
    head,
    pullRequestUrl,
  )
  expect(result.comments).toHaveLength(1)
  expect(result.comments[0].body).toContain("Anchored")
  expect(result.body).toContain("### Summary-only findings (1)\n\n#### High: Unanchored")
  expect(result.body).toContain("### Inline findings (1)")
  expect(result.body).toContain("The result can be missing. Check it before use.")
  expect(result.body).toContain(location.path)
})

test("retains the full body of general findings, including with an empty diff", () => {
  const result = buildReview(raw([finding(), finding(addition)]), "", head, pullRequestUrl)
  expect(result.comments).toEqual([])
  expect(result.body).toContain("General finding")
  expect(result.body).toContain("`example.ts:2`")
  expect(result.body).toContain("### Summary-only findings (2)")
  expect(result.body).not.toContain("/files/")
  expect(result.body.match(/The result can be missing/g)).toHaveLength(2)
})

test("rejects cross-hunk ranges even when the hunk line numbers are adjacent", () => {
  const patch = [
    "--- a/example.ts",
    "+++ b/example.ts",
    "@@ -1 +1 @@",
    "-old",
    "+one",
    "@@ -2 +2 @@",
    "-old",
    "+two",
    "",
  ].join("\n")
  const result = buildReview(
    raw([finding({ ...addition, start_line: 1 }), finding(addition)]),
    patch,
    head,
    pullRequestUrl,
  )
  expect(result.comments).toHaveLength(1)
  expect(result.body).toContain("`example.ts:1-2`")
  expect(result.body).toContain("The result can be missing")
})

test("maps multiple files, renamed paths, deleted files, and added files", () => {
  const patch = [
    "diff --git a/old.ts b/new.ts",
    "similarity index 50%",
    "rename from old.ts",
    "rename to new.ts",
    "--- a/old.ts",
    "+++ b/new.ts",
    "@@ -5 +5 @@",
    "-old",
    "+new",
    "diff --git a/deleted.ts b/deleted.ts",
    "deleted file mode 100644",
    "--- a/deleted.ts",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-gone",
    "diff --git a/added.ts b/added.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/added.ts",
    "@@ -0,0 +1 @@",
    "+added",
    "",
  ].join("\n")
  const result = buildReview(
    raw([
      finding({ path: "old.ts", line: 5, side: "LEFT" }),
      finding({ path: "new.ts", line: 5, side: "RIGHT" }),
      finding({ path: "deleted.ts", line: 1, side: "LEFT" }),
      finding({ path: "added.ts", line: 1, side: "RIGHT" }),
    ]),
    patch,
    head,
    pullRequestUrl,
  )
  expect(result.comments.map(({ path, line, side }) => ({ path, line, side }))).toEqual([
    { path: "new.ts", line: 5, side: "LEFT" },
    { path: "new.ts", line: 5, side: "RIGHT" },
    { path: "deleted.ts", line: 1, side: "LEFT" },
    { path: "added.ts", line: 1, side: "RIGHT" },
  ])
  const renamedDiffUrl = `${pullRequestUrl}/files/${head}#diff-7cef4b02d457cff42f437223bda0d5827afe4833a5e149f7e2eb141839e391a3`
  expect(result.body).toContain(`[\`new.ts:5\` (removed)](${renamedDiffUrl}L5)`)
  expect(result.body).toContain(`[\`new.ts:5\`](${renamedDiffUrl}R5)`)
})

test("prefers the canonical destination when a renamed source path is reused by a new file", () => {
  const patch = [
    "diff --git a/config.ts b/legacy-config.ts",
    "similarity index 50%",
    "rename from config.ts",
    "rename to legacy-config.ts",
    "--- a/config.ts",
    "+++ b/legacy-config.ts",
    "@@ -1 +1 @@",
    "-old",
    "+legacy",
    "diff --git a/config.ts b/config.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/config.ts",
    "@@ -0,0 +1 @@",
    "+replacement",
    "",
  ].join("\n")
  const result = buildReview(
    raw([
      finding({ path: "config.ts", line: 1, side: "RIGHT" }),
      finding({ path: "legacy-config.ts", line: 1, side: "LEFT" }),
    ]),
    patch,
    head,
    pullRequestUrl,
  )
  expect(result.comments.map(({ path, line, side }) => ({ path, line, side }))).toEqual([
    { path: "config.ts", line: 1, side: "RIGHT" },
    { path: "legacy-config.ts", line: 1, side: "LEFT" },
  ])
})

test.each([
  ["a folder/a file.ts", "a folder/a file.ts", "a folder/a file.ts"],
  ["a folder/a file.ts\t", "a folder/a file.ts\t", "a folder/a file.ts"],
  ["trailing space \t", "trailing space \t", "trailing space "],
  ['"a/a folder/a file.ts"', '"b/a folder/a file.ts"', "a folder/a file.ts"],
  [String.raw`"a/caf\303\251.ts"`, String.raw`"b/caf\303\251.ts"`, "café.ts"],
  [String.raw`"a/a\t\"b\\c.ts"`, String.raw`"b/a\t\"b\\c.ts"`, 'a\t"b\\c.ts'],
])("maps safe space-containing and quoted paths: %s", (oldPath, newPath, path) => {
  const oldHeader = oldPath.startsWith('"') ? oldPath : `a/${oldPath}`
  const newHeader = newPath.startsWith('"') ? newPath : `b/${newPath}`
  const patch = `--- ${oldHeader}\n+++ ${newHeader}\n@@ -1 +1 @@\n-old\n+new\n`
  const result = buildReview(
    raw([finding({ path, line: 1, side: "RIGHT" })]),
    patch,
    head,
    pullRequestUrl,
  )
  expect(result.comments[0]).toMatchObject({ path, line: 1, side: "RIGHT" })
})

test.each([
  String.raw`"b/bad\q.ts"`,
  String.raw`"b/bad\377.ts"`,
  String.raw`"b/bad\777.ts"`,
  '"b/unclosed.ts',
  '"b/extra"quote.ts"',
  "wrong-prefix.ts",
])("preserves findings when a diff path cannot be decoded: %s", (path) => {
  const patch = `--- a/example.ts\n+++ ${path}\n@@ -1 +1 @@\n-old\n+new\n`
  const result = buildReview(
    raw([finding({ ...addition, side: "LEFT", line: 1 })]),
    patch,
    head,
    pullRequestUrl,
  )
  expect(result.comments).toEqual([])
  expect(result.body).toContain("The result can be missing")
})

test("does not interpret source-content header lookalikes as file headers", () => {
  const patch = [
    "diff --git a/example.ts b/example.ts",
    "--- a/example.ts",
    "+++ b/example.ts",
    "@@ -1,2 +1,2 @@",
    "--- a/pretend.ts",
    "+++ b/pretend.ts",
    " context",
    "\\ No newline at end of file",
    "",
  ].join("\n")
  const result = buildReview(
    raw([
      finding({ ...addition, line: 1, side: "LEFT" }),
      finding({ ...addition, line: 1 }),
      finding({ ...addition, line: 2 }),
      finding({ path: "pretend.ts", line: 1, side: "RIGHT" }),
    ]),
    patch,
    head,
    pullRequestUrl,
  )
  expect(result.comments).toHaveLength(3)
  expect(result.comments.every(({ path }) => path === "example.ts")).toBe(true)
  expect(result.body).toContain("`pretend.ts:1`")
})

test("does not anchor truncated hunks or binary and rename-only diff entries", () => {
  const patches = [
    "--- a/example.ts\n+++ b/example.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n",
    "diff --git a/example.ts b/example.ts\nBinary files a/example.ts and b/example.ts differ\n",
    "diff --git a/example.ts b/new.ts\nsimilarity index 100%\nrename from example.ts\nrename to new.ts\n",
  ]
  for (const patch of patches) {
    const result = buildReview(raw([finding(addition)]), patch, head, pullRequestUrl)
    expect(result.comments).toEqual([])
    expect(result.body).toContain("The result can be missing")
  }
})

test("accepts the exact summary body limit and rejects overflow without truncation", () => {
  const baseline = buildReview(raw([], "x"), diff, head, pullRequestUrl).body.length
  const summary = "x".repeat(65536 - baseline + 1)
  expect(buildReview(raw([], summary), diff, head, pullRequestUrl).body).toHaveLength(65536)
  expect(() => buildReview(raw([], `${summary}x`), diff, head, pullRequestUrl)).toThrow(
    /65536-character limit/,
  )
})

test("accepts the exact inline body limit and rejects overflow without truncation", () => {
  const baseline = buildReview(raw([finding(addition, { body: "x" })]), diff, head, pullRequestUrl)
    .comments[0].body.length
  const body = "x".repeat(65536 - baseline + 1)
  const result = buildReview(raw([finding(addition, { body })]), diff, head, pullRequestUrl)
  expect(result.comments[0].body).toHaveLength(65536)
  expect(() =>
    buildReview(raw([finding(addition, { body: `${body}x` })]), diff, head, pullRequestUrl),
  ).toThrow(/65536-character limit/)
})

test("enforces the summary limit for full fallback bodies and lists of anchored findings", () => {
  expect(() =>
    buildReview(raw([finding(null, { body: "x".repeat(65536) })]), diff, head, pullRequestUrl),
  ).toThrow(/65536-character limit/)
  const longTitle = finding(addition, { title: "x".repeat(1000) })
  expect(() => buildReview(raw(Array(70).fill(longTitle)), diff, head, pullRequestUrl)).toThrow(
    /65536-character limit/,
  )
})
