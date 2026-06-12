// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for src/auto-filter-diff.
 *
 * Tests cover both phases of the auto-filter logic:
 *   Phase 1 — auto-exclude score-0 files
 *   Phase 2 — progressive cap (lowest-risk files removed first)
 *
 * Plus edge cases: empty diff, all excluded, unknown files, disabled cap.
 */
import { describe, expect, it } from 'vitest';
import { autoFilterDiff } from '../auto-filter-diff.js';

// ── Fixture helpers ───────────────────────────────────────────────────────────

/**
 * Build a minimal but structurally valid diff section for `filePath`.
 *
 * The resulting string ends with '\n' so that concatenated sections assemble
 * correctly (each section's trailing newline becomes the separator before the
 * next 'diff --git' header).
 *
 * `extraAddedLines` controls how many '+' lines are included — used by
 * progressive-cap tests that need predictable section sizes.
 */
function makeDiff(filePath: string, extraAddedLines = 5): string {
  return [
    `diff --git a/${filePath} b/${filePath}`,
    'index abc..def 100644',
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    '@@ -1,1 +1,2 @@',
    ' existing',
    ...Array.from({ length: extraAddedLines }, (_, i) => `+line${i}`),
    '',
  ].join('\n');
}

// ═════════════════════════════════════════════════════════════════════════════
// Phase 1 — auto-exclude score-0 files
// ═════════════════════════════════════════════════════════════════════════════

