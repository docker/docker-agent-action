import { createRequire } from 'node:module'; var require = createRequire(import.meta.url);

// src/validate-suggestions/index.ts
import { readFileSync, writeFileSync } from "fs";

// src/validate-suggestions/validate-suggestions.ts
var REVIEW_MARKER = "<!-- docker-agent-review -->";
var HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
function parseAddressableLines(diff2) {
  const byPath = /* @__PURE__ */ new Map();
  let currentPath = "";
  let lineNo = 0;
  for (const raw of diff2.split("\n")) {
    if (raw.startsWith("+++ ")) {
      currentPath = parseHeaderPath(raw);
      continue;
    }
    if (raw.startsWith("--- ")) continue;
    const hunk = HUNK_HEADER.exec(raw);
    if (hunk) {
      lineNo = parseInt(hunk[1], 10);
      continue;
    }
    if (!currentPath || lineNo === 0) continue;
    if (raw.startsWith("+")) {
      record(byPath, currentPath, lineNo);
      lineNo++;
    } else if (raw.startsWith(" ")) {
      record(byPath, currentPath, lineNo);
      lineNo++;
    } else if (raw.startsWith("-")) {
    }
  }
  return byPath;
}
function record(byPath, path, line) {
  let set = byPath.get(path);
  if (!set) {
    set = /* @__PURE__ */ new Set();
    byPath.set(path, set);
  }
  set.add(line);
}
function parseHeaderPath(raw) {
  let rest = raw.slice("+++ ".length);
  if (rest.startsWith('"')) {
    rest = decodeCQuotedPath(rest);
  } else {
    const tab = rest.indexOf("	");
    if (tab !== -1) rest = rest.slice(0, tab);
  }
  return rest.startsWith("b/") ? rest.slice("b/".length) : "";
}
var C_ESCAPES = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  "\\": 92
};
function decodeCQuotedPath(quoted) {
  const close = quoted.lastIndexOf('"');
  const s = close > 0 ? quoted.slice(1, close) : quoted.slice(1);
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "\\") {
      bytes.push(s.charCodeAt(i) & 255);
      continue;
    }
    const next = s[i + 1];
    if (next >= "0" && next <= "7") {
      let oct = "";
      while (i + 1 < s.length && oct.length < 3 && s[i + 1] >= "0" && s[i + 1] <= "7") {
        oct += s[++i];
      }
      bytes.push(parseInt(oct, 8) & 255);
    } else if (next !== void 0) {
      bytes.push(C_ESCAPES[next] ?? next.charCodeAt(0) & 255);
      i++;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}
