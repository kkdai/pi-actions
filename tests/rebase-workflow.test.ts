import { readFileSync } from "node:fs"
import { expect, test } from "vitest"

const workflow = readFileSync(new URL("../.github/workflows/rebase.yml", import.meta.url), "utf8")
const guide = readFileSync(new URL("../rebase/README.md", import.meta.url), "utf8")

test("automatically handles base pushes and trusted pull request events", () => {
  expect(workflow).toContain("\n  push:\n    branches:\n      - main")
  expect(workflow).toContain("\n  pull_request_target:")
  expect(workflow).toContain("types: [opened, reopened, synchronize, ready_for_review, edited]")
  expect(workflow).not.toContain("\n  pull_request:")
  expect(workflow).toContain("contents: write")
  expect(workflow).toContain("pull-requests: write")
  expect(workflow).toContain("cancel-in-progress: false")
})

test("allows a manual target and passes it to the rebase action", () => {
  expect(workflow).toContain("\n  workflow_dispatch:\n    inputs:\n      pull-request:")
  expect(workflow).toContain("required: false\n        type: string")
  expect(workflow).toContain(`pull-request: \${{ inputs.pull-request }}`)
  expect(workflow).toMatch(/^\s+- uses: narumiruna\/pi-actions\/rebase@[a-f0-9]{40}\s*$/m)
})

test("uses PAT_TOKEN so branch updates can trigger review workflows", () => {
  expect(workflow).toContain(`token: \${{ secrets.PAT_TOKEN }}`)
  expect(workflow.match(/secrets\.PAT_TOKEN/g)).toHaveLength(1)
  expect(workflow).not.toMatch(/secrets\.REBASE_TOKEN|token:.*github\.token/)
})

test("keeps manual single-PR runs out of the batch scan concurrency group", () => {
  expect(workflow).toContain(
    `group: pi-rebase-\${{ github.event.pull_request.number || inputs.pull-request || github.ref }}`,
  )
})

test("does not check out or execute pull request code", () => {
  expect(workflow).not.toMatch(/uses:\s+actions\/checkout@/)
  expect(workflow).not.toContain("github.event.pull_request.head")
  expect(workflow).not.toMatch(/^\s+run:/m)
})

test("the guide's example matches the repository workflow", () => {
  const example = guide.match(/```yaml\n([\s\S]+?)```/)?.[1]
  const withoutComments = workflow.replace(/^\s*#.*\n/gm, "")
  expect(example).toBe(withoutComments)
})
