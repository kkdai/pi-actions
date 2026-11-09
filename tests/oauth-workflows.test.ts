import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"

const guide = readFileSync(new URL("../docs/oauth.md", import.meta.url), "utf8")
const examples = [...guide.matchAll(/```yaml\n([\s\S]*?)\n```/g)].map((match) => match[1])

for (const action of ["review", "triage"]) {
  describe(`${action} OAuth configuration`, () => {
    const manifest = readFileSync(new URL(`../${action}/action.yml`, import.meta.url), "utf8")
    const readme = readFileSync(new URL(`../${action}/README.md`, import.meta.url), "utf8")
    const workflow = readFileSync(
      new URL(`../.github/workflows/${action}.yml`, import.meta.url),
      "utf8",
    )
    const example = examples.find((value) => value.includes(`pi-action/${action}@`)) ?? ""

    test("exposes the same optional persistence inputs only to the runtime step", () => {
      for (const [input, variable] of [
        ["auth-secret", "PI_AUTH_SECRET"],
        ["auth-environment", "PI_AUTH_ENVIRONMENT"],
        ["auth-token", "PI_AUTH_TOKEN"],
      ]) {
        expect(manifest).toMatch(
          new RegExp(`^  ${input}:\\n    description: .+\\n    required: false$`, "m"),
        )
        expect(manifest).toContain(`${variable}: \${{ inputs.${input} }}`)
        expect(readme).toContain(`\`${input}\``)
      }
      const setup = manifest.slice(0, manifest.indexOf("      env:"))
      expect(setup).not.toContain(`\${{ inputs.auth-token }}`)
      expect(setup).not.toContain("PI_AUTH_TOKEN:")
      expect(readme).toContain("../docs/oauth.md")
    })

    test("prepares a serialized migration without activating the repository workflow", () => {
      expect(example).toContain(`  ${action}:\n`)
      expect(example).toContain("    environment: pi-oauth\n")
      expect(example).toContain(
        "    concurrency:\n      group: pi-oauth-auth-json\n      cancel-in-progress: false\n",
      )
      expect(example).not.toMatch(/^concurrency:|cancel-in-progress: true|^\s+env:/m)
      expect(example).not.toMatch(/uses:\s+actions\/checkout@|github\.event\.pull_request\.head/)
      expect(example).toContain(`pi-action/${action}@<PUBLISHED_OAUTH_PERSISTENCE_COMMIT_SHA>`)
      expect(example).toContain(`          auth-json: \${{ secrets.PI_AUTH_JSON }}`)
      expect(example).toContain("          auth-secret: PI_AUTH_JSON")
      expect(example).toContain("          auth-environment: pi-oauth")
      expect(example).toContain(`          auth-token: \${{ secrets.PAT_TOKEN }}`)
      expect(workflow).not.toMatch(/auth-secret:|auth-environment:|auth-token:/)
    })

    test("keeps the API-key usage independent of OAuth persistence", () => {
      const usage = readme.match(/```yaml\n([\s\S]*?)\n```/)?.[1] ?? ""
      expect(usage).toContain(`api-key: \${{ secrets.PI_API_KEY }}`)
      expect(usage).toContain("cancel-in-progress: true")
      expect(usage).not.toMatch(/auth-secret:|auth-environment:|auth-token:/)
    })

    test("keeps publication on the regular workflow token", () => {
      expect(manifest).toContain(`GH_TOKEN: \${{ github.token }}`)
      expect(example).not.toMatch(
        /secrets: write|environments: write|write-all|GH_TOKEN:|GITHUB_TOKEN:/i,
      )
      expect(example).toContain(action === "review" ? "  pull-requests: write" : "  issues: write")
      if (action === "review") {
        expect(example).toContain("  pull_request_target:")
        expect(example).not.toContain("\n  pull_request:")
        expect(example).toContain("  contents: read")
      }
    })
  })
}

test("reuses PAT_TOKEN without requiring another token secret", () => {
  expect(guide).toContain("No additional token secret is required.")
  expect(guide).toContain("Classic PATs need the `repo` scope")
  expect(guide).toContain("require revoking a shared `PAT_TOKEN` that other workflows still use.")
  expect(guide).toContain("rotate it if compromised")
  expect(guide).not.toMatch(/PI_AUTH_WRITER_TOKEN|PI_AUTH_UPDATE_TOKEN/)
})

test("retains explicit activation, live verification, and recovery gates", () => {
  expect(examples).toHaveLength(2)
  expect(guide).toContain("## Owner setup")
  expect(guide).toContain("## External verification handoff")
  expect(guide).toContain("## Recovery and rollback")
  expect(guide).toContain("Environments: read and write")
  expect(guide).toContain("These live checks remain outstanding")
  expect(guide).toContain("refresh_token_reused")
})
