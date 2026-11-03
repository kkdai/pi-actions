import { expect, test, vi } from "vitest"
import { listFindingThreads, resolveFindingThread } from "../dist/review-threads.js"

const head = "b".repeat(40)
const originalCommit = "a".repeat(40)
const marker = "<!-- pi-action:finding -->"
const body = `${marker}\n**High: Check the result**\n\nThe result can be missing.`
const diffHunk = "@@ -7 +7 @@\n-old\n+new"
const threadId = "PRRT_1"

function comment(overrides: Record<string, unknown> = {}) {
  return {
    fullDatabaseId: "101",
    body,
    diffHunk,
    originalCommit: { oid: originalCommit },
    author: { __typename: "Bot", login: "github-actions" },
    ...overrides,
  }
}

function thread(overrides: Record<string, unknown> = {}) {
  return {
    id: threadId,
    isResolved: false,
    path: "src/example.ts",
    line: 12,
    originalLine: 7,
    diffSide: "RIGHT",
    comments: { nodes: [comment()] },
    ...overrides,
  }
}

function page(nodes: unknown[] = [], hasNextPage = false, endCursor: string | null = null) {
  return {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: { nodes, pageInfo: { hasNextPage, endCursor } },
        },
      },
    },
  }
}

function mockApi(...responses: unknown[]) {
  const api = vi.fn<(args: string[]) => string>()
  for (const response of responses) api.mockReturnValueOnce(JSON.stringify(response))
  return api
}

test.each(["github-actions", "github-actions[bot]"])(
  "lists older marked findings from the %s Bot with their original context",
  (login) => {
    const root = comment({ author: { __typename: "Bot", login } })
    const api = mockApi(page([thread({ comments: { nodes: [root] } })]))
    expect(listFindingThreads(api, "owner/repo", 42, head)).toEqual([
      {
        id: threadId,
        comment_id: 101,
        path: "src/example.ts",
        line: 12,
        original_line: 7,
        side: "RIGHT",
        body,
        original_diff_hunk: diffHunk,
        original_commit: originalCommit,
      },
    ])
  },
)

test.each([
  { line: null, originalLine: 7 },
  { line: 12, originalLine: null },
  { line: null, originalLine: null },
])("preserves nullable coordinates and the diff side: %j", (coordinates) => {
  const api = mockApi(page([thread({ ...coordinates, diffSide: "LEFT" })]))
  expect(listFindingThreads(api, "owner/repo", 42, head)).toEqual([
    expect.objectContaining({
      line: coordinates.line,
      original_line: coordinates.originalLine,
      side: "LEFT",
    }),
  ])
})

test.each([
  null,
  { __typename: "User", login: "reviewer" },
  { __typename: "User", login: "github-actions" },
  { __typename: "User", login: "github-actions[bot]" },
  { __typename: "Bot", login: "other[bot]" },
])("ignores marked roots with an ineligible author: %j", (author) => {
  const api = mockApi(page([thread({ comments: { nodes: [comment({ author })] } })]))
  expect(listFindingThreads(api, "owner/repo", 42, head)).toEqual([])
})

test.each([
  "",
  "An unmarked finding.",
  "<!-- pi-action:summary -->",
  `Quoted:\n${body}`,
  `\n${body}`,
])("ignores Bot roots without a finding marker at the start: %j", (unmarkedBody) => {
  const root = comment({ body: unmarkedBody })
  const api = mockApi(page([thread({ comments: { nodes: [root] } })]))
  expect(listFindingThreads(api, "owner/repo", 42, head)).toEqual([])
})

test.each([
  { author: { __typename: "User", login: "reviewer" } },
  { author: { __typename: "Bot", login: "other[bot]" } },
  { author: null },
  { body: "An unmarked root." },
])("does not let a marked Bot reply confer ownership on a root: %j", (overrides) => {
  const nodes = [comment(overrides), comment({ fullDatabaseId: "202" })]
  const api = mockApi(page([thread({ comments: { nodes } })]))
  expect(listFindingThreads(api, "owner/repo", 42, head)).toEqual([])
})

test.each([
  { originalCommit: { oid: head } },
  { originalCommit: null },
  { originalCommit: undefined },
  { fullDatabaseId: null },
  { fullDatabaseId: undefined },
  { fullDatabaseId: "0" },
  { fullDatabaseId: "-1" },
  { fullDatabaseId: "1.5" },
  { fullDatabaseId: String(Number.MAX_SAFE_INTEGER + 1) },
  { fullDatabaseId: 101 },
  { fullDatabaseId: "1e2" },
  { fullDatabaseId: "101/replies" },
])("ignores roots without an older origin commit and a valid comment ID: %j", (overrides) => {
  const api = mockApi(page([thread({ comments: { nodes: [comment(overrides)] } })]))
  expect(listFindingThreads(api, "owner/repo", 42, head)).toEqual([])
})

test("preserves comment IDs above the 32-bit integer range for REST replies", () => {
  const root = comment({ fullDatabaseId: "4457407377" })
  const api = mockApi(page([thread({ comments: { nodes: [root] } })]))
  expect(listFindingThreads(api, "owner/repo", 42, head)[0].comment_id).toBe(4457407377)
})

test("ignores already resolved finding threads", () => {
  const api = mockApi(page([thread({ isResolved: true })]))
  expect(listFindingThreads(api, "owner/repo", 42, head)).toEqual([])
})

