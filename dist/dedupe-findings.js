import { createRequire } from 'node:module'; var require = createRequire(import.meta.url);

// src/dedupe-findings/index.ts
import { readFileSync, writeFileSync } from "fs";

// src/dedupe-findings/dedupe-findings.ts
var REVIEW_MARKERS = ["<!-- docker-agent-review -->", "<!-- cagent-review -->"];
var DEFAULT_LINE_TOLERANCE = 3;
var DEFAULT_SIMILARITY_THRESHOLD = 0.5;
function findingSignature(body) {
  const bold = body.match(/\*\*([^*\n]+)\*\*/);
  const heading = bold?.[1] ?? body.split("\n").find((line) => line.trim().length > 0) ?? "";
  const tokens = heading.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 0);
  return tokens.length > 0 ? [...new Set(tokens)] : null;
}
function signatureSimilarity(a, b) {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  let intersection = 0;
  for (const token of a) {
    if (setB.has(token)) intersection++;
  }
  const union = a.length + b.length - intersection;
  return union === 0 ? 0 : intersection / union;
}
function isBotReviewComment(comment) {
  const body = comment.body ?? "";
  return REVIEW_MARKERS.some((marker) => body.includes(marker));
}
function anchorLine(comment) {
  const line = comment.line ?? comment.original_line;
  return typeof line === "number" && Number.isInteger(line) && line > 0 ? line : null;
}
function dedupeComments(newComments2, existingComments2, opts = {}) {
  const lineTolerance = opts.lineTolerance ?? DEFAULT_LINE_TOLERANCE;
  const similarityThreshold = opts.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const candidates = existingComments2.filter((comment) => isBotReviewComment(comment)).map((comment) => ({
    path: comment.path ?? "",
    line: anchorLine(comment),
    signature: findingSignature(comment.body ?? "")
  })).filter(
    (comment) => comment.path !== "" && comment.line !== null && comment.signature !== null
  );
  if (candidates.length === 0) {
    return { kept: [...newComments2], dropped: [] };
  }
  const kept = [];
  const dropped = [];
  for (const comment of newComments2) {
    const path = typeof comment.path === "string" ? comment.path : "";
    const line = typeof comment.line === "number" && Number.isInteger(comment.line) ? comment.line : null;
    const signature = typeof comment.body === "string" ? findingSignature(comment.body) : null;
    if (path === "" || line === null || signature === null) {
      kept.push(comment);
      continue;
    }
    const match = candidates.find(
      (candidate) => candidate.path === path && Math.abs(candidate.line - line) <= lineTolerance && signatureSimilarity(signature, candidate.signature) >= similarityThreshold
    );
    if (match) {
      dropped.push({ path, line, matchedLine: match.line, signature: signature.join(" ") });
    } else {
      kept.push(comment);
    }
  }
  return { kept, dropped };
}

// src/dedupe-findings/index.ts
var [, , newCommentsPath, existingCommentsPath] = process.argv;
if (!newCommentsPath || !existingCommentsPath) {
  process.stderr.write("Usage: dedupe-findings <newCommentsJsonPath> <existingCommentsJsonPath>\n");
  process.exit(1);
}
function warn(message) {
  process.stderr.write(`${message}
`);
}
function readJsonArray(path, label) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (!Array.isArray(parsed)) {
      warn(`\u26A0\uFE0F  ${path} is not a JSON array \u2014 skipping ${label}`);
      return null;
    }
    return parsed;
  } catch (err) {
    if (err.code === "ENOENT") {
      warn(`\u26A0\uFE0F  No ${label} file at ${path} \u2014 skipping deduplication`);
    } else {
      warn(
        `\u26A0\uFE0F  Could not read ${path} (${err instanceof Error ? err.message : String(err)}) \u2014 skipping deduplication`
      );
    }
    return null;
  }
}
var newComments = readJsonArray(newCommentsPath, "new comments");
if (newComments === null) process.exit(0);
var existingComments = readJsonArray(existingCommentsPath, "existing comments");
if (existingComments === null) process.exit(0);
var result = dedupeComments(newComments, existingComments);
for (const drop of result.dropped) {
  warn(
    `\u23ED\uFE0F Dropped duplicate finding on ${drop.path}:${drop.line} (matches existing comment at line ${drop.matchedLine}: "${drop.signature}")`
  );
}
if (result.dropped.length > 0) {
  writeFileSync(newCommentsPath, `${JSON.stringify(result.kept, null, 2)}
`, "utf-8");
  warn(
    `\u2705 Deduplication: kept ${result.kept.length}, dropped ${result.dropped.length} duplicate(s) (rewrote ${newCommentsPath})`
  );
} else {
  warn(`\u2705 Deduplication: kept ${result.kept.length}, dropped 0 (no changes)`);
}
