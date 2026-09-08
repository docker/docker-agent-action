import { createRequire } from 'node:module'; var require = createRequire(import.meta.url);

// src/dedupe-findings/index.ts
import { readFileSync, writeFileSync } from "fs";

// src/dedupe-findings/dedupe-findings.ts
var REVIEW_MARKERS = ["<!-- docker-agent-review -->", "<!-- cagent-review -->"];
var DEFAULT_LINE_TOLERANCE = 3;
var DEFAULT_SIMILARITY_THRESHOLD = 0.5;
var DEFAULT_ANCHOR_LINE_TOLERANCE = 20;
var MIN_SHARED_ANCHORS = 2;
var MIN_HEADING_OVERLAP = 3;
var SEVERITY_TOKENS = /* @__PURE__ */ new Set(["high", "medium", "low"]);
var SEVERITY_RANK = { high: 3, medium: 2, low: 1 };
var NON_ANCHOR_TOKENS = /* @__PURE__ */ new Set([
  ...SEVERITY_TOKENS,
  "security",
  "logic_error",
  "resource_leak",
  "concurrency",
  "error_handling",
  "data_integrity",
  "other"
]);
var HEADING_NOISE_TOKENS = /* @__PURE__ */ new Set([
  ...SEVERITY_TOKENS,
  ...["security", "logic", "error", "resource", "leak", "concurrency", "handling"],
  ...["data", "integrity", "other"],
  ...["a", "an", "the", "and", "or", "nor", "not", "no"],
  ...["of", "in", "on", "at", "to", "from", "for", "with", "without", "via", "by", "as"],
  ...["into", "onto", "over", "under", "between", "within", "across", "per"],
  ...["is", "are", "was", "were", "be", "been", "being", "has", "have", "had"],
  ...["do", "does", "did", "done", "can", "could", "may", "might", "must", "should"],
  ...["would", "will", "it", "its", "this", "that", "these", "those", "their"],
  ...["there", "then", "than", "when", "while", "where", "which", "who", "whose"],
  ...["what", "how", "why", "if", "but", "so", "after", "before", "during"],
  ...["still", "also", "only", "never", "always", "same", "each", "every", "all"],
  ...["any", "some"]
]);
var LEADING_TAG = /^[\s*_]*\[([^\]\n]*)\]/;
var FENCED_CODE_BLOCK = /```[\s\S]*?```/g;
var HTML_COMMENT = /<!--[\s\S]*?-->/g;
var INLINE_CODE_SPAN = /`([^`\n]+)`/g;
var IDENTIFIER_WORD = /[A-Za-z_][A-Za-z0-9_]*/g;
function tokenize(text) {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 0);
}
function headingOf(body) {
  const bold = body.match(/\*\*([^*\n]+)\*\*/);
  return bold?.[1] ?? body.split("\n").find((line) => line.trim().length > 0) ?? "";
}
function findingSignature(body) {
  let heading = headingOf(body);
  const tokens = [];
  let tag = heading.match(LEADING_TAG);
  while (tag !== null) {
    tokens.push(...tokenize(tag[1]).filter((token) => !SEVERITY_TOKENS.has(token)));
    heading = heading.slice(tag[0].length);
    tag = heading.match(LEADING_TAG);
  }
  tokens.push(...tokenize(heading));
  return tokens.length > 0 ? [...new Set(tokens)] : null;
}
function isSeverity(token) {
  return SEVERITY_TOKENS.has(token);
}
function headingSeverity(body) {
  let heading = headingOf(body);
  let tag = heading.match(LEADING_TAG);
  while (tag !== null) {
    const severity = tokenize(tag[1]).find(isSeverity);
    if (severity !== void 0) return severity;
    heading = heading.slice(tag[0].length);
    tag = heading.match(LEADING_TAG);
  }
  return null;
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
function meaningfulHeadingOverlap(a, b) {
  const setB = new Set(b);
  let shared = 0;
  for (const token of a) {
    if (!HEADING_NOISE_TOKENS.has(token) && setB.has(token)) shared++;
  }
  return shared;
}
function codeAnchors(body) {
  const prose = body.replace(FENCED_CODE_BLOCK, " ").replace(HTML_COMMENT, " ");
  const anchors = /* @__PURE__ */ new Set();
  for (const match of prose.matchAll(INLINE_CODE_SPAN)) {
    const span = match[1].trim();
    if (span.length >= 3 && !/\s/.test(span) && /[A-Z0-9_./*-]/.test(span)) {
      addAnchor(anchors, span);
    }
  }
  for (const match of prose.matchAll(IDENTIFIER_WORD)) {
    const word = match[0];
    if (word.length >= 3 && (word.includes("_") || /[a-z][A-Z]/.test(word) || /[A-Za-z][0-9]/.test(word))) {
      addAnchor(anchors, word);
    }
  }
  return [...anchors];
}
function addAnchor(anchors, raw) {
  const anchor = raw.toLowerCase();
  if (!NON_ANCHOR_TOKENS.has(anchor)) anchors.add(anchor);
}
function hasReviewMarker(body) {
  return REVIEW_MARKERS.some((marker) => body.includes(marker));
}
function isBotReviewComment(comment) {
  return hasReviewMarker(comment.body ?? "");
}
function anchorLine(comment) {
  const line = comment.line ?? comment.original_line;
  return typeof line === "number" && Number.isInteger(line) && line > 0 ? line : null;
}
function commentId(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}
function threadAnchorLine(thread) {
  const line = thread.line ?? thread.originalLine;
  return typeof line === "number" && Number.isInteger(line) && line > 0 ? line : null;
}
function threadRootComment(thread) {
  const nodes = thread.comments?.nodes;
  if (!Array.isArray(nodes)) return null;
  const first = nodes.find((node) => typeof node === "object" && node !== null);
  return first == null || first.replyTo ? null : first;
}
function buildThreadCandidates(threads) {
  const candidates = { current: [], outdated: [], outdatedRootIds: /* @__PURE__ */ new Set() };
  if (!Array.isArray(threads)) return candidates;
  for (const thread of threads) {
    if (typeof thread !== "object" || thread === null) continue;
    if (thread.isOutdated !== false && thread.isOutdated !== true) continue;
    const root = threadRootComment(thread);
    const body = typeof root?.body === "string" ? root.body : "";
    if (!hasReviewMarker(body)) continue;
    const rootId = commentId(root?.databaseId);
    if (thread.isOutdated === true && rootId !== null) candidates.outdatedRootIds.add(rootId);
    const path = typeof thread.path === "string" ? thread.path : "";
    const line = threadAnchorLine(thread);
    if (path === "" || line === null) continue;
    const signature = findingSignature(body);
    if (signature === null) continue;
    const candidate = {
      path,
      line,
      signature,
      anchors: new Set(codeAnchors(body)),
      severity: headingSeverity(body)
    };
    (thread.isOutdated === false ? candidates.current : candidates.outdated).push(candidate);
  }
  return candidates;
}
function sharedAnchorCount(anchors, candidateAnchors) {
  let shared = 0;
  for (const anchor of anchors) {
    if (candidateAnchors.has(anchor)) shared++;
  }
  return shared;
}
function dedupeComments(newComments, existingComments, opts = {}) {
  const lineTolerance = opts.lineTolerance ?? DEFAULT_LINE_TOLERANCE;
  const similarityThreshold = opts.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const anchorLineTolerance = opts.anchorLineTolerance ?? DEFAULT_ANCHOR_LINE_TOLERANCE;
  const threadCandidates = buildThreadCandidates(opts.priorThreads);
  const hasThreadCandidates = threadCandidates.current.length > 0 || threadCandidates.outdated.length > 0;
  const commentCandidates = existingComments.filter((comment) => isBotReviewComment(comment)).filter((comment) => {
    const id = commentId(comment.id);
    return id === null || !threadCandidates.outdatedRootIds.has(id);
  }).map((comment) => ({
    path: comment.path ?? "",
    line: anchorLine(comment),
    signature: findingSignature(comment.body ?? "")
  })).filter(
    (comment) => comment.path !== "" && comment.line !== null && comment.signature !== null
  );
  if (commentCandidates.length === 0 && !hasThreadCandidates) {
    return { kept: [...newComments], dropped: [], escalations: [] };
  }
  const matchesByHeading = (candidate, path, line, signature) => candidate.path === path && Math.abs(candidate.line - line) <= lineTolerance && signatureSimilarity(signature, candidate.signature) >= similarityThreshold;
  const matchThread = (candidate, path, line, signature, anchors) => {
    if (candidate.path !== path) return null;
    if (matchesByHeading(candidate, path, line, signature)) return "heading";
    if (Math.abs(candidate.line - line) <= anchorLineTolerance && sharedAnchorCount(anchors, candidate.anchors) >= MIN_SHARED_ANCHORS && meaningfulHeadingOverlap(signature, candidate.signature) >= MIN_HEADING_OVERLAP) {
      return "anchors";
    }
    return null;
  };
  const kept = [];
  const dropped = [];
  const escalations = [];
  for (const comment of newComments) {
    const path = typeof comment.path === "string" ? comment.path : "";
    const line = typeof comment.line === "number" && Number.isInteger(comment.line) ? comment.line : null;
    const body = typeof comment.body === "string" ? comment.body : "";
    const signature = findingSignature(body);
    if (path === "" || line === null || signature === null) {
      kept.push(comment);
      continue;
    }
    const commentMatch = commentCandidates.find(
      (candidate) => matchesByHeading(candidate, path, line, signature)
    );
    if (commentMatch) {
      dropped.push({
        path,
        line,
        matchedLine: commentMatch.line,
        signature: signature.join(" "),
        source: "existing-comment",
        matchedBy: "heading"
      });
      continue;
    }
    const anchors = hasThreadCandidates ? codeAnchors(body) : [];
    let threadDrop = null;
    for (const candidate of threadCandidates.current) {
      const matchedBy = matchThread(candidate, path, line, signature, anchors);
      if (matchedBy === null) continue;
      threadDrop = {
        path,
        line,
        matchedLine: candidate.line,
        signature: signature.join(" "),
        source: "prior-thread",
        matchedBy
      };
      break;
    }
    if (threadDrop) {
      dropped.push(threadDrop);
      continue;
    }
    kept.push(comment);
    const newSeverity = headingSeverity(body);
    if (newSeverity === null) continue;
    for (const candidate of threadCandidates.outdated) {
      if (candidate.severity === null) continue;
      if (SEVERITY_RANK[newSeverity] <= SEVERITY_RANK[candidate.severity]) continue;
      const matchedBy = matchThread(candidate, path, line, signature, anchors);
      if (matchedBy === null) continue;
      escalations.push({
        path,
        line,
        matchedLine: candidate.line,
        signature: signature.join(" "),
        newSeverity,
        priorSeverity: candidate.severity,
        matchedBy
      });
      break;
    }
  }
  return { kept, dropped, escalations };
}

// src/dedupe-findings/index.ts
var defaultWarn = (message) => {
  process.stderr.write(`${message}