test("ignores threads without a root comment", () => {
  const api = mockApi(page([thread({ comments: { nodes: [] } })]))
  expect(listFindingThreads(api, "owner/repo", 42, head)).toEqual([])
})

test("lists every page in order, including after an empty page, with typed query variables", () => {
  const api = mockApi(
    page([thread(), thread({ id: "PRRT_resolved", isResolved: true })], true, "cursor-1"),
    page([], true, "cursor-2"),
    page([thread({ id: "PRRT_2" })], false, "cursor-2"),
  )
  expect(listFindingThreads(api, "octo/widgets", 123, head).map(({ id }) => id)).toEqual([
    threadId,
    "PRRT_2",
  ])
  expect(api).toHaveBeenCalledTimes(3)
  for (const [args] of api.mock.calls) {
    expect(args.slice(0, 2)).toEqual(["graphql", "-f"])
    expect(args[2]).toContain("$owner: String!, $name: String!, $number: Int!, $cursor: String")
    expect(args[2]).toContain("reviewThreads(first: 100, after: $cursor)")
    expect(args[2]).toContain("comments(first: 1)")
    expect(args[2]).toContain("fullDatabaseId")
    expect(args[2]).not.toMatch(/\bdatabaseId\b/)
  }
  const variables = ["-f", "owner=octo", "-f", "name=widgets", "-F", "number=123"]
  expect(api.mock.calls.map(([args]) => args.slice(3))).toEqual([
    variables,
    [...variables, "-f", "cursor=cursor-1"],
    [...variables, "-f", "cursor=cursor-2"],
  ])
})

test.each([null, ""])("rejects a missing next-page cursor: %j", (cursor) => {
  const api = mockApi(page([], true, cursor))
  expect(() => listFindingThreads(api, "owner/repo", 42, head)).toThrow(
    /invalid review thread cursor/,
  )
  expect(api).toHaveBeenCalledTimes(1)
})

test("rejects a next-page cursor that does not advance", () => {
  const api = mockApi(page([], true, "cursor-1"), page([], true, "cursor-1"))
  expect(() => listFindingThreads(api, "owner/repo", 42, head)).toThrow(
    /invalid review thread cursor/,
  )
  expect(api).toHaveBeenCalledTimes(2)
})

test("rejects a next-page cursor that cycles back to an earlier page", () => {
  const api = mockApi(
    page([], true, "cursor-1"),
    page([], true, "cursor-2"),
    page([], true, "cursor-1"),
  )
  expect(() => listFindingThreads(api, "owner/repo", 42, head)).toThrow(
    /invalid review thread cursor/,
  )
  expect(api).toHaveBeenCalledTimes(3)
})

test.each([
  {},
  { data: null },
  { errors: [{ message: "Access denied." }] },
  { ...page([thread()]), errors: [{ message: "Partial data." }] },
])("rejects GraphQL errors or missing data when listing threads: %j", (response) => {
  const api = mockApi(response)
  expect(() => listFindingThreads(api, "owner/repo", 42, head)).toThrow(/GraphQL request failed/)
})

test.each([
  null,
  {},
  { pullRequest: null },
  { pullRequest: {} },
  { pullRequest: { reviewThreads: null } },
])("rejects a missing repository, pull request, or review thread connection: %j", (repository) => {
  const api = mockApi({ data: { repository } })
  expect(() => listFindingThreads(api, "owner/repo", 42, head)).toThrow(
    /did not return the pull request review threads/,
  )
})

test("does not return partial findings when a later page fails", () => {
  const api = mockApi(page([thread()], true, "cursor-1"), { errors: [{ message: "Page failed." }] })
  expect(() => listFindingThreads(api, "owner/repo", 42, head)).toThrow(/GraphQL request failed/)
  expect(api).toHaveBeenCalledTimes(2)
})

test("resolves the supplied finding thread with a GraphQL variable", () => {
  const api = mockApi({
    data: { resolveReviewThread: { thread: { id: threadId, isResolved: true } } },
  })
  resolveFindingThread(api, threadId)
  expect(api).toHaveBeenCalledTimes(1)
  expect(api).toHaveBeenCalledWith([
    "graphql",
    "-f",
    expect.stringContaining("resolveReviewThread(input: { threadId: $id })"),
    "-f",
    `id=${threadId}`,
  ])
  expect(api.mock.calls[0][0][2]).toContain("mutation($id: ID!)")
})

test.each([
  {},
  { data: null },
  { errors: [{ message: "Access denied." }] },
  {
    data: { resolveReviewThread: { thread: { id: threadId, isResolved: true } } },
    errors: [{ message: "Partial data." }],
  },
])("rejects GraphQL errors or missing data when resolving a thread: %j", (response) => {
  const api = mockApi(response)
  expect(() => resolveFindingThread(api, threadId)).toThrow(/GraphQL request failed/)
})

test.each([
  undefined,
  null,
  {},
  { thread: null },
  { thread: {} },
  { thread: { id: threadId } },
  { thread: { isResolved: true } },
  { thread: { id: threadId, isResolved: false } },
  { thread: { id: "PRRT_other", isResolved: true } },
])("rejects missing, mismatched, or unresolved mutation results: %j", (resolveReviewThread) => {
  const api = mockApi({ data: { resolveReviewThread } })
  expect(() => resolveFindingThread(api, threadId)).toThrow(/did not resolve the review thread/)
  expect(api).toHaveBeenCalledTimes(1)
})
