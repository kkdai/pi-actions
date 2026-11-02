import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { escapeCommand, withPi } from "./pi.mjs"
import { buildReview, summaryMarker } from "./review-output.mjs"

function reviewPullRequest() {
  const env = process.env
  if (env.GITHUB_EVENT_NAME !== "pull_request") {
    throw new Error("This action requires a pull_request event.")
  }

  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"))
  const number = event.number
  const base = event.pull_request?.base?.sha
  const head = event.pull_request?.head?.sha
  if (
    !Number.isSafeInteger(number) ||
    number < 1 ||
    !/^[a-f0-9]{40,64}$/.test(base || "") ||
    !/^[a-f0-9]{40,64}$/.test(head || "")
  ) {
    throw new Error("The pull request event must contain a number and base/head commit IDs.")
  }

  withPi(".pi/prompts/review-pull-request.md", ({ directory, options, run }) => {
    const repository = `repos/${env.GITHUB_REPOSITORY}`
    const diff = execFileSync(
      "gh",
      [
        "api",
        `${repository}/compare/${base}...${head}`,
        "--header",
        "Accept: application/vnd.github.diff",
      ],
      options,
    )
    if (!diff.trim()) throw new Error("The pull request diff is empty.")
    const diffPath = join(directory, "diff.patch")
    writeFileSync(diffPath, diff)

    const review = run(diffPath, "Review the attached pull request diff.")
    if (!review) throw new Error("Pi returned an empty review.")
    const report = buildReview(review, diff, head)
    const api = (args) => execFileSync("gh", ["api", ...args], options).trim()
    const list = (endpoint) => JSON.parse(api([endpoint, "--paginate", "--slurp"])).flat()
    const request = (method, endpoint, payload) => {
      const requestPath = join(directory, "request.json")
      writeFileSync(requestPath, JSON.stringify(payload))
      return JSON.parse(api(["--method", method, endpoint, "--input", requestPath]))
    }
    const isPiBot = (comment) => comment.user?.login === "github-actions[bot]"
    const commentKey = (comment) =>
      JSON.stringify([
        comment.path,
        comment.original_line ?? comment.line,
        comment.side,
        comment.original_start_line ?? comment.start_line ?? null,
        comment.start_side ?? null,
        comment.body,
      ])

    const summaries = list(`${repository}/issues/${number}/comments`)
    const previous = summaries.find(
      (comment) => isPiBot(comment) && comment.body?.startsWith(summaryMarker),
    )
    const published = new Set(
      (report.comments.length ? list(`${repository}/pulls/${number}/comments`) : [])
        .filter((comment) => isPiBot(comment) && comment.original_commit_id === head)
        .map(commentKey),
    )
    const comments = report.comments.filter((comment) => {
      const key = commentKey(comment)
      if (published.has(key)) return false
      published.add(key)
      return true
    })

    if (api([`${repository}/pulls/${number}`, "--jq", ".head.sha"]) !== head) {
      throw new Error("The pull request head changed during review. Rerun on the latest commit.")
    }
    const summary = request(
      previous ? "PATCH" : "POST",
      previous
        ? `${repository}/issues/comments/${previous.id}`
        : `${repository}/issues/${number}/comments`,
      { body: report.body },
    )
    console.log(`Summary ${previous ? "updated" : "posted"}: ${summary.html_url}`)

    if (comments.length) {
      const posted = request("POST", `${repository}/pulls/${number}/reviews`, {
        body: `Inline findings for \`${head}\`. See the [Pi review summary](${summary.html_url}).`,
        event: "COMMENT",
        commit_id: head,
        comments,
      })
      console.log(`Review posted: ${posted.html_url}`)
    }
  })
}

try {
  reviewPullRequest()
} catch (error) {
  console.error(`::error::${escapeCommand(error instanceof Error ? error.message : String(error))}`)
  process.exitCode = 1
}
