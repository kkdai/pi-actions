import { isDeepStrictEqual } from "node:util";
import { escapeCommand, maskSecrets, parseAuthDocument } from "./auth.js";
import { AuthFile } from "./auth-file.js";
import { createAuthSecretWriter } from "./oauth-secret.js";
function persistAuth() {
    const env = process.env;
    maskSecrets(env.PI_AUTH_TOKEN);
    let file;
    let failure;
    let message = "";
    try {
        file = AuthFile.open(env.PI_AUTH_FILE || "", env.RUNNER_TEMP || "");
        const auth = parseAuthDocument(file.read());
        maskSecrets(auth);
        const original = env.PI_AUTH_JSON ? parseAuthDocument(env.PI_AUTH_JSON) : undefined;
        if (original)
            maskSecrets(original);
        if (!env.PI_AUTH_TOKEN?.trim())
            throw new Error("A GitHub token is required to persist auth.");
        const target = {
            ...env,
            PI_AUTH_ENVIRONMENT: env.PI_AUTH_ENVIRONMENT ?? "pi-oauth",
            PI_AUTH_SECRET: env.PI_AUTH_SECRET ?? "PI_AUTH_JSON",
        };
        const commandEnv = { ...env };
        for (const name of [
            "PI_AUTH_FILE",
            "PI_AUTH_JSON",
            "PI_AUTH_TOKEN",
            "PI_AUTH_SECRET",
            "PI_AUTH_ENVIRONMENT",
            "PI_AUTH_OUTPUT",
            "PI_API_KEY",
            "PAT_TOKEN",
        ]) {
            delete commandEnv[name];
        }
        const options = {
            encoding: "utf8",
            env: commandEnv,
            maxBuffer: 1024 * 1024,
        };
        const save = createAuthSecretWriter(target, options);
        if (!save)
            throw new Error("The environment secret destination is required.");
        // A preflight subprocess must not replace the file that this action consumes.
        file.assertCurrent();
        if (original && isDeepStrictEqual(auth, original)) {
            message = "OAuth credentials are unchanged; no secret update was needed.";
        }
        else {
            save(auth);
            message = "OAuth credentials saved to the environment secret.";
        }
    }
    catch (error) {
        failure = error;
    }
    if (file) {
        for (const cleanup of [() => file.remove(), () => file.close()]) {
            try {
                cleanup();
            }
            catch (error) {
                const detail = error instanceof Error ? error.message : "Auth file cleanup failed.";
                failure = new Error(`${failure instanceof Error ? `${failure.message}\n` : ""}${detail}`);
            }
        }
    }
    if (failure)
        throw failure;
    console.log(message);
}
try {
    persistAuth();
}
catch (error) {
    console.error(`::error::${escapeCommand(error instanceof Error ? error.message : "Auth persistence failed.")}`);
    process.exitCode = 1;
}
