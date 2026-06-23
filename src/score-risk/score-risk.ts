// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * score-risk — per-file risk scoring for the PR review pipeline.
 *
 * Replicates the "Score file risk" bash/awk block from review-pr/action.yml
 * as a testable, type-safe TypeScript module.
 *
 * Scoring rules (applied in order, all additive unless noted):
 *   1. Excluded prefix match          → score 0, skip remaining rules
 *   2. Generated-file marker          → score 0, skip remaining rules
 *      (first 5 added lines contain "Code generated" or "DO NOT EDIT")
 *   3. Security-sensitive path        → +2
 *      (auth|security|crypto|session|secret|token|password|credential, case-insensitive)
 *   4. Large change (>100 added lines)→ +2
 *   5. Many hunks   (>3 hunk headers) → +1
 *   6. Test/doc/config file           → score = 0  (resets baseline + 3-5 to zero)
 *   7. Error-handling patterns        → +1
 *      (catch|rescue|except|recover|error|panic in any added line, case-sensitive)
 *
 * Files not caught by rules 1, 2, or 6 start with a baseline score of 1
 * so that ordinary application code is never auto-excluded alongside
 * intentionally-low-risk files (tests, docs, generated code, JSON configs).
 *
 * Rule 6 resets the running total to 0, then rule 7 can still add 1.
 * This faithfully reproduces the existing bash behaviour for test/doc/config
 * files while ensuring plain application files always reach the reviewer.
 */

// ---------------------------------------------------------------------------
// Regexes — kept as module-level constants so they are compiled once
// ---------------------------------------------------------------------------

/** Matches security-sensitive keywords in a file path (case-insensitive). */
const SECURITY_PATH_RE = /auth|security|crypto|session|secret|token|password|credential/i;

/** Matches test, documentation, and config file extensions (case-insensitive). */
const TEST_FILE_RE =
  /_test\.go$|\.test\.[tj]sx?$|\.spec\.[tj]sx?$|test_.*\.py$|\.md$|\.ya?ml$|\.json$|\.toml$|_test\.rs$|_bench\.rs$|_spec\.rs$|_spec\.rb$|(^|\/)(tests?|benches|__tests__|specs?)\//i;

/** Matches error-handling keywords in diff hunk lines (case-sensitive, matching bash awk). */
const ERROR_PATTERN_RE = /catch|rescue|except|recover|error|panic/;

/** Matches generated-file header strings. */
const GENERATED_MARKER_RE = /Code generated|DO NOT EDIT/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Map from file path to integer risk score (0 = lowest risk). */
export type RiskScores = Record<string, number>;

/** Per-file diff statistics gathered in a single forward pass. */
interface FileStat {
  path: string;
  addedLines: number;
  hunks: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract the destination file path from a `diff --git a/… b/…` header line.
 *
 * The standard git diff format is:
 *   diff --git a/<path> b/<path>
 * where `<path>` is identical on both sides for modifications, deletions, and
 * new files.  We strip the `diff --git a/` prefix (13 chars) and then take
 * everything before the first ` b/` separator.
 *
 * Using `indexOf(' b/')` (space-b-slash) rather than a greedy `.*b\/` regex
 * avoids a mis-extraction for paths whose directory components contain `b/`
 * (e.g. `.github/workflows/ci.yml` where `github/` contains `b/`).
 */
function extractFilePath(diffGitLine: string): string {
  const after = diffGitLine.slice('diff --git a/'.length);
  const sepIdx = after.indexOf(' b/');
  return sepIdx >= 0 ? after.slice(0, sepIdx) : after;
}

/**
 * Return true for a unified-diff added line (starts with `+` but not `+++`).
 * Matches the awk pattern `/^\+[^+]/`.
 */
function isAddedLine(line: string): boolean {
  return line.length >= 2 && line[0] === '+' && line[1] !== '+';
}

/**
 * Single forward pass over the diff to collect per-file stats.
 * Mirrors the awk block that builds /tmp/file_diff_stats.txt.
 */
function parseDiffStats(diffContent: string): FileStat[] {
  const stats: FileStat[] = [];
  let current: FileStat | null = null;

  for (const line of diffContent.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (current) stats.push(current);
      current = { path: extractFilePath(line), addedLines: 0, hunks: 0 };
    } else if (current !== null) {
      if (line.startsWith('@@')) {
        current.hunks++;
      } else if (isAddedLine(line)) {
        current.addedLines++;
      }
    }
  }

