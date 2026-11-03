import { createHash } from "node:crypto";
export const summaryMarker = "<!-- pi-action:summary -->";
export const findingMarker = "<!-- pi-action:finding -->";
const severities = ["critical", "high", "medium", "low"];
const sides = ["LEFT", "RIGHT"];
const bodyLimit = 65536;
function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hasShape(value, required, optional = []) {
    return (isObject(value) &&
        required.every((key) => Object.hasOwn(value, key)) &&
        Object.keys(value).every((key) => required.includes(key) || optional.includes(key)));
}
function isText(value) {
    return typeof value === "string" && value.trim().length > 0;
}
function isLine(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function validateOutput(raw, threadIds) {
    let output;
    try {
        if (typeof raw !== "string")
            throw new Error();
        output = JSON.parse(raw);
    }
    catch {
        throw new Error("Review output must be one JSON object without fences or prose.");
    }
    if (!hasShape(output, ["summary", "findings"], ["resolved_threads"]) ||
        !isText(output.summary) ||
        !Array.isArray(output.findings)) {
        throw new Error("Invalid review schema: expected summary and findings.");
    }
    const findings = output.findings;
    for (const finding of findings) {
        if (!hasShape(finding, ["severity", "title", "body", "location"]) ||
            !severities.some((severity) => severity === finding.severity) ||
            !isText(finding.title) ||
            !isText(finding.body)) {
            throw new Error("Invalid review schema: invalid finding.");
        }
        const location = finding.location;
        if (location !== null &&
            (!hasShape(location, ["path", "line", "side"], ["start_line"]) ||
                !isText(location.path) ||
                !isLine(location.line) ||
                !sides.some((side) => side === location.side) ||
                (Object.hasOwn(location, "start_line") && !isLine(location.start_line)))) {
            throw new Error("Invalid review schema: invalid location.");
        }
    }
    if (Object.hasOwn(output, "resolved_threads")) {
        if (!Array.isArray(output.resolved_threads)) {
            throw new Error("Invalid review schema: expected an array of resolved threads.");
        }
        const allowed = new Set(threadIds);
        const resolved = new Set();
        for (const resolution of output.resolved_threads) {
            if (!hasShape(resolution, ["id", "reason"]) ||
                !isText(resolution.id) ||
                !isText(resolution.reason) ||
                resolution.reason.length > 300 ||
                !allowed.has(resolution.id) ||
                resolved.has(resolution.id)) {
                throw new Error("Invalid review schema: invalid or unknown thread resolution.");
            }
            resolved.add(resolution.id);
        }
    }
    // The schema and every finding, location, and resolution have been validated above.
    return output;
}
// Git quotes paths with C escapes and octal UTF-8 bytes, not JSON escapes.
function decodePath(value, prefix) {
    // Git adds a tab delimiter after unquoted header paths that contain spaces.
    if (value.endsWith("\t"))
        value = value.slice(0, -1);
    if (value.includes("\t"))
        return undefined;
    if (value === "/dev/null")
        return null;
    if (value.startsWith('"')) {
        if (!value.endsWith('"'))
            return undefined;
        const bytes = [];
        const escapes = {
            a: 7,
            b: 8,
            t: 9,
            n: 10,
            v: 11,
            f: 12,
            r: 13,
            '"': 34,
            "\\": 92,
        };
        const encoder = new TextEncoder();
        const text = value.slice(1, -1);
        for (let index = 0; index < text.length; index++) {
            const character = text[index];
            if (character === '"')
                return undefined;
            if (character !== "\\") {
                const point = text.codePointAt(index);
                if (point === undefined)
                    return undefined;
                bytes.push(...encoder.encode(String.fromCodePoint(point)));
                if (point > 0xffff)
                    index++;
                continue;
            }
            const escaped = text[++index];
            if (Object.hasOwn(escapes, escaped)) {
                bytes.push(escapes[escaped]);
            }
            else {
                const octal = text.slice(index).match(/^[0-7]{1,3}/)?.[0];
                if (!octal || Number.parseInt(octal, 8) > 255)
                    return undefined;
                bytes.push(Number.parseInt(octal, 8));
                index += octal.length - 1;
            }
        }
        try {
            value = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
        }
        catch {
            return undefined;
        }
    }
    if (!value.startsWith(prefix) || value.length === prefix.length || value.includes("\0")) {
        return undefined;
    }
    return value.slice(prefix.length);
}
function mapDiff(diff) {
    const files = [];
    let file;
    let hunk;
    for (const line of diff.split("\n")) {
        if (line.startsWith("diff --git ")) {
            file = undefined;
            hunk = undefined;
            continue;
        }
        if (hunk && file) {
            if (line.startsWith("\\ No newline at end of file"))
                continue;
            const kind = line[0];
            const oldLine = kind === " " || kind === "-";
            const newLine = kind === " " || kind === "+";
            if ((!oldLine && !newLine) ||
                (oldLine && hunk.oldRemaining === 0) ||
                (newLine && hunk.newRemaining === 0)) {
                hunk = undefined;
                continue;
            }
            if (kind === "-")
                hunk.LEFT.add(hunk.oldLine);
            if (newLine)
                hunk.RIGHT.add(hunk.newLine);
            if (oldLine) {
                hunk.oldLine++;
                hunk.oldRemaining--;
            }
            if (newLine) {
                hunk.newLine++;
                hunk.newRemaining--;
            }
            if (hunk.oldRemaining === 0 && hunk.newRemaining === 0) {
                file.hunks.push(hunk);
                hunk = undefined;
            }
            continue;
        }
        if (line.startsWith("--- ")) {
            file = { oldPath: decodePath(line.slice(4), "a/"), newPath: undefined, hunks: [] };
            files.push(file);
        }
        else if (file && line.startsWith("+++ ")) {
            file.newPath = decodePath(line.slice(4), "b/");
        }
        else if (file) {
            const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: |$)/);
            if (!match)
                continue;
            const [, oldStart, oldCount = "1", newStart, newCount = "1"] = match;
            const values = [oldStart, oldCount, newStart, newCount].map(Number);
            if (!values.every(Number.isSafeInteger))
                continue;
            const [oldLine, oldRemaining, newLine, newRemaining] = values;
            if (!Number.isSafeInteger(oldLine + oldRemaining) ||
                !Number.isSafeInteger(newLine + newRemaining) ||
                (oldRemaining > 0 && oldLine === 0) ||
                (newRemaining > 0 && newLine === 0) ||
                oldRemaining + newRemaining === 0) {
                continue;
            }
            hunk = { oldLine, oldRemaining, newLine, newRemaining, LEFT: new Set(), RIGHT: new Set() };
        }
    }
    return files;
}
function findAnchor(location, files) {
    if (location === null)
        return null;
    const { path, line, side, start_line: start = line } = location;
    if (start > line)
        return null;
    const canonical = files.filter((file) => file.newPath === path || (file.newPath === null && file.oldPath === path));
    const matches = canonical.length ? canonical : files.filter((file) => file.oldPath === path);
    if (matches.length !== 1)
        return null;
    const file = matches[0];
    // Both headers must decode. A rename uses the new path, including LEFT anchors.
    if (file.oldPath === undefined || file.newPath === undefined)
        return null;
    const canonicalPath = file.newPath ?? file.oldPath;
    if (!canonicalPath)
        return null;
    const valid = file.hunks.some((hunk) => {
        const lines = hunk[side];
        if (line - start + 1 > lines.size)
            return false;
        for (let current = start; current <= line; current++) {
            if (!lines.has(current))
                return false;
        }
        return true;
    });
    if (!valid)
        return null;
    return {
        path: canonicalPath,
        line,
        side,
        ...(start < line ? { start_line: start, start_side: side } : {}),
    };
}
function severityText(severity) {
    return `${severity[0].toUpperCase()}${severity.slice(1)}`;
}
function label(finding) {
    return `${severityText(finding.severity)}: ${finding.title}`;
}
function locationText(location) {
    if (location === null)
        return "General finding";
    const start = location.start_line;
    const range = start !== undefined && start !== location.line ? `${start}-` : "";
    const text = `${location.path}:${range}${location.line}`;
    const ticks = text.match(/`+/g) ?? [];
    const delimiter = "`".repeat(Math.max(0, ...ticks.map((tick) => tick.length)) + 1);
    const code = delimiter.length > 1 ? `${delimiter} ${text} ${delimiter}` : `\`${text}\``;
    return `${code}${location.side === "LEFT" ? " (removed)" : ""}`;
}
function locationLink(location, pullRequestUrl, head) {
    const hash = createHash("sha256").update(location.path).digest("hex");
    const side = location.side === "LEFT" ? "L" : "R";
    const range = location.start_line ? `${side}${location.start_line}-` : "";
    const url = `${pullRequestUrl}/files/${head}#diff-${hash}${range}${side}${location.line}`;
    const path = location.path.slice(location.path.lastIndexOf("/") + 1);
    const title = location.path
        .replace(/[\\"]/g, "\\$&")
        .replace(/[&\r\n]/g, (character) => `&#${character.charCodeAt(0)};`);
    return `[${locationText({ ...location, path })}](${url} "${title}")`;
}
function tableCell(text) {
    return text.replace(/[\r\n]+/g, " ").replace(/\|/g, "\\|");
}
function checkBody(body) {
    if (body.length > bodyLimit) {
        throw new Error("Review body exceeds GitHub's 65536-character limit.");
    }
    return body;
}
export function buildReview(raw, diff, head, pullRequestUrl, threadIds = []) {
    const output = validateOutput(raw, threadIds);
    if (typeof diff !== "string" || !isText(head)) {
        throw new Error("The diff must be a string and the reviewed head must be non-empty text.");
    }
    const files = mapDiff(diff);
    const comments = [];
    const anchored = [];
    const general = [];
    for (const finding of output.findings) {
        const anchor = findAnchor(finding.location, files);
        if (anchor) {
            comments.push({
                ...anchor,
                body: checkBody(`${findingMarker}\n**${label(finding)}**\n\n${finding.body}`),
            });
            anchored.push(`| ${severityText(finding.severity)} | **${tableCell(finding.title)}** | ${tableCell(locationLink(anchor, pullRequestUrl, head))} |`);
        }
        else {
            general.push(`#### ${label(finding)}\n\n${locationText(finding.location)}\n\n${finding.body}`);
        }
    }
    const sections = [`${summaryMarker}\n## Pi review`, output.summary];
    if (anchored.length) {
        sections.push(`### Inline findings (${anchored.length})\n\n| Severity | Finding | Location |\n| --- | --- | --- |\n${anchored.join("\n")}`);
    }
    if (general.length) {
        sections.push(`### Summary-only findings (${general.length})\n\n${general.join("\n\n")}`);
    }
    sections.push("---", `<sub>Reviewed commit: [\`${head.slice(0, 7)}\`](${pullRequestUrl}/commits/${head}) · This review covers only the supplied diff.</sub>`);
    return {
        body: checkBody(sections.join("\n\n")),
        comments,
        resolvedThreads: output.resolved_threads ?? [],
    };
}
