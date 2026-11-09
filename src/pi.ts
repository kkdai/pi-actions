import { type ExecFileSyncOptionsWithStringEncoding, execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { isDeepStrictEqual } from "node:util"
import { createAuthSecretWriter } from "./oauth-secret.js"

const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]

type PiContext = {
  directory: string
  options: ExecFileSyncOptionsWithStringEncoding
  run: (inputPath: string, instruction: string) => string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function escapeCommand(value: string) {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")
}

function secretStrings(value: unknown): string[] {
  if (typeof value === "string") return value ? [value] : []
  if (!value || typeof value !== "object") return []
  return Object.entries(value).flatMap(([key, entry]) =>
    key === "type" ? [] : secretStrings(entry),
  )
}

function maskSecrets(value: unknown): void {
  for (const secret of secretStrings(value)) {
    console.log(`::add-mask::${escapeCommand(secret)}`)
  }
}

function isOAuth(value: unknown): value is Record<string, unknown> {
  return (
    isObject(value) &&
    value.type === "oauth" &&
    typeof value.access === "string" &&
    value.access.trim().length > 0 &&
    typeof value.refresh === "string" &&
    value.refresh.trim().length > 0 &&
    typeof value.expires === "number" &&
    Number.isFinite(value.expires)
  )
}

export function withPi<Result>(
  defaultPrompt: string,
  task: (context: PiContext) => Result,
): Result {
  const env = process.env
  const provider = env.PI_PROVIDER?.trim()
  const model = env.PI_MODEL?.trim()
  const thinking = env.PI_THINKING?.trim() || "medium"
  const apiKey = env.PI_API_KEY || ""
  const authJson = env.PI_AUTH_JSON || ""
  const baseUrl = env.PI_BASE_URL?.trim()
  if (!provider || !model) throw new Error("provider and model are required.")
  if (!thinkingLevels.includes(thinking)) throw new Error("Invalid thinking level.")
  if (Boolean(apiKey) === Boolean(authJson)) {
    throw new Error("Provide exactly one of api-key or auth-json.")
  }
  if (baseUrl && !["http:", "https:"].includes(new URL(baseUrl).protocol)) {
    throw new Error("base-url must use HTTP or HTTPS.")
  }

  let auth: Record<string, unknown> = {}
  let credential: Record<string, unknown> = { type: "api_key", key: apiKey }
  if (authJson) {
    let parsed: unknown
    try {
      parsed = JSON.parse(authJson)
    } catch {
      throw new Error("auth-json must contain valid JSON.")
    }
    const selected = isObject(parsed) ? parsed[provider] : undefined
    if (!isObject(selected) || (selected.type !== "api_key" && selected.type !== "oauth")) {
      throw new Error("auth-json must contain an API key or OAuth credential for provider.")
    }
    auth = parsed as Record<string, unknown>
    credential = selected
    if (credential.type === "api_key" && (typeof credential.key !== "string" || !credential.key)) {
      throw new Error("The selected auth-json API key must be a non-empty string.")
    }
  }
  maskSecrets(credential)
  maskSecrets(env.PI_AUTH_TOKEN)
  const persistenceRequested = Boolean(
    env.PI_AUTH_SECRET || env.PI_AUTH_ENVIRONMENT || env.PI_AUTH_TOKEN,
  )
  if (persistenceRequested && (!authJson || !isOAuth(credential))) {
    throw new Error("OAuth persistence requires auth-json with a complete OAuth credential.")
  }
  const secrets = [
    ...secretStrings(auth),
    apiKey,
    env.PI_AUTH_TOKEN,
    env.PI_AUTH_TOKEN?.trim(),
    env.GH_TOKEN,
    env.GITHUB_TOKEN,
    env.GH_ENTERPRISE_TOKEN,
    env.GITHUB_ENTERPRISE_TOKEN,
  ].filter((value): value is string => Boolean(value))
  const redact = (message: string) => {
    for (const secret of [...new Set(secrets)].sort((a, b) => b.length - a.length)) {
      message = message.replaceAll(secret, "[REDACTED]")
    }
    return message
  }

  const workspace = env.GITHUB_WORKSPACE
  const runnerTemp = env.RUNNER_TEMP
  if (!workspace || !runnerTemp) {
    throw new Error("GITHUB_WORKSPACE and RUNNER_TEMP are required.")
  }
  const prompt = env.PI_PROMPT || defaultPrompt
  let promptPath = resolve(workspace, prompt)
  if (prompt === defaultPrompt && !existsSync(promptPath)) {
    promptPath = fileURLToPath(new URL(`../${defaultPrompt}`, import.meta.url))
  }
  if (!existsSync(promptPath)) throw new Error("The prompt file does not exist.")

  const directory = mkdtempSync(join(runnerTemp, "pi-action-"))
  try {
    writeFileSync(join(directory, "auth.json"), JSON.stringify({ [provider]: credential }), {
      mode: 0o600,
    })
    if (baseUrl) {
      writeFileSync(
        join(directory, "models.json"),
        JSON.stringify({ providers: { [provider]: { baseUrl } } }),
      )
    }

    const commandEnv = { ...env }
    delete commandEnv.PI_API_KEY
    delete commandEnv.PI_AUTH_JSON
    delete commandEnv.PI_AUTH_TOKEN
    delete commandEnv.PI_AUTH_SECRET
    delete commandEnv.PI_AUTH_ENVIRONMENT
    const options: ExecFileSyncOptionsWithStringEncoding = {
      encoding: "utf8",
      env: commandEnv,
      maxBuffer: 20 * 1024 * 1024,
    }
    const saveAuth = createAuthSecretWriter(env, options)
    const piEnv: NodeJS.ProcessEnv = {
      ...commandEnv,
      PI_CODING_AGENT_DIR: directory,
      PI_SKIP_VERSION_CHECK: "1",
    }
    delete piEnv.GH_TOKEN
    delete piEnv.GITHUB_TOKEN
    delete piEnv.GH_ENTERPRISE_TOKEN
    delete piEnv.GITHUB_ENTERPRISE_TOKEN
    const run = (inputPath: string, instruction: string) => {
      let output = ""
      let piError: unknown
      try {
        output = execFileSync(
          "pi",
          [
            "--print",
            "--mode",
            "text",
            "--no-session",
            "--no-tools",
            "--no-extensions",
            "--no-skills",
            "--no-prompt-templates",
            "--no-themes",
            "--no-context-files",
            "--no-approve",
            "--provider",
            provider,
            "--model",
            model,
            "--thinking",
            thinking,
            "--system-prompt",
            promptPath,
            `@${inputPath}`,
            instruction,
          ],
          { ...options, env: piEnv, cwd: directory, stdio: ["pipe", "pipe", "pipe"] },
        ).trim()
      } catch (error) {
        piError = error
      }

      let persistenceError: unknown
      try {
        const updated: unknown = JSON.parse(readFileSync(join(directory, "auth.json"), "utf8"))
        const selected = isObject(updated) ? updated[provider] : undefined
        secrets.push(...secretStrings(updated))
        maskSecrets(selected)
        if (saveAuth) {
          if (!isOAuth(selected)) throw new Error("Pi returned invalid OAuth credentials.")
          const refreshed = { ...credential, ...selected }
          if (!isDeepStrictEqual(refreshed, credential)) {
            const nextAuth = { ...auth, [provider]: refreshed }
            saveAuth(nextAuth)
            auth = nextAuth
            credential = refreshed
          }
        }
      } catch (error) {
        if (saveAuth) {
          persistenceError = new Error(
            error instanceof Error && error.message.startsWith("Cannot save")
              ? error.message
              : "Cannot persist OAuth credentials: Pi's auth.json is missing or invalid.",
          )
        }
      }
      if (piError) {
        // A failed refresh can include new tokens in stderr without saving them.
        // Even a valid auth.json cannot make arbitrary OAuth diagnostics safe.
        const status = isObject(piError) ? piError.status : undefined
        let message =
          credential.type === "api_key"
            ? redact(piError instanceof Error ? piError.message : "Pi failed.")
            : `${Number.isSafeInteger(status) ? `Pi failed with exit code ${status}.` : "Pi failed to start or was interrupted."} OAuth child diagnostics were suppressed to protect credentials.`
        if (piError instanceof Error && piError.message.includes("refresh_token_reused")) {
          message +=
            " Sign in to Pi again and replace the saved credential; do not retry the old refresh token."
        }
        if (persistenceError instanceof Error) message += `\n${persistenceError.message}`
        throw new Error(message)
      }
      if (persistenceError) throw persistenceError
      return output
    }

    return task({ directory, options, run })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
