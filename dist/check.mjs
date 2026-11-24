import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
export const CHECKER_ENDPOINT = "https://mcp.getlinkbunny.com/mcp";
export const ACTION_VERSION = "1.0.0";
export const MCP_PROTOCOL_VERSION = "2025-11-25";
export const REQUEST_TIMEOUT_MS = 30_000;
export const MAX_RESPONSE_BYTES = 1_000_000;
export const MAX_URL_LENGTH = 2_048;
export const MAX_ANCHOR_INPUT_LENGTH = 500;
const MAX_REPORTED_MATCHES = 10;
const MAX_DISPLAY_LENGTH = 300;
export class InputError extends Error {
}
const YAML_TRUE = new Set(["true", "True", "TRUE"]);
const YAML_FALSE = new Set(["false", "False", "FALSE"]);
function readInput(env, name) {
    return (env[`INPUT_${name.toUpperCase()}`] ?? "").trim();
}
function parseBoolean({ value, name, }) {
    if (YAML_TRUE.has(value)) {
        return true;
    }
    if (YAML_FALSE.has(value)) {
        return false;
    }
    throw new InputError(`Input ${name} must be true or false.`);
}
export function validatePublicHTTPSURL({ value, name, }) {
    if (!value) {
        throw new InputError(`Input ${name} is required.`);
    }
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new InputError(`Input ${name} must be an absolute public HTTPS URL.`);
    }
    const hostname = url.hostname.toLowerCase();
    const isIPLiteral = hostname.startsWith("[") || /^[\d.]+$/.test(hostname);
    if (url.protocol !== "https:" ||
        url.username ||
        url.password ||
        isIPLiteral ||
        !hostname.includes(".") ||
        hostname.endsWith(".localhost") ||
        hostname.endsWith(".local") ||
        hostname.endsWith(".internal")) {
        throw new InputError(`Input ${name} must be a public HTTPS URL with a domain name and no credentials.`);
    }
    const normalized = url.toString();
    if (normalized.length > MAX_URL_LENGTH) {
        throw new InputError(`Input ${name} must be at most ${MAX_URL_LENGTH} characters.`);
    }
    return normalized;
}
export function readInputs(env) {
    const expectedAnchorText = normalizeText(readInput(env, "expected-anchor-text"));
    if (expectedAnchorText.length > MAX_ANCHOR_INPUT_LENGTH) {
        throw new InputError(`Input expected-anchor-text must be at most ${MAX_ANCHOR_INPUT_LENGTH} characters.`);
    }
    return {
        pageURL: validatePublicHTTPSURL({
            value: readInput(env, "page-url"),
            name: "page-url",
        }),
        expectedURL: validatePublicHTTPSURL({
            value: readInput(env, "expected-url"),
            name: "expected-url",
        }),
        expectedAnchorText: expectedAnchorText || null,
        requireNofollow: parseBoolean({
            value: readInput(env, "require-nofollow") || "true",
            name: "require-nofollow",
        }),
        failOnError: parseBoolean({
            value: readInput(env, "fail-on-error") || "true",
            name: "fail-on-error",
        }),
    };
}
export function normalizeText(value) {
    return value.replace(/\s+/g, " ").trim();
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseFetch(value) {
    if (!isRecord(value) ||
        (value.outcome !== "fetched" && value.outcome !== "not_fetched") ||
        !(value.finalURL === null || typeof value.finalURL === "string") ||
        !(value.httpStatus === null || Number.isInteger(value.httpStatus))) {
        return null;
    }
    return {
        outcome: value.outcome,
        finalURL: value.finalURL,
        httpStatus: value.httpStatus,
    };
}
function parseMatch(value) {
    if (!isRecord(value) ||
        typeof value.href !== "string" ||
        typeof value.resolvedURL !== "string" ||
        typeof value.anchorText !== "string" ||
        !Array.isArray(value.relTokens) ||
        !value.relTokens.every((token) => typeof token === "string") ||
        typeof value.nofollow !== "boolean") {
        return null;
    }
    return {
        href: value.href,
        resolvedURL: value.resolvedURL,
        anchorText: value.anchorText,
        relTokens: value.relTokens,
        nofollow: value.nofollow,
    };
}
// The hosted checker reports early-stopped inspection only as this issue text.
// scripts/contract-smoke.ts checks it against the real server.
const PARTIAL_INSPECTION_ISSUE_PREFIX = "Only part of the source page";
export function parsePlacementData(value) {
    if (!isRecord(value) ||
        (value.outcome !== "found" &&
            value.outcome !== "not_found" &&
            value.outcome !== "indeterminate") ||
        !Array.isArray(value.matches)) {
        return null;
    }
    const source = parseFetch(value.source);
    const destination = parseFetch(value.destination);
    const matches = value.matches.map(parseMatch);
    if (!source || !destination || matches.some((match) => match === null)) {
        return null;
    }
    if ((value.outcome === "found") !== matches.length > 0) {
        return null;
    }
    return {
        outcome: value.outcome,
        source,
        destination,
        matches: matches,
        partiallyInspected: Array.isArray(value.issues) &&
            value.issues.some((issue) => typeof issue === "string" &&
                issue.startsWith(PARTIAL_INSPECTION_ISSUE_PREFIX)),
    };
}
function errorEvaluation(reason) {
    return {
        result: "error",
        reason,
        matchCount: null,
        nofollowCount: null,
        data: null,
    };
}
export function evaluateEnvelope({ envelope, inputs, }) {
    if (!isRecord(envelope) || !isRecord(envelope.result)) {
        return errorEvaluation("invalid_response");
    }
    const structured = envelope.result.structuredContent;
    if (!isRecord(structured)) {
        return errorEvaluation("invalid_response");
    }
    if (isRecord(structured.error)) {
        return errorEvaluation(structured.error.code === "invalid_request"
            ? "invalid_request"
            : "check_failed");
    }
    const data = parsePlacementData(structured.data);
    if (!data) {
        return errorEvaluation("invalid_response");
    }
    const matchCount = data.matches.length;
    const nofollowCount = data.matches.filter((match) => match.nofollow).length;
    const counted = { matchCount, nofollowCount, data };
    if (data.outcome === "indeterminate") {
        return { result: "error", reason: "source_not_inspected", ...counted };
    }
    if (data.outcome === "not_found" && data.partiallyInspected) {
        return {
            result: "error",
            reason: "source_partially_inspected",
            ...counted,
        };
    }
    if (data.outcome === "not_found") {
        return { result: "fail", reason: "link_missing", ...counted };
    }
    const expectedAnchorText = inputs.expectedAnchorText;
    if (expectedAnchorText &&
        !data.matches.some((match) => normalizeText(match.anchorText) === expectedAnchorText)) {
        return { result: "fail", reason: "anchor_mismatch", ...counted };
    }
    if (inputs.requireNofollow && nofollowCount < matchCount) {
        return { result: "fail", reason: "nofollow_missing", ...counted };
    }
    return { result: "pass", reason: "link_present", ...counted };
}
async function readBoundedText(response) {
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
        await response.body?.cancel();
        return null;
    }
    if (!response.body) {
        return "";
    }
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        received += value.byteLength;
        if (received > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            return null;
        }
        chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
}
export async function requestPlacement({ endpoint, inputs, fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS, }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetchImpl(endpoint, {
            method: "POST",
            redirect: "error",
            signal: controller.signal,
            headers: {
                accept: "application/json, text/event-stream",
                "content-type": "application/json",
                "mcp-protocol-version": MCP_PROTOCOL_VERSION,
                "user-agent": `linkbunny-placement-check-action/${ACTION_VERSION}`,
            },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: {
                    name: "inspect_placement",
                    arguments: {
                        publishedPageURL: inputs.pageURL,
                        expectedDestinationURL: inputs.expectedURL,
                    },
                },
            }),
        });
        if (response.status === 429) {
            await response.body?.cancel();
            return errorEvaluation("rate_limited");
        }
        if (response.status !== 200) {
            await response.body?.cancel();
            return errorEvaluation("unavailable");
        }
        if (!(response.headers.get("content-type") ?? "").includes("application/json")) {
            await response.body?.cancel();
            return errorEvaluation("invalid_response");
        }
        const text = await readBoundedText(response);
        if (text === null) {
            return errorEvaluation("invalid_response");
        }
        let envelope;
        try {
            envelope = JSON.parse(text);
        }
        catch {
            return errorEvaluation("invalid_response");
        }
        return evaluateEnvelope({ envelope, inputs });
    }
    catch {
        return errorEvaluation(controller.signal.aborted ? "timeout" : "unavailable");
    }
    finally {
        clearTimeout(timer);
    }
}
const REASON_MESSAGES = {
    link_present: "The page links to the expected URL and every matching link meets the requirements.",
    link_missing: "No link to the expected URL was found in the page's fetched HTML.",
    nofollow_missing: "At least one link to the expected URL is missing rel=nofollow.",
    anchor_mismatch: "No link to the expected URL has the expected anchor text.",
    source_not_inspected: "The page could not be inspected (fetch failed or non-2xx status), so the link was not checked.",
    source_partially_inspected: "Only part of the page could be inspected (over 5,000 links or very long URLs), so a missing link was not confirmed.",
    invalid_input: "The action inputs are invalid.",
    invalid_request: "The checker rejected the URLs. Use two public HTTPS URLs.",
    check_failed: "The checker could not complete the check.",
    rate_limited: "The free hosted checker is at capacity. Try again later.",
    unavailable: "The hosted checker could not be reached or returned an unexpected status.",
    timeout: `The hosted checker did not respond within ${REQUEST_TIMEOUT_MS / 1000} seconds.`,
    invalid_response: "The hosted checker returned a response this action does not recognize.",
};
export function reasonMessage(reason) {
    return REASON_MESSAGES[reason];
}
function truncate(value) {
    return value.length > MAX_DISPLAY_LENGTH
        ? `${value.slice(0, MAX_DISPLAY_LENGTH)}…`
        : value;
}
export function escapeMarkdown(value) {
    return truncate(value)
        .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
        .replace(/[\\`*_{}[\]()<>#+\-.!|~&"'=:@$^%]/g, (char) => `&#${char.charCodeAt(0)};`);
}
export function escapeCommandData(value) {
    return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}
export function quoteForLog(value) {
    return JSON.stringify(truncate(value)).replace(/[\u2028\u2029]/g, (char) => char === "\u2028" ? "\\u2028" : "\\u2029");
}
function describeFetch(fetchResult) {
    return fetchResult.outcome === "fetched"
        ? `HTTP ${fetchResult.httpStatus}`
        : "not fetched";
}
export function renderSummary({ inputs, evaluation, }) {
    const lines = [
        "## LinkBunny placement check",
        "",
        `**Result:** ${evaluation.result} (${evaluation.reason})`,
        "",
        reasonMessage(evaluation.reason),
        "",
        `- Page: ${escapeMarkdown(inputs.pageURL)}`,
        `- Expected URL: ${escapeMarkdown(inputs.expectedURL)}`,
        `- Expected anchor text: ${inputs.expectedAnchorText ? escapeMarkdown(inputs.expectedAnchorText) : "any"}`,
        `- Require nofollow: ${inputs.requireNofollow ? "yes" : "no"}`,
    ];
    const data = evaluation.data;
    if (data) {
        lines.push(`- Page fetch: ${describeFetch(data.source)}`, `- Expected URL fetch: ${describeFetch(data.destination)}`, `- Matching links: ${evaluation.matchCount} (${evaluation.nofollowCount} nofollow)`);
        if (data.matches.length > 0) {
            lines.push("", "| # | Anchor text | rel | nofollow | href |", "| - | - | - | - | - |");
            data.matches.slice(0, MAX_REPORTED_MATCHES).forEach((match, index) => {
                lines.push(`| ${index + 1} | ${escapeMarkdown(normalizeText(match.anchorText)) || "(empty)"} | ${escapeMarkdown(match.relTokens.join(" ")) || "(none)"} | ${match.nofollow ? "yes" : "no"} | ${escapeMarkdown(match.href)} |`);
            });
            if (data.matches.length > MAX_REPORTED_MATCHES) {
                lines.push("", `Showing ${MAX_REPORTED_MATCHES} of ${data.matches.length} matching links.`);
            }
        }
    }
    lines.push("", "Checks fetched HTML only, without running JavaScript. It says nothing about indexing, rankings or how long a link will stay up.", "");
    return lines.join("\n");
}
export function renderLog({ evaluation, stopToken, }) {
    const lines = [
        `LinkBunny placement check: ${evaluation.result} (${evaluation.reason})`,
    ];
    const data = evaluation.data;
    if (data) {
        lines.push(`  page fetch: ${describeFetch(data.source)}; expected URL fetch: ${describeFetch(data.destination)}`, `  matching links: ${evaluation.matchCount} (${evaluation.nofollowCount} nofollow)`);
        if (data.matches.length > 0) {
            lines.push(`::stop-commands::${stopToken}`);
            data.matches.slice(0, MAX_REPORTED_MATCHES).forEach((match, index) => {
                lines.push(`  match ${index + 1}: anchor=${quoteForLog(normalizeText(match.anchorText))} rel=${quoteForLog(match.relTokens.join(" "))} nofollow=${match.nofollow} href=${quoteForLog(match.href)}`);
            });
            lines.push(`::${stopToken}::`);
        }
    }
    return lines;
}
export async function writeOutputs({ outputPath, evaluation, }) {
    if (!outputPath) {
        return;
    }
    const outputs = {
        result: evaluation.result,
        reason: evaluation.reason,
        "match-count": evaluation.matchCount === null ? "" : String(evaluation.matchCount),
        "nofollow-count": evaluation.nofollowCount === null ? "" : String(evaluation.nofollowCount),
    };
    await appendFile(outputPath, Object.entries(outputs)
        .map(([name, value]) => `${name}=${value}\n`)
        .join(""));
}
export async function run({ env = process.env, endpoint = CHECKER_ENDPOINT, fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS, write = (line) => process.stdout.write(`${line}\n`), } = {}) {
    let inputs;
    try {
        inputs = readInputs(env);
    }
    catch (error) {
        const message = error instanceof InputError
            ? error.message
            : reasonMessage("invalid_input");
        await writeOutputs({
            outputPath: env.GITHUB_OUTPUT,
            evaluation: {
                result: "error",
                reason: "invalid_input",
                matchCount: null,
                nofollowCount: null,
            },
        });
        write(`::error title=LinkBunny placement check::${escapeCommandData(message)}`);
        return 1;
    }
    const evaluation = await requestPlacement({
        endpoint,
        inputs,
        fetchImpl,
        timeoutMs,
    });
    for (const line of renderLog({ evaluation, stopToken: randomUUID() })) {
        write(line);
    }
    await writeOutputs({ outputPath: env.GITHUB_OUTPUT, evaluation });
    if (env.GITHUB_STEP_SUMMARY) {
        await appendFile(env.GITHUB_STEP_SUMMARY, renderSummary({ inputs, evaluation }));
    }
    const message = escapeCommandData(reasonMessage(evaluation.reason));
    if (evaluation.result === "fail" ||
        (evaluation.result === "error" && inputs.failOnError)) {
        write(`::error title=LinkBunny placement check::${message}`);
        return 1;
    }
    if (evaluation.result === "error") {
        write(`::warning title=LinkBunny placement check::${message}`);
    }
    return 0;
}