var SUGGESTION_OPEN = /^\s*(`{3,})\s*suggestion\s*$/i;
var FENCE_CLOSE = /^\s*(`{3,})\s*$/;
function findSuggestionBlocks(lines) {
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const open = SUGGESTION_OPEN.exec(lines[i]);
    if (!open) continue;
    const openLen = open[1].length;
    let close = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (SUGGESTION_OPEN.test(lines[j])) break;
      const fence = FENCE_CLOSE.exec(lines[j]);
      if (fence && fence[1].length >= openLen) {
        close = j;
        break;
      }
    }
    if (close === -1) {
      blocks.push({ start: i, end: lines.length - 1, closed: false });
      break;
    }
    blocks.push({ start: i, end: close, closed: true });
    i = close;
  }
  return blocks;
}
function validateAnchor(comment, addressable) {
  const side = comment.side ?? "RIGHT";
  if (side === "LEFT") {
    return {
      valid: false,
      reason: "suggestion on a deleted (LEFT) line; suggestions apply to the right side only"
    };
  }
  const lines = addressable.get(comment.path);
  if (!lines || lines.size === 0) {
    return { valid: false, reason: `no addressable diff lines for ${comment.path}` };
  }
  const end = comment.line;
  const start = comment.start_line ?? comment.line;
  if (!Number.isInteger(end)) {
    return {
      valid: false,
      reason: `comment line anchor is not a valid integer (got ${String(end)})`
    };
  }
  if (comment.start_line !== void 0) {
    if (!Number.isInteger(start)) {
      return {
        valid: false,
        reason: `comment start_line is not a valid integer (got ${String(start)})`
      };
    }
    if ((comment.start_side ?? "RIGHT") === "LEFT") {
      return { valid: false, reason: "multi-line suggestion with start_side LEFT" };
    }
    if (!(start < end)) {
      return {
        valid: false,
        reason: `invalid multi-line range: start_line (${start}) must be < line (${end})`
      };
    }
  }
  for (let n = start; n <= end; n++) {
    if (!lines.has(n)) {
      return {
        valid: false,
        reason: `line ${n} is not an added/context line in the diff for ${comment.path} (range ${start}-${end})`
      };
    }
  }
  return { valid: true };
}
function stripBlocks(lines, blocks) {
  const drop = new Array(lines.length).fill(false);
  for (const b of blocks) {
    for (let i = b.start; i <= b.end; i++) drop[i] = true;
  }
  const kept = lines.filter((_, i) => !drop[i]);
  const tidy = [];
  for (const line of kept) {
    const blank = line.trim() === "";
    if (blank && (tidy.length === 0 || tidy[tidy.length - 1].trim() === "")) continue;
    tidy.push(line);
  }
  while (tidy.length > 0 && tidy[tidy.length - 1].trim() === "") tidy.pop();
  const hadMarker = lines.some((l) => l.includes(REVIEW_MARKER));
  const stillHasMarker = tidy.some((l) => l.includes(REVIEW_MARKER));
  if (hadMarker && !stillHasMarker) {
    tidy.push("", REVIEW_MARKER);
  }
  return tidy.join("\n");
}
function sanitizeComments(comments2, diff2) {
  const addressable = parseAddressableLines(diff2);
  const issues = [];
  let suggestionsKept = 0;
  let suggestionsStripped = 0;
  const out = comments2.map((comment) => {
    const bodyLines = (comment.body ?? "").split("\n");
    const blocks = findSuggestionBlocks(bodyLines);
    if (blocks.length === 0) return comment;
    const anchor = validateAnchor(comment, addressable);
    if (!anchor.valid) {
      suggestionsStripped += blocks.length;
      issues.push({
        path: comment.path,
        line: comment.line,
        reason: anchor.reason ?? "invalid anchor"
      });
      const sanitized = { ...comment, body: stripBlocks(bodyLines, blocks) };
      delete sanitized.start_line;
      delete sanitized.start_side;
      return sanitized;
    }
    const unclosed = blocks.filter((b) => !b.closed);
    suggestionsKept += blocks.length - unclosed.length;
    if (unclosed.length === 0) return comment;
    suggestionsStripped += unclosed.length;
    issues.push({ path: comment.path, line: comment.line, reason: "unclosed ```suggestion fence" });
    return { ...comment, body: stripBlocks(bodyLines, unclosed) };
  });
  return { comments: out, issues, suggestionsKept, suggestionsStripped };
}

// src/validate-suggestions/index.ts
var [, , commentsPath, diffPath] = process.argv;
if (!commentsPath || !diffPath) {
  process.stderr.write("Usage: validate-suggestions <commentsJsonPath> <diffPath>\n");
  process.exit(1);
}
function warn(message) {
  process.stderr.write(`${message}
`);
}
var comments;
try {
  const parsed = JSON.parse(readFileSync(commentsPath, "utf-8"));
  if (!Array.isArray(parsed)) {
    warn(`\u26A0\uFE0F  ${commentsPath} is not a JSON array \u2014 leaving it unchanged`);
    process.exit(0);
  }
  comments = parsed;
} catch (err) {
  if (err.code === "ENOENT") {
    warn(`\u26A0\uFE0F  No comments file at ${commentsPath} \u2014 nothing to validate`);
  } else {
    warn(
      `\u26A0\uFE0F  Could not read ${commentsPath} (${err instanceof Error ? err.message : String(err)}) \u2014 leaving it unchanged`
    );
  }
  process.exit(0);
}
var diff = "";
try {
  diff = readFileSync(diffPath, "utf-8");
} catch (err) {
  if (err.code !== "ENOENT") {
    warn(
      `\u26A0\uFE0F  Could not read diff ${diffPath} (${err instanceof Error ? err.message : String(err)})`
    );
  }
}
if (!diff) {
  warn(
    `\u26A0\uFE0F  No usable diff at ${diffPath} \u2014 cannot verify suggestion line ranges; stripping all suggestion blocks to avoid a malformed-suggestion 422`
  );
}
var result = sanitizeComments(comments, diff);
for (const issue of result.issues) {
  warn(`\u26A0\uFE0F  Stripped suggestion on ${issue.path}:${issue.line} \u2014 ${issue.reason}`);
}
if (result.suggestionsStripped > 0) {
  writeFileSync(commentsPath, `${JSON.stringify(result.comments, null, 2)}
`, "utf-8");
  warn(
    `\u2705 Suggestion validation: kept ${result.suggestionsKept}, stripped ${result.suggestionsStripped} (rewrote ${commentsPath})`
  );
} else {
  warn(`\u2705 Suggestion validation: kept ${result.suggestionsKept}, stripped 0 (no changes)`);
}
