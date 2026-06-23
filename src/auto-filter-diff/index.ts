// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * auto-filter-diff CLI entrypoint.
 *
 * Usage:
 *   node dist/auto-filter-diff.js <diffPath> [maxDiffLines]
 *
 *   diffPath      Path to the diff file (read and overwritten in-place).
 *   maxDiffLines  Progressive line cap (default 3000; set to 0 to disable).
 *
 * Reads /tmp/file_risk_scores.json (written by the score-risk step), calls
 * autoFilterDiff, and writes the filtered diff back to diffPath.
 *
 * When all file sections are excluded the file is deleted (not left empty)
 * so that hashFiles('pr.diff') returns '' and downstream steps guarded by
 * `if: hashFiles('pr.diff') != ''` are skipped automatically.
 *
 * All progress messages are written to stderr so they appear in the Actions log.
 *
 * See auto-filter-diff.ts for the pure filtering logic.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { autoFilterDiff } from './auto-filter-diff.js';

const SCORES_PATH = '/tmp/file_risk_scores.json';

const [, , diffPath, maxDiffLinesArg] = process.argv;

if (!diffPath) {
  process.stderr.write('Usage: auto-filter-diff <diffPath> [maxDiffLines]\n');
  process.exit(1);
}

const maxDiffLines = (() => {
  const parsed = parseInt(maxDiffLinesArg ?? '3000', 10);
  return Number.isNaN(parsed) ? 3000 : parsed;
})();

try {
  if (!existsSync(SCORES_PATH)) {
    process.stderr.write(`⚠️  No risk scores found at ${SCORES_PATH} — skipping auto-filter\n`);
    process.exit(0);
  }

  const diffContent = readFileSync(diffPath, 'utf-8');
  const riskScores: Record<string, number> = JSON.parse(readFileSync(SCORES_PATH, 'utf-8'));

  const result = autoFilterDiff(diffContent, riskScores, maxDiffLines);

  for (const path of result.autoExcludedFiles) {
    process.stderr.write(`⏭️ Auto-excluded (score 0): ${path}\n`);
  }

  if (result.allFilesKept) {
    process.stderr.write(
      'ℹ️  All files scored 0 — keeping all files for review (Phase 2 cap still applies)\n',
    );
  }

  for (const path of result.progressivelyExcludedFiles) {
    const score = riskScores[path] ?? 'unknown';
    process.stderr.write(`⏭️ Progressive cap (score ${score}): ${path}\n`);
  }

  const totalExcluded = result.autoExcludedFiles.length + result.progressivelyExcludedFiles.length;
  const removedLines = result.originalLines - result.remainingLines;
  process.stderr.write(
    `✅ Auto-filter complete: ${totalExcluded} files excluded (${removedLines} lines removed),` +
      ` ${result.remainingFiles} files / ${result.remainingLines} lines remaining\n`,
  );

  if (result.remainingFiles === 0) {
    if (existsSync(diffPath)) rmSync(diffPath);
    process.stderr.write(
      'ℹ️  All files excluded — removed pr.diff so downstream diff steps are skipped\n',
    );
  } else {
    writeFileSync(diffPath, result.filtered, 'utf-8');
  }
} catch (err) {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
