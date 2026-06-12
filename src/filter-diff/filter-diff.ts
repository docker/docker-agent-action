// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * filter-diff — core logic for stripping excluded-path sections from a unified diff.
 *
 * A section is excluded when any path-bearing line within it matches an
 * excluded pattern.  The three path-bearing line types handled are:
 *
 *   `--- a/<path>`    present for modifications and deletions
 *                     (deletions have `+++ /dev/null` so this is the only real path)
 *   `+++ b/<path>`    present for modifications and new-file additions
 *   `rename to <path>` present for pure renames (100% similarity — no --- or +++ lines)
 *
 * The `!skip` guard ensures only the first matching line per section is logged;
 * modifications have both `--- a/` and `+++ b/` pointing to the same path, so
 * the second occurrence is a no-op.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';

// path.matchesGlob landed in Node v22.5.0/v20.17.0. Not typed in
// @types/node@22.0.0 (lockfile update blocked by exotic subdep in
// @actions/artifact@6.2.1 — fixed upstream in 6.2.2, not yet published).
const matchesGlob: (path: string, pattern: string) => boolean = (
  nodePath as unknown as { matchesGlob: (path: string, pattern: string) => boolean }
).matchesGlob;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FilterResult {
  /** Filtered diff content.  Empty string when all sections were excluded. */
  filtered: string;
  /** File paths that were stripped (one entry per excluded section). */
  excludedFiles: string[];
  /** Number of diff sections remaining after filtering. */
  remainingCount: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a single exclude-paths entry to a glob pattern suitable for `path.matchesGlob`:
 *
 * - Entries already containing glob metacharacters (`*`, `?`, `[`) are passed through unchanged.
 * - Entries ending with `/` are expanded to `<entry>**` so the trailing-slash directory
 *   convention continues to work (e.g. `vendor/` → `vendor/**`).
 * - All other entries are treated as exact path matches (e.g. `package-lock.json`).
 */
function toGlob(pattern: string): string {
  if (/[*?[]/.test(pattern)) return pattern;
  if (pattern.endsWith('/')) return `${pattern}**`;
  return pattern;
}

/**
 * Parse a newline-separated exclude-paths string into normalized glob patterns.
 * Strips carriage-return characters so Windows line-endings are handled correctly.
 */
export function parseExcludePrefixes(excludePathsStr: string): string[] {
  return excludePathsStr
    .split('\n')
    .map((p) => p.replace(/\r/g, '').trim())
    .filter((p) => p.length > 0)
    .map(toGlob);
}

// ---------------------------------------------------------------------------
// Core filter (pure function)
// ---------------------------------------------------------------------------

/**
 * Filter sections from a unified diff string.  Pure function — no filesystem access.
 *
 * @param diffContent    Raw unified diff text (as produced by `gh pr diff`).
 * @param excludePrefixes Normalized glob patterns as returned by `parseExcludePrefixes`.
 *                        All entries are matched with `path.matchesGlob`.
 * @returns              Filtered diff text plus metadata about what was removed.
 */
export function filterDiff(diffContent: string, excludePrefixes: string[]): FilterResult {
  const prefixes = excludePrefixes.filter((p) => p.length > 0);

  // Short-circuit: nothing to filter.
  if (prefixes.length === 0 || diffContent === '') {
    const remainingCount = (diffContent.match(/^diff --git /gm) ?? []).length;
    return { filtered: diffContent, excludedFiles: [], remainingCount };
  }

  const isExcluded = (filePath: string): boolean =>
    prefixes.some((pattern) => matchesGlob(filePath, pattern));

  const lines = diffContent.split('\n');
  const outputLines: string[] = [];
  let sectionLines: string[] = [];
  let skip = false;
  const excludedFiles: string[] = [];
  let remainingCount = 0;

  const flushSection = (): void => {
    if (sectionLines.length === 0) return;
    if (!skip) {
      for (const l of sectionLines) outputLines.push(l);
      remainingCount++;
    }
    sectionLines = [];
    skip = false;
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      // Start of a new section — flush the previous one first.
      flushSection();
      sectionLines.push(line);
    } else if (sectionLines.length > 0) {
      // We are inside a section.  Check path-bearing lines until one matches.
      // The !skip guard avoids double-logging on modifications (--- a/ then +++ b/).
      if (!skip) {
        let filePath: string | null = null;

        if (line.startsWith('--- a/')) {
          filePath = line.slice(6); // "--- a/" is 6 chars
        } else if (line.startsWith('+++ b/')) {
          filePath = line.slice(6); // "+++ b/" is 6 chars
        } else if (line.startsWith('rename to ')) {
          filePath = line.slice(10); // "rename to " is 10 chars
        }

        if (filePath !== null && isExcluded(filePath)) {
          skip = true;
          excludedFiles.push(filePath);
        }
      }
      sectionLines.push(line);
    } else {
      // Content before the first diff section (e.g. commit preamble) — preserve.
      outputLines.push(line);
    }
  }

  // Flush the final section.
  flushSection();

  return {
    filtered: outputLines.join('\n'),
    excludedFiles,
    remainingCount,
  };
}

// ---------------------------------------------------------------------------
// I/O wrapper (used by the CLI entry point)
// ---------------------------------------------------------------------------

/**
 * Read a diff from `diffPath`, filter it using the given exclude-paths string,
 * and write the result back in-place.
 *
 * When all sections are excluded the file is **deleted** (not left empty) so
 * that `hashFiles('pr.diff')` in GitHub Actions returns `''` and downstream
 * steps guarded by `if: hashFiles('pr.diff') != ''` are skipped automatically.
 *
 * All progress messages are written to stderr so they appear in the Actions log.
 *
 * @param diffPath       Absolute or relative path to the diff file.
 * @param excludePathsStr Newline-separated exclude-path patterns (plain prefixes or globs).
 */
export function applyFilter(diffPath: string, excludePathsStr: string): void {
  const prefixes = parseExcludePrefixes(excludePathsStr);

  for (const p of prefixes) {
    const lastSegment = p.split('/').at(-1) ?? p;
    if (!/[*?[]/.test(p) && !lastSegment.includes('.')) {
      process.stderr.write(
        `⚠️  exclude-paths entry "${p}" looks like a bare directory name — did you mean "${p}/"? Without a trailing slash only an exact path match is performed.\n`,
      );
    }
  }

  if (prefixes.length === 0) {
    process.stderr.write('ℹ️  No valid patterns in exclude-paths — skipping filter\n');
    return;
  }

  process.stderr.write(`🔍 Filtering diff against ${prefixes.length} excluded pattern(s):\n`);
  for (const p of prefixes) {
    process.stderr.write(`   - ${p}\n`);
  }

  const diffContent = readFileSync(diffPath, 'utf-8');
  const result = filterDiff(diffContent, prefixes);

  for (const file of result.excludedFiles) {
    process.stderr.write(`⏭️ Excluded from review: ${file}\n`);
  }

  process.stderr.write(
    `✅ Filtered diff: ${result.excludedFiles.length} files excluded,` +
      ` ${result.remainingCount} files remaining\n`,
  );

  if (result.remainingCount === 0) {
    if (existsSync(diffPath)) rmSync(diffPath);
    process.stderr.write(
      'ℹ️  All files excluded — removed pr.diff so downstream diff steps are skipped\n',
    );
  } else {
    writeFileSync(diffPath, result.filtered, 'utf-8');
  }
}
