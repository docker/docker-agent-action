// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * fix-reviewer-cache-permission — core logic for upgrading `actions: read`
 * to `actions: write` in consumer workflow files that call the PR-review
 * reusable workflow (`docker/docker-agent-action/.github/workflows/review-pr.yml`).
 *
 * The reusable workflow saves caches (review lock, memory, binary cache) on
 * behalf of the caller, and cache writes fail with `actions: read`. The fix
 * is a single-value flip in the `permissions` block of the CALLING job —
 * `actions: write` implicitly includes read, so artifact/cache downloads
 * keep working.
 *
 * Deliberately not YAML-parser based: consumer files must be preserved
 * byte-for-byte apart from the one flipped value (indentation, comments,
 * quoting, key order, CRLF). A parse/re-serialize round-trip cannot
 * guarantee that. Instead, a small indentation-based scanner locates:
 *
 *   1. the top-level `jobs:` mapping (column-0 content is always a top-level
 *      key — block-scalar content must be indented past its parent key, so a
 *      `jobs:` line inside a `run: |` script cannot sit at column 0);
 *   2. each job block under it (content lines at the job-key indentation);
 *   3. jobs whose direct `uses:` property references the reusable workflow
 *      at any ref (SHA, tag, branch), optionally quoted or commented;
 *   4. that job's direct `permissions:` property — block mapping or
 *      single-line flow mapping (`permissions: { ... }`).
 *
 * Only `actions: read` entries inside a matched job's permissions block are
 * rewritten. Top-level `permissions:` blocks, other jobs, step-level `uses:`
 * lines, and `with:` inputs are never touched. Files without a matching job
 * are left unchanged. Running twice is a no-op (idempotent).
 *
 * Out of scope for the safe flip (left unchanged), but never conflated with
 * already-compliant jobs: each is reported via FixResult.manualJobs and
 * surfaced by applyFix as manualFiles so callers can route it to a human:
 *   - calling jobs with no `permissions:` block, a non-mapping value
 *     (`read-all`, `write-all`), or a block without an `actions:` entry —
 *     remediating those requires inserting keys, which is a different
 *     (more invasive) edit;
 *   - `actions: none` — an explicit opt-out that should not be overridden
 *     silently;
 *   - multi-line flow mappings (`permissions: {` spanning several lines) —
 *     the scanner only recognises single-line flow mappings.
 * A file is fully compliant only when every reviewer-calling job either
 * already had `actions: write` or was just flipped; a file mixing a flipped
 * job with a manual one is reported as BOTH changed and needing manual work.
 *
 * Pure functions plus a thin I/O wrapper (applyFix) used by the CLI in
 * index.ts — mirroring the migrate-consumer-refs module layout.
 */
import { readFileSync, writeFileSync } from 'node:fs';

export const REVIEWER_WORKFLOW_PATH = 'docker/docker-agent-action/.github/workflows/review-pr.yml';

/**
 * Escape a string for use inside a RegExp.
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A job-level `uses:` line calling the reviewer reusable workflow at any ref,
 * with optional quotes and trailing comment. The path must start immediately
 * after the optional quote, so a local self-reference
 * (`./.github/workflows/review-pr.yml`), another repo's copy, or the old
 * `docker/cagent-action` slug never match. Step-level `- uses:` lines are
 * excluded by the missing dash (and by the direct-property indentation check
 * in the scanner).
 */
const USES_RE = new RegExp(
  `^\\s*uses:\\s*["']?${escapeRegExp(REVIEWER_WORKFLOW_PATH)}@[^\\s"'#]+["']?\\s*(?:#.*)?$`,
);

