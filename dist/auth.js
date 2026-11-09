export const maxAuthBytes = 48 * 1024;
export function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function escapeCommand(value) {
    return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}
export function secretStrings(value) {
    if (typeof value === "string")
        return value ? [value] : [];
    if (!value || typeof value !== "object")
        return [];
    return Object.entries(value).flatMap(([key, entry]) => key === "type" ? [] : secretStrings(entry));
}
export function maskSecrets(value) {
    for (const secret of secretStrings(value)) {
        console.log(`::add-mask::${escapeCommand(secret)}`);
    }
}
export function isOAuth(value) {
    return (isObject(value) &&
        value.type === "oauth" &&
        typeof value.access === "string" &&
        value.access.trim().length > 0 &&
        typeof value.refresh === "string" &&
        value.refresh.trim().length > 0 &&
        typeof value.expires === "number" &&
        Number.isFinite(value.expires));
}
export function parseAuthDocument(json) {
    if (Buffer.byteLength(json, "utf8") > maxAuthBytes) {
        throw new Error("The auth document exceeds the 48 KB secret limit.");
    }
    let auth;
    try {
        auth = JSON.parse(json);
    }
    catch {
        throw new Error("The auth document must contain valid JSON.");
    }
    if (!isObject(auth) || !Object.keys(auth).length) {
        throw new Error("The auth document must contain a non-empty provider map.");
    }
    let hasOAuth = false;
    for (const credential of Object.values(auth)) {
        if (isOAuth(credential)) {
            hasOAuth = true;
            continue;
        }
        if (!isObject(credential) ||
            credential.type !== "api_key" ||
            (credential.key !== undefined && typeof credential.key !== "string") ||
            (credential.env !== undefined &&
                (!isObject(credential.env) ||
                    !Object.values(credential.env).every((value) => typeof value === "string")))) {
            throw new Error("The auth document contains an invalid provider credential.");
        }
    }
    if (!hasOAuth)
        throw new Error("The auth document must contain a complete OAuth credential.");
    return auth;
}
