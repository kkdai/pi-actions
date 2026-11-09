import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { isOAuth, isObject, maskSecrets, parseAuthDocument, secretStrings } from "./auth.js";
import { AuthFile } from "./auth-file.js";
import { createAuthSecretWriter } from "./oauth-secret.js";
export { escapeCommand } from "./auth.js";
const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
function withAuthHandoff(path, runnerTemp, auth, task) {
    if (!path)
        return task();
    const file = AuthFile.open(path, runnerTemp, true);
    let valid = false;
    let failure;
    let result;
    const handoff = {
        capture: (updated) => {
            valid = false;
            const json = JSON.stringify(updated);
            parseAuthDocument(json);
            maskSecrets(updated);
            file.write(json);
            valid = true;
        },
        invalidate: () => {
            valid = false;
        },
    };
    try {
        // A task can return before Pi runs. Its original credentials are unchanged.
        handoff.capture(auth);
        result = task(handoff);
    }
    catch (error) {
        failure = error;
    }
    for (const cleanup of [
        () => {
            if (!valid)
                file.remove();
        },
        () => file.close(),
    ]) {
        try {
            cleanup();
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Auth handoff cleanup failed.";
            failure = new Error(`${failure instanceof Error ? `${failure.message}\n` : ""}${message}`);
        }
    }
    if (failure)
        throw failure;
    return result;
}
export function withPi(defaultPrompt, task) {
    const env = process.env;
    const provider = env.PI_PROVIDER?.trim();
    const model = env.PI_MODEL?.trim();
    const thinking = env.PI_THINKING?.trim() || "medium";
    const apiKey = env.PI_API_KEY || "";
    const authJson = env.PI_AUTH_JSON || "";
    const authOutput = env.PI_AUTH_OUTPUT || "";
    const baseUrl = env.PI_BASE_URL?.trim();
    if (!provider || !model)
        throw new Error("provider and model are required.");
    if (!thinkingLevels.includes(thinking))
        throw new Error("Invalid thinking level.");
    if (Boolean(apiKey) === Boolean(authJson)) {
        throw new Error("Provide exactly one of api-key or auth-json.");
    }
    if (baseUrl && !["http:", "https:"].includes(new URL(baseUrl).protocol)) {
        throw new Error("base-url must use HTTP or HTTPS.");
    }
    let auth = {};
    let credential = { type: "api_key", key: apiKey };
    if (authJson) {
        let parsed;
        try {
            parsed = JSON.parse(authJson);
        }
        catch {
            throw new Error("auth-json must contain valid JSON.");
        }
        const selected = isObject(parsed) ? parsed[provider] : undefined;
        if (!isObject(selected) || (selected.type !== "api_key" && selected.type !== "oauth")) {
            throw new Error("auth-json must contain an API key or OAuth credential for provider.");
        }
        auth = parsed;
        credential = selected;
        if (credential.type === "api_key" && (typeof credential.key !== "string" || !credential.key)) {
            throw new Error("The selected auth-json API key must be a non-empty string.");
        }
    }
    maskSecrets(credential);
    maskSecrets(env.PI_AUTH_TOKEN);
    const persistenceRequested = Boolean(env.PI_AUTH_SECRET || env.PI_AUTH_ENVIRONMENT || env.PI_AUTH_TOKEN);
    if (authOutput && persistenceRequested) {
        throw new Error("auth-output cannot be combined with inline auth-secret, auth-environment, or auth-token.");
    }
    if (authOutput) {
        if (!authJson || !isOAuth(credential)) {
            throw new Error("auth-output requires auth-json with a complete selected OAuth credential.");
        }
        auth = parseAuthDocument(authJson);
    }
    if (persistenceRequested && (!authJson || !isOAuth(credential))) {
        throw new Error("OAuth persistence requires auth-json with a complete OAuth credential.");
    }
    const secrets = [
        ...secretStrings(auth),
        apiKey,
        env.PI_AUTH_TOKEN,
        env.PI_AUTH_TOKEN?.trim(),
        env.PAT_TOKEN,
        env.GH_TOKEN,
        env.GITHUB_TOKEN,
        env.GH_ENTERPRISE_TOKEN,
        env.GITHUB_ENTERPRISE_TOKEN,
    ].filter((value) => Boolean(value));
    const redact = (message) => {
        for (const secret of [...new Set(secrets)].sort((a, b) => b.length - a.length)) {
            message = message.replaceAll(secret, "[REDACTED]");
        }
        return message;
    };
    const workspace = env.GITHUB_WORKSPACE;
    const runnerTemp = env.RUNNER_TEMP;
    if (!workspace || !runnerTemp) {
        throw new Error("GITHUB_WORKSPACE and RUNNER_TEMP are required.");
    }
    const prompt = env.PI_PROMPT || defaultPrompt;
    let promptPath = resolve(workspace, prompt);
    if (prompt === defaultPrompt && !existsSync(promptPath)) {
        promptPath = fileURLToPath(new URL(`../${defaultPrompt}`, import.meta.url));
    }
    if (!existsSync(promptPath))
        throw new Error("The prompt file does not exist.");
    return withAuthHandoff(authOutput, runnerTemp, auth, (handoff) => {
        const directory = mkdtempSync(join(runnerTemp, "pi-action-"));
        try {
            writeFileSync(join(directory, "auth.json"), JSON.stringify({ [provider]: credential }), {
                mode: 0o600,
            });
            if (baseUrl) {
                writeFileSync(join(directory, "models.json"), JSON.stringify({ providers: { [provider]: { baseUrl } } }));
            }
            const commandEnv = { ...env };
            delete commandEnv.PI_API_KEY;
            delete commandEnv.PI_AUTH_JSON;
            delete commandEnv.PI_AUTH_TOKEN;
            delete commandEnv.PI_AUTH_SECRET;
            delete commandEnv.PI_AUTH_ENVIRONMENT;
            delete commandEnv.PI_AUTH_OUTPUT;
            delete commandEnv.PAT_TOKEN;
            const options = {
                encoding: "utf8",
                env: commandEnv,
                maxBuffer: 20 * 1024 * 1024,
            };
            const saveAuth = createAuthSecretWriter(env, options);
            const piEnv = {
                ...commandEnv,
                PI_CODING_AGENT_DIR: directory,
                PI_SKIP_VERSION_CHECK: "1",
            };
            delete piEnv.GH_TOKEN;
            delete piEnv.GITHUB_TOKEN;
            delete piEnv.GH_ENTERPRISE_TOKEN;
            delete piEnv.GITHUB_ENTERPRISE_TOKEN;
            const run = (inputPath, instruction) => {
                let output = "";
                let piError;
                handoff?.invalidate();
                try {
                    output = execFileSync("pi", [
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
                    ], { ...options, env: piEnv, cwd: directory, stdio: ["pipe", "pipe", "pipe"] }).trim();
                }
                catch (error) {
                    piError = error;
                }
                let persistenceError;
                try {
                    const updated = JSON.parse(readFileSync(join(directory, "auth.json"), "utf8"));
                    const selected = isObject(updated) ? updated[provider] : undefined;
                    secrets.push(...secretStrings(updated));
                    maskSecrets(selected);
                    if (saveAuth || handoff) {
                        if (!isOAuth(selected))
                            throw new Error("Pi returned invalid OAuth credentials.");
                        const refreshed = { ...credential, ...selected };
                        const nextAuth = { ...auth, [provider]: refreshed };
                        if (handoff)
                            handoff.capture(nextAuth);
                        else if (!isDeepStrictEqual(refreshed, credential))
                            saveAuth?.(nextAuth);
                        auth = nextAuth;
                        credential = refreshed;
                    }
                }
                catch (error) {
                    if (saveAuth || handoff) {
                        persistenceError = new Error(error instanceof Error && error.message.startsWith("Cannot save")
                            ? error.message
                            : handoff
                                ? "Cannot prepare the OAuth auth-output handoff: credentials are missing, invalid, or cannot be written."
                                : "Cannot persist OAuth credentials: Pi's auth.json is missing or invalid.");
                    }
                }
                if (piError) {
                    // A failed refresh can include new tokens in stderr without saving them.
                    // Even a valid auth.json cannot make arbitrary OAuth diagnostics safe.
                    const status = isObject(piError) ? piError.status : undefined;
                    let message = credential.type === "api_key"
                        ? redact(piError instanceof Error ? piError.message : "Pi failed.")
                        : `${Number.isSafeInteger(status) ? `Pi failed with exit code ${status}.` : "Pi failed to start or was interrupted."} OAuth child diagnostics were suppressed to protect credentials.`;
                    if (piError instanceof Error && piError.message.includes("refresh_token_reused")) {
                        message +=
                            " Sign in to Pi again and replace the saved credential; do not retry the old refresh token.";
                    }
                    if (persistenceError instanceof Error)
                        message += `\n${persistenceError.message}`;
                    throw new Error(message);
                }
                if (persistenceError)
                    throw persistenceError;
                return output;
            };
            return task({ directory, options, run });
        }
        finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
}
