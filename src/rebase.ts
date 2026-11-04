import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { escapeCommand } from "./pi.js"

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isPullRequestNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

function readEvent() {
  const path = process.env.GITHUB_EVENT_PATH
  if (!path) throw new Error("GITHUB_EVENT_PATH is required.")
  const event: unknown = JSON.parse(readFileSync(path, "utf8"))
  if (!isObject(event)) throw new Error("The GitHub event must be an object.")
  return event
}

function selectTargets(): { numbers: number[] } | { branch: string } {
  const env = process.env
  const eventName = env.GITHUB_EVENT_NAME
  if (eventName === "workflow_dispatch") {
    const input = env.PI_PULL_REQUEST?.trim() ?? ""
    if (input) {
      const number = /^[1-9]\d*$/.test(input) ? Number(input) : undefined
      if (!isPullRequestNumber(number)) {
        throw new Error("pull-request must be a positive safe integer.")
      }
      return { numbers: [number] }
    }
    const event = readEvent()
    const branch = isObject(event.repository) ? event.repository.default_branch : undefined
    if (typeof branch !== "string" || !branch.trim()) {
      throw new Error("The event must contain the repository's default branch.")
    }
    return { branch }
  }
  if (eventName === "push") {
    const event = readEvent()
    if (
      event.deleted === true ||
      (typeof event.ref === "string" && event.ref.startsWith("refs/tags/"))
    ) {
      console.log("Skipping a deleted branch or tag push.")
      return { numbers: [] }
    }
    if (
      typeof event.ref !== "string" ||
      !event.ref.startsWith("refs/heads/") ||
      event.ref.length <= 11
    ) {
      throw new Error("The push event must contain a branch ref.")
    }
    return { branch: event.ref.slice(11) }
  }
  if (eventName === "pull_request" || eventName === "pull_request_target") {
    const event = readEvent()
    if (
      typeof event.action !== "string" ||
      !["opened", "reopened", "synchronize", "ready_for_review", "edited"].includes(event.action)
    ) {
      console.log("Skipping unsupported pull request activity.")
      return { numbers: [] }
    }
    const number = isObject(event.pull_request) ? event.pull_request.number : undefined
    if (!isPullRequestNumber(number)) {
      throw new Error("The event must contain a positive safe integer pull request number.")
    }
    return { numbers: [number] }
  }
  throw new Error(
    "This action requires a push, pull_request, pull_request_target, or workflow_dispatch event.",
  )
}

function rebasePullRequests() {
  const targets = selectTargets()
  if ("numbers" in targets && !targets.numbers.length) return
  const repository = process.env.GITHUB_REPOSITORY
  if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("GITHUB_REPOSITORY must contain an owner and repository name.")
  }
  const run = (args: string[]) =>
    execFileSync("gh", args, {
      encoding: "utf8",
      env: { ...process.env, GH_PROMPT_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 20 * 1024 * 1024,
    }).trim()
  let numbers: number[]
  if ("numbers" in targets) {
    numbers = targets.numbers
  } else {
    const output = run([
      "api",
      `repos/${repository}/pulls`,
      "--method",
      "GET",
      "--raw-field",
      "state=open",
      "--raw-field",
      `base=${targets.branch}`,
      "--raw-field",
      "per_page=100",
      "--paginate",
      "--jq",
      ".[].number",
    ])
    const values: unknown[] = output ? output.split(/\r?\n/).map((line) => JSON.parse(line)) : []
    if (!values.every(isPullRequestNumber)) {
      throw new Error("GitHub must return valid pull request numbers.")
    }
    numbers = [...new Set(values)]
  }

  if (!numbers.length) console.log("No open pull requests to rebase.")
  for (const number of numbers) {
    try {
      const request: unknown = JSON.parse(
        run([
          "pr",
          "view",
          String(number),
          "--repo",
          repository,
          "--json",
          "state,isDraft,isCrossRepository,mergeable,baseRefName",
        ]),
      )
      if (
        !isObject(request) ||
        typeof request.state !== "string" ||
        !["OPEN", "CLOSED", "MERGED"].includes(request.state) ||
        typeof request.isDraft !== "boolean" ||
        typeof request.isCrossRepository !== "boolean" ||
        typeof request.mergeable !== "string" ||
        !["MERGEABLE", "CONFLICTING", "UNKNOWN"].includes(request.mergeable) ||
        typeof request.baseRefName !== "string" ||
        !request.baseRefName
      ) {
        throw new Error(
          "GitHub must return the pull request state, branch, draft, fork, and mergeability fields.",
        )
      }
      let reason: string | undefined
      if (request.state !== "OPEN") reason = "not open"
      else if (request.isDraft) reason = "draft"
      else if (request.isCrossRepository) reason = "fork branch"
      else if ("branch" in targets && request.baseRefName !== targets.branch) {
        reason = "base branch changed"
      } else if (request.mergeable === "CONFLICTING") {
        reason = "merge conflicts require manual resolution"
      }
      if (reason) {
        console.log(`Skipping pull request #${number}: ${reason}.`)
        continue
      }
      // GitHub CLI checks whether the branch is behind and guards the write with expectedHeadOid.
      const result = run(["pr", "update-branch", String(number), "--repo", repository, "--rebase"])
      console.log(`Pull request #${number}: ${result}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`::error::${escapeCommand(`Pull request #${number}: ${message}`)}`)
      process.exitCode = 1
    }
  }
}

try {
  rebasePullRequests()
} catch (error) {
  console.error(`::error::${escapeCommand(error instanceof Error ? error.message : String(error))}`)
  process.exitCode = 1
}
