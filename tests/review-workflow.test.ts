import { readFileSync } from "node:fs"
import { expect, test } from "vitest"

const workflow = readFileSync(new URL("../.github/workflows/review.yml", import.meta.url), "utf8")

test("pins the repository review action to a full commit SHA", () => {
  expect(workflow).toMatch(/^\s+(?:- )?uses: narumiruna\/pi-action\/review@[a-f0-9]{40}\s*$/m)
})

test("keeps automatic reviews on the trusted pull_request_target event", () => {
  expect(workflow).toContain("\n  pull_request_target:")
  expect(workflow).not.toContain("\n  pull_request:")
})

test("does not check out or select the pull request head as action code", () => {
  expect(workflow).not.toMatch(/uses:\s+actions\/checkout@/)
  expect(workflow).not.toContain("github.event.pull_request.head")
})