  if (current) stats.push(current);
  return stats;
}

/**
 * Scan the first 5 added lines of `filePath`'s section for a generated-file
 * marker ("Code generated" or "DO NOT EDIT").
 *
 * Only fires for brand-new files whose header appears on a `+` line.
 * For pre-existing generated files being modified the marker is a context line
 * (space-prefixed) and won't match — the exclude-paths check is the primary
 * mechanism for those.
 */
function hasGeneratedMarker(diffContent: string, filePath: string): boolean {
  let inFile = false;
  let addedCount = 0;

  for (const line of diffContent.split('\n')) {
    if (line.startsWith('diff --git ')) {
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

/**
 * Count added lines in `filePath`'s section that contain an error-handling
 * keyword.  Matches the awk error-pattern scan (case-sensitive).
 */
function countErrorHandlingLines(diffContent: string, filePath: string): number {
  let inFile = false;
  let count = 0;

  for (const line of diffContent.split('\n')) {
    if (line.startsWith('diff --git ')) {
      inFile = extractFilePath(line) === filePath;
    } else if (inFile && isAddedLine(line) && ERROR_PATTERN_RE.test(line)) {
      count++;
    }
  }

  return count;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a newline-separated exclude-paths string into trimmed, non-empty prefixes.
 * Strips carriage-return characters to handle Windows line-endings correctly.
 */
export function parseExcludePrefixes(excludePathsStr: string): string[] {
  return excludePathsStr
    .split('\n')
    .map((p) => p.replace(/\r/g, '').trim())
    .filter((p) => p.length > 0);
}

/**
 * Score every file in `diffContent` using the PR review risk heuristics.
 * Pure function — no filesystem access.
 *
 * @param diffContent    Raw unified diff text (as produced by `gh pr diff`).
 * @param excludePrefixes Trimmed, non-empty path prefix strings (files whose
 *                        path starts with any prefix receive score 0).
 * @returns              Map of { filePath → riskScore }.
 */
export function scoreFiles(diffContent: string, excludePrefixes: string[]): RiskScores {
  const stats = parseDiffStats(diffContent);
  const scores: RiskScores = {};

  for (const { path, addedLines, hunks } of stats) {
    // Rule 1: exclude-paths prefix → score 0, skip all other rules.
    if (excludePrefixes.some((prefix) => path.startsWith(prefix))) {
      scores[path] = 0;
      continue;
    }

    // Rule 2: generated-file markers in first 5 added lines → score 0, skip.
    // (Safety net for brand-new generated files not covered by exclude-paths.)
    if (hasGeneratedMarker(diffContent, path)) {
      scores[path] = 0;
      continue;
    }

    // Baseline: plain application files that don't match any positive rule
    // (rules 3-5) or the reset rule (6) still need review — give them score 1
    // so they are not auto-excluded alongside intentionally-low-risk files.
    // Rules 1 and 2 already exited early above with score 0; rule 6 resets to 0.
    let score = 1;

    // Rule 3: security-sensitive path → +2.
    if (SECURITY_PATH_RE.test(path)) score += 2;

    // Rule 4: large change (>100 added lines) → +2.
    if (addedLines > 100) score += 2;

    // Rule 5: many hunks (>3 hunk headers) → +1.
    if (hunks > 3) score += 1;

    // Rule 6: test/doc/config file → reset score to 0.
    if (TEST_FILE_RE.test(path)) score = 0;

    // Rule 7: error-handling patterns in added lines → +1.
    if (countErrorHandlingLines(diffContent, path) > 0) score += 1;

    scores[path] = score;
  }

  return scores;
}
