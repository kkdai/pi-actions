import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { escapeCommand, withPi } from "./pi.mjs"

function parseLabels(output, available) {
  let result
  try {
    result = JSON.parse(output)
  } catch {
    throw new Error("Pi must return a JSON object with a labels array.")
  }
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    Object.keys(result).length !== 1 ||
    !Array.isArray(result.labels) ||
    result.labels.some((label) => typeof label !== "string")
  ) {
    throw new Error("Pi returned an invalid labels schema.")
  }
  const names = new Set(available.map((label) => label.name))
  if (result.labels.some((label) => !names.has(label))) {
    throw new Error("Pi selected a label that does not exist in the repository.")
  }
  return [...new Set(result.labels)]
}

function triageIssue() {
  const env = process.env
  if (env.GITHUB_EVENT_NAME !== "issues") {
    throw new Error("This action requires an issues event.")
  }
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"))
  if (!["opened", "edited", "reopened"].includes(event.action)) {
    console.log("Skipping unsupported issue activity.")
    return
  }
  const number = event.issue?.number
  if (!Number.isSafeInteger(number) || number < 1 || event.issue?.pull_request) {
    throw new Error("The event must contain a valid issue number, not a pull request.")
  }

  withPi(".pi/prompts/triage-issue.md", ({ directory, options, run }) => {
    const repository = `repos/${env.GITHUB_REPOSITORY}`
    const endpoint = `${repository}/issues/${number}`
    const api = (args) => execFileSync("gh", ["api", ...args], options).trim()
    const fetchIssue = () => {
      const issue = JSON.parse(api([endpoint]))
      if (
        !issue ||
        issue.number !== number ||
        issue.pull_request ||
        typeof issue.title !== "string" ||
        (issue.body !== null && typeof issue.body !== "string") ||
        !["open", "closed"].includes(issue.state) ||
        !Array.isArray(issue.labels) ||
        issue.labels.some((label) => !label || typeof label.name !== "string")
      ) {
        throw new Error("GitHub must return an issue with a title, body, state, and labels.")
      }
      return { ...issue, body: issue.body ?? "" }
    }
    const issue = fetchIssue()
    if (issue.state !== "open") {
      console.log("Skipping a closed issue.")
      return
    }

    const pages = JSON.parse(api([`${repository}/labels`, "--paginate", "--slurp"]))
    if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
      throw new Error("GitHub must return repository label pages.")
    }
    const available = pages.flat()
    if (
      available.some(
        (label) =>
          !label ||
          typeof label.name !== "string" ||
          !label.name.trim() ||
          (label.description != null && typeof label.description !== "string"),
      )
    ) {
      throw new Error("GitHub must return label names and descriptions.")
    }
    if (!available.length) {
      console.log("Skipping a repository without labels.")
      return
    }

    const inputPath = join(directory, "issue.json")
    writeFileSync(
      inputPath,
      JSON.stringify({
        issue: { title: issue.title, body: issue.body },
        labels: available.map((label) => ({
          name: label.name,
          description: label.description ?? "",
        })),
      }),
    )
    const output = run(
      inputPath,
      "Classify the attached issue using the supplied repository labels.",
    )
    if (!output) throw new Error("Pi returned an empty classification.")
    const selected = parseLabels(output, available)
    if (!selected.length) {
      console.log("No labels selected.")
      return
    }

    const latest = fetchIssue()
    if (latest.state !== "open" || latest.title !== issue.title || latest.body !== issue.body) {
      throw new Error("The issue changed during triage. Rerun on the latest issue.")
    }
    const existing = new Set(latest.labels.map((label) => label.name))
    const additions = selected.filter((label) => !existing.has(label))
    if (!additions.length) {
      console.log("No new labels to apply.")
      return
    }
    const requestPath = join(directory, "labels.json")
    writeFileSync(requestPath, JSON.stringify({ labels: additions }))
    api(["--method", "POST", `${endpoint}/labels`, "--input", requestPath])
    console.log(`Applied ${additions.length} issue label(s).`)
  })
}

try {
  triageIssue()
} catch (error) {
  console.error(`::error::${escapeCommand(error instanceof Error ? error.message : String(error))}`)
  process.exitCode = 1
}