describe('autoFilterDiff — phase 1: auto-exclude score-0 files', () => {
  it('removes score-0 files from the filtered diff', () => {
    const diff = makeDiff('src/gen.pb.go') + makeDiff('src/auth/handler.go');
    const riskScores = { 'src/gen.pb.go': 0, 'src/auth/handler.go': 2 };
    const result = autoFilterDiff(diff, riskScores, 0);

    expect(result.autoExcludedFiles).toEqual(['src/gen.pb.go']);
    expect(result.filtered).not.toContain('src/gen.pb.go');
    expect(result.filtered).toContain('src/auth/handler.go');
    expect(result.remainingFiles).toBe(1);
  });

  it('keeps score > 0 files in the filtered diff', () => {
    const diff = makeDiff('src/auth/handler.go');
    const riskScores = { 'src/auth/handler.go': 2 };
    const result = autoFilterDiff(diff, riskScores, 0);

    expect(result.autoExcludedFiles).toHaveLength(0);
    expect(result.filtered).toContain('src/auth/handler.go');
    expect(result.remainingFiles).toBe(1);
  });

  it('removes multiple score-0 files in a single pass', () => {
    const diff =
      makeDiff('backend/gen/foo.pb.go') +
      makeDiff('backend/gen/bar.pb.go') +
      makeDiff('src/auth/handler.go');
    const riskScores = {
      'backend/gen/foo.pb.go': 0,
      'backend/gen/bar.pb.go': 0,
      'src/auth/handler.go': 3,
    };
    const result = autoFilterDiff(diff, riskScores, 0);

    expect(result.autoExcludedFiles).toHaveLength(2);
    expect(result.autoExcludedFiles).toContain('backend/gen/foo.pb.go');
    expect(result.autoExcludedFiles).toContain('backend/gen/bar.pb.go');
    expect(result.remainingFiles).toBe(1);
  });

  it('keeps files not present in riskScores (unknown = needs review)', () => {
    const diff = makeDiff('src/unknown.go');
    // riskScores intentionally empty — file is unknown
    const result = autoFilterDiff(diff, {}, 0);

    expect(result.autoExcludedFiles).toHaveLength(0);
    expect(result.filtered).toContain('src/unknown.go');
    expect(result.remainingFiles).toBe(1);
  });

  it('preserves unknown files even when other files are score-0', () => {
    const diff = makeDiff('src/gen.pb.go') + makeDiff('src/unlisted.go');
    const riskScores = { 'src/gen.pb.go': 0 };
    // 'src/unlisted.go' not in riskScores → kept
    const result = autoFilterDiff(diff, riskScores, 0);

    expect(result.autoExcludedFiles).toEqual(['src/gen.pb.go']);
    expect(result.filtered).toContain('src/unlisted.go');
    expect(result.remainingFiles).toBe(1);
  });

  it('all files excluded returns empty string', () => {
    const diff = makeDiff('src/a.go') + makeDiff('src/b.go');
    const riskScores = { 'src/a.go': 0, 'src/b.go': 0 };
    const result = autoFilterDiff(diff, riskScores, 0);

    expect(result.filtered).toBe('');
    expect(result.remainingFiles).toBe(0);
    expect(result.autoExcludedFiles).toHaveLength(2);
  });

  it('reports correct originalLines', () => {
    const diff = makeDiff('src/a.go') + makeDiff('src/b.go');
    const riskScores = { 'src/a.go': 0 };
    const result = autoFilterDiff(diff, riskScores, 0);

    // originalLines must be > 0 and equal to the line count of the full diff
    expect(result.originalLines).toBeGreaterThan(0);
    expect(result.originalLines).toBe(diff.split('\n').length);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Phase 2 — progressive cap
// ═════════════════════════════════════════════════════════════════════════════

describe('autoFilterDiff — phase 2: progressive cap', () => {
  it('removes lowest-score file first when diff exceeds maxDiffLines', () => {
    // Two large sections; make the cap smaller than their combined line count
    // but larger than the higher-risk section alone.
    const highRisk = makeDiff('src/auth/handler.go', 80); // score 3, ~87 lines
    const lowRisk = makeDiff('src/utils/helper.go', 80); // score 1, ~87 lines
    const diff = highRisk + lowRisk;
    // Combined: ~174 lines. Cap: 100 → lowRisk should be removed (87 lines gone → ~87 remain < 100).
    const riskScores = { 'src/auth/handler.go': 3, 'src/utils/helper.go': 1 };

    const result = autoFilterDiff(diff, riskScores, 100);

    expect(result.progressivelyExcludedFiles).toContain('src/utils/helper.go');
    expect(result.progressivelyExcludedFiles).not.toContain('src/auth/handler.go');
    expect(result.filtered).toContain('src/auth/handler.go');
    expect(result.filtered).not.toContain('src/utils/helper.go');
  });

  it('keeps at least 1 file even when all are low-score and cap is tiny', () => {
    const diff = makeDiff('src/a.go', 50) + makeDiff('src/b.go', 50) + makeDiff('src/c.go', 50);
    const riskScores = { 'src/a.go': 1, 'src/b.go': 1, 'src/c.go': 1 };
    // Cap of 1 line — far below any single section; should still keep exactly 1 file.
    const result = autoFilterDiff(diff, riskScores, 1);

    expect(result.remainingFiles).toBeGreaterThanOrEqual(1);
  });

  it('is disabled when maxDiffLines is 0', () => {
    const diff = makeDiff('src/a.go', 80) + makeDiff('src/b.go', 80);
    const riskScores = { 'src/a.go': 1, 'src/b.go': 2 };

    const result = autoFilterDiff(diff, riskScores, 0);

    expect(result.progressivelyExcludedFiles).toHaveLength(0);
    expect(result.remainingFiles).toBe(2);
  });

  it('does not remove files when diff is already under maxDiffLines', () => {
    const diff = makeDiff('src/a.go', 5); // ~12 lines
    const riskScores = { 'src/a.go': 1 };

    const result = autoFilterDiff(diff, riskScores, 10000);

    expect(result.progressivelyExcludedFiles).toHaveLength(0);
    expect(result.remainingFiles).toBe(1);
  });

  it('removes files in ascending risk-score order (lowest first)', () => {
    const diff =
      makeDiff('src/low.go', 30) + // score 1
      makeDiff('src/mid.go', 30) + // score 2
      makeDiff('src/high.go', 30); // score 4
    // Combined: ~99 lines. Remove 1 to get under ~70.
    const riskScores = { 'src/low.go': 1, 'src/mid.go': 2, 'src/high.go': 4 };

    const result = autoFilterDiff(diff, riskScores, 70);

    // Should remove 'src/low.go' (lowest score) first
    expect(result.progressivelyExcludedFiles[0]).toBe('src/low.go');
  });

  it('treats unknown files (not in riskScores) as high-priority to keep', () => {
    const diff =
      makeDiff('src/scored.go', 50) + // score 1
      makeDiff('src/unknown.go', 50); // not in riskScores
    const riskScores = { 'src/scored.go': 1 };
    // Cap forces removal of one file — scored.go (score 1) should go before unknown
    const result = autoFilterDiff(diff, riskScores, 60);

    // scored.go should be removed, unknown.go kept (Infinity sort key)
    expect(result.progressivelyExcludedFiles).toContain('src/scored.go');
    expect(result.filtered).toContain('src/unknown.go');
  });

  it('keeps ALL unknown files even when multiple exist and diff exceeds cap', () => {
    // Three unknown files (not in riskScores) plus one scored file.
    // Phase 2 must never remove unknown files — only the scored one is a candidate.
    const diff =
      makeDiff('src/scored.go', 50) + // score 1 — the only removal candidate
      makeDiff('src/unknown1.go', 50) + // not in riskScores
      makeDiff('src/unknown2.go', 50) + // not in riskScores
      makeDiff('src/unknown3.go', 50); // not in riskScores
    const riskScores = { 'src/scored.go': 1 };
    // Combined is well over 100; cap set low enough to trigger phase 2.
    const result = autoFilterDiff(diff, riskScores, 100);

    // Only the scored file may be removed; all three unknown files must be kept.
    expect(result.progressivelyExcludedFiles).not.toContain('src/unknown1.go');
    expect(result.progressivelyExcludedFiles).not.toContain('src/unknown2.go');
    expect(result.progressivelyExcludedFiles).not.toContain('src/unknown3.go');
    expect(result.filtered).toContain('src/unknown1.go');
    expect(result.filtered).toContain('src/unknown2.go');
    expect(result.filtered).toContain('src/unknown3.go');
  });

  it('does not run phase 2 on a single-file diff (nothing to remove)', () => {
    const diff = makeDiff('src/single.go', 200); // over any cap
    const riskScores = { 'src/single.go': 1 };

    const result = autoFilterDiff(diff, riskScores, 1);

    expect(result.progressivelyExcludedFiles).toHaveLength(0);
    expect(result.remainingFiles).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Edge cases
// ═════════════════════════════════════════════════════════════════════════════

describe('autoFilterDiff — edge cases', () => {
  it('empty diff returns a clean zero result', () => {
    const result = autoFilterDiff('', {}, 3000);

    expect(result.filtered).toBe('');
    expect(result.autoExcludedFiles).toHaveLength(0);
    expect(result.progressivelyExcludedFiles).toHaveLength(0);
    expect(result.remainingFiles).toBe(0);
    expect(result.remainingLines).toBe(0);
    expect(result.originalLines).toBe(0);
  });

  it('diff with no matching risk scores is passed through unchanged', () => {
    const diff = makeDiff('src/a.go') + makeDiff('src/b.go');
    const result = autoFilterDiff(diff, {}, 0);

    expect(result.filtered).toBe(diff);
    expect(result.autoExcludedFiles).toHaveLength(0);
    expect(result.progressivelyExcludedFiles).toHaveLength(0);
    expect(result.remainingFiles).toBe(2);
  });

  it('remainingLines matches filtered diff line count', () => {
    const diff = makeDiff('src/gen.go') + makeDiff('src/auth/handler.go');
    const riskScores = { 'src/gen.go': 0, 'src/auth/handler.go': 2 };
    const result = autoFilterDiff(diff, riskScores, 0);

    expect(result.remainingLines).toBe(result.filtered.split('\n').length);
  });

  it('autoExcludedFiles and progressivelyExcludedFiles are empty when nothing removed', () => {
    const diff = makeDiff('src/auth/handler.go');
    const riskScores = { 'src/auth/handler.go': 2 };
    const result = autoFilterDiff(diff, riskScores, 10000);

    expect(result.autoExcludedFiles).toHaveLength(0);
    expect(result.progressivelyExcludedFiles).toHaveLength(0);
  });
});
