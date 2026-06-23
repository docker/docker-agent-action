// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * auto-filter-diff — automatically filters low-risk files from a PR diff.
 *
 * Two-phase approach:
 *
 *   Phase 1 — Auto-exclude score-0 files:
 *     Remove every file section whose path appears in `riskScores` with a value
 *     of 0.  Files NOT present in `riskScores` are kept (unknown = needs review).
 *     Exception: if Phase 1 would remove ALL files, keep all instead — a PR
 *     where every changed file is low-risk still deserves a review.
 *     Phase 2 still applies in that case, so timeout protection is preserved.
 *
 *   Phase 2 — Progressive cap (only when maxDiffLines > 0):
 *     If the remaining diff exceeds `maxDiffLines` after Phase 1, sort the kept
 *     files by risk score ascending (lowest risk first) and remove them one by
 *     one until the diff fits the cap.  At least one file is always kept.
 *
 * Pure functions — no filesystem access.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AutoFilterResult {
  /** Filtered diff content (empty string when all files are excluded). */
  filtered: string;
  /** Paths removed by Phase 1 (score === 0 in riskScores). */
  autoExcludedFiles: string[];
  /** Paths removed by Phase 2 (progressive cap). */
  progressivelyExcludedFiles: string[];
  /** Number of file sections remaining after both phases. */
  remainingFiles: number;
  /** Line count of the filtered diff (split by '\n'). */
  remainingLines: number;
  /** Line count of the original diff (split by '\n'). */
  originalLines: number;
  /**
   * True when Phase 1 would have excluded everything and was skipped.
   * The review will cover all files; Phase 2 (progressive cap) still applies.
   */
  allFilesKept: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface DiffSection {
  path: string;
  /** Raw lines of this section (no trailing newline within each element). */
  lines: string[];
}

/**
 * Extract the destination file path from a `diff --git a/… b/…` header line.
 * Uses indexOf(' b/') rather than a greedy regex to handle paths containing 'b/'.
 */
function extractFilePath(diffGitLine: string): string {
  const after = diffGitLine.slice('diff --git a/'.length);
  const sepIdx = after.indexOf(' b/');
  return sepIdx >= 0 ? after.slice(0, sepIdx) : after;
}

/**
 * Split a unified diff string into per-file sections.
 *
 * Each section owns the lines from its `diff --git` header up to (but not
 * including) the next `diff --git` header.  The last section also owns the
 * trailing empty element that results from a trailing newline in the diff.
 *
 * Lines that appear before the first `diff --git` header (rare preamble) are
 * returned separately so that the round-trip `assemble(parseSections(d))` is
 * lossless.
 */
function parseSections(diffContent: string): { preamble: string[]; sections: DiffSection[] } {
  const lines = diffContent.split('\n');
  const sections: DiffSection[] = [];
  const preamble: string[] = [];
  let startLine = -1;
  let currentPath = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      if (startLine >= 0) {
        sections.push({ path: currentPath, lines: lines.slice(startLine, i) });
      }
      currentPath = extractFilePath(line);
      startLine = i;
    } else if (startLine < 0) {
      preamble.push(line);
    }
  }

  if (startLine >= 0) {
    sections.push({ path: currentPath, lines: lines.slice(startLine) });
  }

  return { preamble, sections };
}

/**
 * Reassemble kept sections (plus the preamble) back into a diff string.
 * Returns empty string when no sections remain.
 */
function assembleFiltered(preamble: string[], sections: DiffSection[]): string {
  if (sections.length === 0 && preamble.length === 0) return '';
  const allLines: string[] = [...preamble];
  for (const s of sections) {
    allLines.push(...s.lines);
  }
  return allLines.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Filter a unified diff in two phases (see module docblock).
 *
 * @param diffContent  Raw unified diff text.
 * @param riskScores   Map of `{ filePath → score }` from the score-risk step.
 * @param maxDiffLines Progressive cap.  Pass 0 to disable Phase 2.
 */
export function autoFilterDiff(
  diffContent: string,
  riskScores: Record<string, number>,
  maxDiffLines: number,
): AutoFilterResult {
  if (!diffContent) {
    return {
      filtered: '',
      autoExcludedFiles: [],
      progressivelyExcludedFiles: [],
      remainingFiles: 0,
      remainingLines: 0,
      originalLines: 0,
      allFilesKept: false,
    };
  }

  const originalLines = diffContent.split('\n').length;
  const { preamble, sections } = parseSections(diffContent);

  // ── Phase 1: auto-exclude score-0 files ────────────────────────────────────
  const candidateExcluded: string[] = [];
  const afterPhase1 = sections.filter((section) => {
    if (section.path in riskScores && riskScores[section.path] === 0) {
      candidateExcluded.push(section.path);
      return false;
    }
    return true;
  });

  // If Phase 1 would remove every file, keep all files instead.
  // A PR where every changed file is low-risk still deserves a review — the
  // reviewer should see it rather than silently skipping the whole PR.
  // Phase 2 (progressive cap) still applies to bound review size.
  let allFilesKept = false;
  let autoExcludedFiles: string[];
  let keptSections: typeof sections;

  if (afterPhase1.length === 0 && sections.length > 0) {
    allFilesKept = true;
    autoExcludedFiles = []; // nothing actually excluded
    keptSections = sections; // keep everything
  } else {
    autoExcludedFiles = candidateExcluded;
    keptSections = afterPhase1;
  }

  // ── Phase 2: progressive cap ───────────────────────────────────────────────
  const progressivelyExcludedFiles: string[] = [];

  if (maxDiffLines > 0 && keptSections.length > 1) {
    let totalLines = keptSections.reduce((sum, s) => sum + s.lines.length, 0);

    if (totalLines > maxDiffLines) {
      // Sort ascending by risk score so lowest-risk files are removed first.
      // Files not in riskScores get Infinity — preserve them as long as possible.
      const sortedAsc = [...keptSections].sort((a, b) => {
        const sa = riskScores[a.path] !== undefined ? riskScores[a.path] : Infinity;
        const sb = riskScores[b.path] !== undefined ? riskScores[b.path] : Infinity;
        return sa - sb;
      });

      // slice(0, -1) protects the last file so at least one is always kept.
      // Additionally filter out unknown files (not in riskScores): they must
      // always be kept for review regardless of the progressive cap.
      const removable = sortedAsc.slice(0, -1).filter((s) => riskScores[s.path] !== undefined);

      for (const section of removable) {
        if (totalLines <= maxDiffLines) break;
        progressivelyExcludedFiles.push(section.path);
        totalLines -= section.lines.length;
        keptSections = keptSections.filter((s) => s.path !== section.path);
      }
    }
  }

  // ── Assemble result ────────────────────────────────────────────────────────
  const filtered = keptSections.length === 0 ? '' : assembleFiltered(preamble, keptSections);
  const remainingLines = keptSections.reduce((sum, s) => sum + s.lines.length, 0);

  return {
    filtered,
    autoExcludedFiles,
    progressivelyExcludedFiles,
    remainingFiles: keptSections.length,
    remainingLines,
    originalLines,
    allFilesKept,
  };
}