/** `permissions:` job property introducing a block mapping (entries on following lines). */
const PERMISSIONS_BLOCK_RE = /^\s*permissions:\s*(?:#.*)?$/;

/** `permissions: { ... }` job property with a single-line flow mapping. */
const PERMISSIONS_FLOW_RE = /^\s*permissions:\s*\{.*\}\s*(?:#.*)?$/;

/**
 * Block-style `actions: read` entry. Everything except the value — leading
 * indentation, optional quotes, trailing spacing and comment — is captured
 * and preserved verbatim.
 */
const ACTIONS_READ_ENTRY_RE = /^(\s*actions:\s*["']?)read(["']?\s*(?:#.*)?)$/;

/** `actions: read` inside a single-line flow mapping, bounded by `{`/`,` and `,`/`}`. */
const ACTIONS_READ_FLOW_RE = /([{,]\s*actions:\s*["']?)read(["']?\s*[,}])/;

/** Block-style `actions: write` entry — the job is already compliant. */
const ACTIONS_WRITE_ENTRY_RE = /^\s*actions:\s*["']?write["']?\s*(?:#.*)?$/;

/** `actions: write` inside a single-line flow mapping — the job is already compliant. */
const ACTIONS_WRITE_FLOW_RE = /[{,]\s*actions:\s*["']?write["']?\s*[,}]/;

export interface FixResult {
  /** Rewritten file content. Identical to input when nothing was replaced. */
  content: string;
  /** True when at least one `actions: read` was flipped to `actions: write`. */
  changed: boolean;
  /** True when the file contains a job calling the reviewer reusable workflow. */
  hasReviewerJob: boolean;
  /** Count of `actions: read` entries flipped to `actions: write`. */
  replacedCount: number;
  /**
   * Keys of reviewer-calling jobs the safe flip cannot make compliant: no
   * `permissions:` block, a non-mapping value (`read-all`, `write-all`), no
   * `actions:` entry, `actions: none`, or an unsupported YAML form (e.g. a
   * multi-line flow mapping). Empty when every reviewer-calling job has (or
   * now has) `actions: write`.
   */
  manualJobs: string[];
}

function indentOf(text: string): number {
  let i = 0;
  while (i < text.length && text[i] === ' ') i++;
  return i;
}

function isContent(text: string): boolean {
  const t = text.trim();
  return t !== '' && !t.startsWith('#');
}

/** Extract the job key from its mapping line (`  review: # x` → `review`). */
function jobKeyOf(text: string): string {
  const trimmed = text.trim();
  const colon = trimmed.indexOf(':');
  return colon === -1 ? trimmed : trimmed.slice(0, colon).trim();
}

/**
 * Rewrite `actions: read` → `actions: write` in the permissions block of
 * every job calling the reviewer reusable workflow.
 */
export function fixReviewerCachePermission(content: string): FixResult {
  const unchanged: FixResult = {
    content,
    changed: false,
    hasReviewerJob: false,
    replacedCount: 0,
    manualJobs: [],
  };

  const rawLines = content.split('\n');
  // Tolerate CRLF: strip a trailing \r for matching, re-append on reassembly.
  const crFlags = rawLines.map((raw) => raw.endsWith('\r'));
  const texts = rawLines.map((raw, i) => (crFlags[i] ? raw.slice(0, -1) : raw));

  const jobsIdx = texts.findIndex((t) => /^jobs:\s*(?:#.*)?$/.test(t));
  if (jobsIdx === -1) return unchanged;

  // The jobs section ends at the next top-level key (content at column 0),
  // so a top-level `permissions:` block before or after it is out of reach.
  let jobsEnd = texts.length;
  for (let i = jobsIdx + 1; i < texts.length; i++) {
    if (isContent(texts[i]) && indentOf(texts[i]) === 0) {
      jobsEnd = i;
      break;
    }
  }

  // Job keys sit at the indentation of the first content line in the section
  // (YAML requires sibling mapping keys to share their indentation).
  let jobIndent = -1;
  for (let i = jobsIdx + 1; i < jobsEnd; i++) {
    if (isContent(texts[i])) {
      jobIndent = indentOf(texts[i]);
      break;
    }
  }
  if (jobIndent === -1) return unchanged; // empty jobs section

  const jobStarts: number[] = [];
  for (let i = jobsIdx + 1; i < jobsEnd; i++) {
    if (isContent(texts[i]) && indentOf(texts[i]) === jobIndent) jobStarts.push(i);
  }

  const out = [...texts];
  let hasReviewerJob = false;
  let replacedCount = 0;
  const manualJobs: string[] = [];

  for (let j = 0; j < jobStarts.length; j++) {
    const start = jobStarts[j];
    const end = j + 1 < jobStarts.length ? jobStarts[j + 1] : jobsEnd;

    // Direct properties of the job share the indentation of the first
    // content line inside the block; deeper lines belong to sub-blocks
    // (steps, with, secrets, ...) and are never scanned as properties.
    let propIndent = -1;
    for (let i = start + 1; i < end; i++) {
      if (isContent(texts[i])) {
        propIndent = indentOf(texts[i]);
        break;
      }
    }
    if (propIndent <= jobIndent) continue; // empty or malformed job block

    let usesFound = false;
    let permLine = -1;
    let permFlow = false;
    for (let i = start + 1; i < end; i++) {
      if (!isContent(texts[i]) || indentOf(texts[i]) !== propIndent) continue;
      if (USES_RE.test(texts[i])) {
        usesFound = true;
      } else if (PERMISSIONS_FLOW_RE.test(texts[i])) {
        permLine = i;
        permFlow = true;
      } else if (PERMISSIONS_BLOCK_RE.test(texts[i])) {
        permLine = i;
        permFlow = false;
      }
    }

    if (!usesFound) continue;
    hasReviewerJob = true;
    const jobKey = jobKeyOf(texts[start]);
    if (permLine === -1) {
      // No permissions block, a non-mapping value (read-all/write-all), or an
      // unsupported form such as a multi-line flow mapping — inserting or
      // rewriting keys there is out of scope, so the job needs a manual fix.
      manualJobs.push(jobKey);
      continue;
    }

    if (permFlow) {
      const replaced = out[permLine].replace(ACTIONS_READ_FLOW_RE, '$1write$2');
      if (replaced !== out[permLine]) {
        out[permLine] = replaced;
        replacedCount++;
      } else if (!ACTIONS_WRITE_FLOW_RE.test(out[permLine])) {
        manualJobs.push(jobKey); // no actions entry, or a value like none
      }
      continue;
    }

    // Block mapping: entries run until the next content line at or above the
    // property indentation. Blank and comment lines inside do not end it.
    let jobReplaced = false;
    let hasWrite = false;
    for (let i = permLine + 1; i < end; i++) {
      if (isContent(texts[i]) && indentOf(texts[i]) <= propIndent) break;
      const replaced = out[i].replace(ACTIONS_READ_ENTRY_RE, '$1write$2');
      if (replaced !== out[i]) {
        out[i] = replaced;
        replacedCount++;
        jobReplaced = true;
      } else if (ACTIONS_WRITE_ENTRY_RE.test(out[i])) {
        hasWrite = true;
      }
    }
    if (!jobReplaced && !hasWrite) {
      manualJobs.push(jobKey); // no actions entry, or actions: none
    }
  }

  if (replacedCount === 0) {
    return { content, changed: false, hasReviewerJob, replacedCount: 0, manualJobs };
  }

  const result = out.map((t, i) => (crFlags[i] ? `${t}\r` : t)).join('\n');
  return {
    content: result,
    changed: result !== content,
    hasReviewerJob,
    replacedCount,
    manualJobs,
  };
}

// ---------------------------------------------------------------------------
// I/O wrapper (used by the CLI entry point)
// ---------------------------------------------------------------------------

export interface ApplyFixResult {
  /** Files that were rewritten on disk (in input order). */
  changedFiles: string[];
  /** Files whose reviewer-calling jobs ALL already have `actions: write`. */
  compliantFiles: string[];
  /**
   * Files with at least one reviewer-calling job the safe flip cannot make
   * compliant (see FixResult.manualJobs). Overlaps with changedFiles when a
   * file mixes a flipped job with a non-fixable one — such a file is still
   * not fully compliant after the rewrite.
   */
  manualFiles: string[];
  /** Files without any job calling the reviewer workflow — never modified. */
  skippedFiles: string[];
  /** Per-file failures (read/write errors). Files in this list were NOT partially written. */
  errors: Array<{ file: string; message: string }>;
}

/**
 * Apply fixReviewerCachePermission to each file in-place.
 *
 * The buckets are NOT mutually exclusive: a file mixing a flipped job with a
 * non-fixable one lands in both changedFiles and manualFiles, so the safe
 * flips are applied while the file is still flagged as unfinished.
 * compliantFiles is reserved for files whose reviewer-calling jobs all
 * already have `actions: write` — never conflated with manualFiles.
 *
 * Per-file errors (unreadable file, write failure) are collected instead of
 * aborting the loop, so a single bad file cannot leave the caller with a
 * silently truncated "changed files" list. Callers MUST treat a non-empty
 * `errors` array as a failure (the CLI exits 1) — this prevents the
 * fix-reviewer-cache-permissions workflow from committing a partial fix.
 *
 * Progress messages are written to stderr.
 */
export function applyFix(files: string[]): ApplyFixResult {
  const result: ApplyFixResult = {
    changedFiles: [],
    compliantFiles: [],
    manualFiles: [],
    skippedFiles: [],
    errors: [],
  };

  for (const file of files) {
    try {
      const before = readFileSync(file, 'utf-8');
      const fix = fixReviewerCachePermission(before);
      if (fix.changed) {
        writeFileSync(file, fix.content, 'utf-8');
        result.changedFiles.push(file);
        process.stderr.write(`✅ ${file}: ${fix.replacedCount} actions: read → write\n`);
      }
      if (fix.manualJobs.length > 0) {
        result.manualFiles.push(file);
        process.stderr.write(
          `⚠️  ${file}: job(s) the safe flip cannot fix — needs manual review: ${fix.manualJobs.join(', ')}\n`,
        );
      } else if (!fix.changed) {
        if (fix.hasReviewerJob) {
          result.compliantFiles.push(file);
          process.stderr.write(
            `ℹ️  ${file}: every reviewer-calling job already has actions: write\n`,
          );
        } else {
          result.skippedFiles.push(file);
          process.stderr.write(`ℹ️  ${file}: no job calls the reviewer workflow — skipped\n`);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push({ file, message });
      process.stderr.write(`⚠️  ${file}: ${message}\n`);
    }
  }

  return result;
}

/**
 * Render an ApplyFixResult as the CLI's machine-readable stdout contract:
 * one `<status> <path>` line per file, statuses `changed`, `needs-manual`,
 * `compliant`, `skipped`. A file appears under BOTH `changed` and
 * `needs-manual` when it mixes a flipped job with a non-fixable one —
 * consumers must treat any `needs-manual` line as "this file is not fully
 * fixed" regardless of the `changed` lines.
 *
 * The fix-reviewer-cache-permissions workflow greps these prefixes; do not
 * rename them without updating it.
 */
export function statusLines(result: ApplyFixResult): string[] {
  return [
    ...result.changedFiles.map((f) => `changed ${f}`),
    ...result.manualFiles.map((f) => `needs-manual ${f}`),
    ...result.compliantFiles.map((f) => `compliant ${f}`),
    ...result.skippedFiles.map((f) => `skipped ${f}`),
  ];
}
