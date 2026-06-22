import { createRequire } from 'node:module'; var require = createRequire(import.meta.url);

// src/score-risk/index.ts
import { readFileSync, writeFileSync } from "fs";

// src/score-risk/score-risk.ts
var SECURITY_PATH_RE = /auth|security|crypto|session|secret|token|password|credential/i;
var TEST_FILE_RE = /_test\.go$|\.test\.[tj]sx?$|\.spec\.[tj]sx?$|test_.*\.py$|\.md$|\.ya?ml$|\.json$|\.toml$|_test\.rs$|_bench\.rs$|_spec\.rs$|_spec\.rb$|(^|\/)(tests?|benches|__tests__|specs?)\//i;
var ERROR_PATTERN_RE = /catch|rescue|except|recover|error|panic/;
var GENERATED_MARKER_RE = /Code generated|DO NOT EDIT/;
function extractFilePath(diffGitLine) {
  const after = diffGitLine.slice("diff --git a/".length);
  const sepIdx = after.indexOf(" b/");
  return sepIdx >= 0 ? after.slice(0, sepIdx) : after;
}
function isAddedLine(line) {
  return line.length >= 2 && line[0] === "+" && line[1] !== "+";
}
function parseDiffStats(diffContent) {
  const stats = [];
  let current = null;
  for (const line of diffContent.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (current) stats.push(current);
      current = { path: extractFilePath(line), addedLines: 0, hunks: 0 };
    } else if (current !== null) {
      if (line.startsWith("@@")) {
        current.hunks++;
      } else if (isAddedLine(line)) {
        current.addedLines++;
      }
    }
  }
  if (current) stats.push(current);
  return stats;
}
function hasGeneratedMarker(diffContent, filePath) {
  let inFile = false;
  let addedCount = 0;
  for (const line of diffContent.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inFile = extractFilePath(line) === filePath;
      if (inFile) addedCount = 0;
    } else if (inFile && isAddedLine(line)) {
      addedCount++;
      if (GENERATED_MARKER_RE.test(line)) return true;
      if (addedCount >= 5) return false;
    }
  }
  return false;
}
function countErrorHandlingLines(diffContent, filePath) {
  let inFile = false;
  let count = 0;
  for (const line of diffContent.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inFile = extractFilePath(line) === filePath;
    } else if (inFile && isAddedLine(line) && ERROR_PATTERN_RE.test(line)) {
      count++;
    }
  }
  return count;
}
function parseExcludePrefixes(excludePathsStr) {
  return excludePathsStr.split("\n").map((p) => p.replace(/\r/g, "").trim()).filter((p) => p.length > 0);
}
function scoreFiles(diffContent, excludePrefixes) {
  const stats = parseDiffStats(diffContent);
  const scores = {};
  for (const { path, addedLines, hunks } of stats) {
    if (excludePrefixes.some((prefix) => path.startsWith(prefix))) {
      scores[path] = 0;
      continue;
    }
    if (hasGeneratedMarker(diffContent, path)) {
      scores[path] = 0;
      continue;
    }
    let score = 0;
    if (SECURITY_PATH_RE.test(path)) score += 2;
    if (addedLines > 100) score += 2;
    if (hunks > 3) score += 1;
    if (TEST_FILE_RE.test(path)) score = 0;
    if (countErrorHandlingLines(diffContent, path) > 0) score += 1;
    scores[path] = score;
  }
  return scores;
}

// src/score-risk/index.ts
var SCORES_OUTPUT_PATH = "/tmp/file_risk_scores.json";
var [, , diffPath, excludePathsArg] = process.argv;
if (!diffPath) {
  process.stderr.write("Usage: score-risk <diffPath> <excludePaths>\n");
  process.exit(1);
}
try {
  const diffContent = readFileSync(diffPath, "utf-8");
  const prefixes = parseExcludePrefixes(excludePathsArg ?? "");
  const scores = scoreFiles(diffContent, prefixes);
  writeFileSync(SCORES_OUTPUT_PATH, JSON.stringify(scores), "utf-8");
} catch (err) {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}
`);
  process.exit(1);
}
