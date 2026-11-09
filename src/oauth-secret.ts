import { type ExecFileSyncOptionsWithStringEncoding, execFileSync } from "node:child_process"

export function createAuthSecretWriter(
  env: NodeJS.ProcessEnv,
  options: ExecFileSyncOptionsWithStringEncoding,
): ((auth: Record<string, unknown>) => void) | undefined {
  const secret = env.PI_AUTH_SECRET?.trim() || ""
  const environment = env.PI_AUTH_ENVIRONMENT?.trim() || ""
  const token = env.PI_AUTH_TOKEN?.trim() || ""
  if (!secret && !environment && !token) return
  if (!secret || !environment || !token) {
    throw new Error("Provide auth-secret, auth-environment, and auth-token together.")
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(secret) || secret.toUpperCase().startsWith("GITHUB_")) {
    throw new Error("auth-secret must be a valid GitHub Actions secret name.")
  }
  if (
    environment.length > 255 ||
    [...environment].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  ) {
    throw new Error("auth-environment must be a valid GitHub environment name.")
  }
  const repository = env.GITHUB_REPOSITORY || ""
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+$/.test(repository) ||
    [".", ".."].includes(repository.split("/")[1])
  ) {
    throw new Error("GITHUB_REPOSITORY must identify the caller's owner/repo.")
  }
  let host: string
  try {
    const server = new URL(env.GITHUB_SERVER_URL || "https://github.com")
    if (server.protocol !== "https:" || server.username || server.password) throw new Error()
    host = server.host
  } catch {
    throw new Error("GITHUB_SERVER_URL must be an HTTPS GitHub server URL.")
  }
  const writerEnv: NodeJS.ProcessEnv = { ...options.env, GH_HOST: host, GH_TOKEN: token }
  delete writerEnv.GITHUB_TOKEN
  delete writerEnv.GH_ENTERPRISE_TOKEN
  delete writerEnv.GITHUB_ENTERPRISE_TOKEN
  if (host !== "github.com" && !host.endsWith(".ghe.com")) {
    writerEnv.GH_ENTERPRISE_TOKEN = token
  }
  const writerOptions: ExecFileSyncOptionsWithStringEncoding = {
    ...options,
    env: writerEnv,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 30_000,
  }
  try {
    const metadata: unknown = JSON.parse(
      execFileSync(
        "gh",
        [
          "api",
          `repos/${repository}/environments/${encodeURIComponent(environment)}/secrets/${secret}`,
        ],
        writerOptions,
      ),
    )
    if (
      !metadata ||
      typeof metadata !== "object" ||
      !("name" in metadata) ||
      typeof metadata.name !== "string" ||
      metadata.name.toUpperCase() !== secret.toUpperCase()
    ) {
      throw new Error()
    }
  } catch {
    throw new Error(
      "Cannot access the existing environment secret. Check auth-environment, auth-secret, and auth-token's Environments permissions.",
    )
  }
  return (auth) => {
    const input = JSON.stringify(auth)
    if (Buffer.byteLength(input, "utf8") > 48 * 1024) {
      throw new Error("Cannot save OAuth credentials: the environment secret exceeds 48 KB.")
    }
    try {
      execFileSync("gh", ["secret", "set", secret, "--env", environment, "--repo", repository], {
        ...writerOptions,
        input,
      })
    } catch {
      throw new Error(
        "Cannot save refreshed OAuth credentials to the environment secret. Stop credential consumers, check auth-token's Environments write permission, and sign in again if the saved refresh token is no longer valid.",
      )
    }
  }
}
