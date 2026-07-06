// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * dedupe-findings CLI entrypoint.
 *
 * Usage:
 *   node dist/dedupe-findings.js <newCommentsJsonPath> <existingCommentsJsonPath>
 *
 *   newCommentsJsonPath       Path to the inline-comments JSON array the agent
 *                             built (e.g. /tmp/review_comments.json). Read and,
 *                             when duplicates are found, overwritten in-place.
 *   existingCommentsJsonPath  Path to the JSON array of the PR's existing
 *                             review comments (as returned by
 *                             GET /pulls/{n}/comments, pre-fetched by the
 *                             workflow to /tmp/existing_review_comments.json).
 *
 * Behavior is fail-open so it can never block a legitimate review:
 *   - missing CLI args                       → exit 1 (usage error);
 *   - new-comments file absent/unparseable   → warn, exit 0, no change;
 *   - existing file absent/unparseable       → warn, exit 0, no change
 *     (nothing to dedupe against — post everything);
 *   - otherwise                              → drop only duplicates, exit 0.
 *
 * All progress is written to stderr so it surfaces in the Actions log without
 * polluting any captured stdout.
 *
 * See dedupe-findings.ts for the pure matching logic.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dedupeComments, type ExistingComment, type NewComment } from './dedupe-findings.js';

const [, , newCommentsPath, existingCommentsPath] = process.argv;

if (!newCommentsPath || !existingCommentsPath) {
  process.stderr.write('Usage: dedupe-findings <newCommentsJsonPath> <existingCommentsJsonPath>\n');
  process.exit(1);
}

function warn(message: string): void {
  process.stderr.write(`${message}\n`);
}

function readJsonArray(path: string, label: string): unknown[] | null {
  // Read directly and handle failure in the catch rather than guarding with
  // existsSync first (avoids a check-then-use file-system race).
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (!Array.isArray(parsed)) {
      warn(`⚠️  ${path} is not a JSON array — skipping ${label}`);
      return null;
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      warn(`⚠️  No ${label} file at ${path} — skipping deduplication`);
    } else {
      warn(
        `⚠️  Could not read ${path} (${err instanceof Error ? err.message : String(err)}) — skipping deduplication`,
      );
    }
    return null;
  }
}

const newComments = readJsonArray(newCommentsPath, 'new comments');
if (newComments === null) process.exit(0);

const existingComments = readJsonArray(existingCommentsPath, 'existing comments');
if (existingComments === null) process.exit(0);

const result = dedupeComments(newComments as NewComment[], existingComments as ExistingComment[]);

for (const drop of result.dropped) {
  warn(
    `⏭️ Dropped duplicate finding on ${drop.path}:${drop.line} ` +
      `(matches existing comment at line ${drop.matchedLine}: "${drop.signature}")`,
  );
}

if (result.dropped.length > 0) {
  writeFileSync(newCommentsPath, `${JSON.stringify(result.kept, null, 2)}\n`, 'utf-8');
  warn(
    `✅ Deduplication: kept ${result.kept.length}, ` +
      `dropped ${result.dropped.length} duplicate(s) (rewrote ${newCommentsPath})`,
  );
} else {
  warn(`✅ Deduplication: kept ${result.kept.length}, dropped 0 (no changes)`);
}