`);
};
function readJsonArray(path, label, consequence, warn) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (!Array.isArray(parsed)) {
      warn(`\u26A0\uFE0F  ${path} is not a JSON array \u2014 ${consequence}`);
      return null;
    }
    return parsed;
  } catch (err) {
    if (err.code === "ENOENT") {
      warn(`\u26A0\uFE0F  No ${label} file at ${path} \u2014 ${consequence}`);
    } else {
      warn(
        `\u26A0\uFE0F  Could not read ${path} (${err instanceof Error ? err.message : String(err)}) \u2014 ${consequence}`
      );
    }
    return null;
  }
}
function run(args, warn = defaultWarn) {
  const [newCommentsPath, existingCommentsPath, priorThreadsPath] = args;
  if (!newCommentsPath || !existingCommentsPath) {
    warn(
      "Usage: dedupe-findings <newCommentsJsonPath> <existingCommentsJsonPath> [priorThreadsJsonPath]"
    );
    return 1;
  }
  const newComments = readJsonArray(
    newCommentsPath,
    "new comments",
    "skipping deduplication",
    warn
  );
  if (newComments === null) return 0;
  const existingComments = readJsonArray(
    existingCommentsPath,
    "existing comments",
    "continuing without existing comments",
    warn
  ) ?? [];
  let priorThreads;
  if (priorThreadsPath) {
    const parsed = readJsonArray(
      priorThreadsPath,
      "prior review threads",
      "continuing without thread history",
      warn
    );
    if (parsed !== null) priorThreads = parsed;
  }
  const result = dedupeComments(
    newComments,
    existingComments,
    { priorThreads }
  );
  for (const drop of result.dropped) {
    const matched = drop.source === "prior-thread" ? "prior review thread" : "existing comment";
    const how = drop.matchedBy === "anchors" ? " via shared code anchors" : "";
    warn(
      `\u23ED\uFE0F Dropped duplicate finding on ${drop.path}:${drop.line} (matches ${matched} at line ${drop.matchedLine}${how}: "${drop.signature}")`
    );
  }
  for (const escalation of result.escalations) {
    warn(
      `\u26A0\uFE0F Severity escalation on ${escalation.path}:${escalation.line}: [${escalation.newSeverity}] vs [${escalation.priorSeverity}] on the outdated prior thread at line ${escalation.matchedLine} ("${escalation.signature}"). Kept for reassessment \u2014 the comment must cite changed-code evidence justifying the higher severity.`
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
  return 0;
}
if (process.argv[1]?.endsWith("dedupe-findings.js") && !process.env.VITEST) {
  process.exit(run(process.argv.slice(2)));
}
export {
  run
};
