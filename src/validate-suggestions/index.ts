// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * validate-suggestions CLI entrypoint.
 *
 * Usage:
 *   node dist/validate-suggestions.js <commentsJsonPath> <diffPath>
 *
 *   commentsJsonPath  Path to the inline-comments JSON array the agent built
 *                     (e.g. /tmp/review_comments.json). Read and, when any
 *                     suggestion block is malformed, overwritten in-place.
 *   diffPath          Path to the unified diff under review (e.g. pr.diff),
 *                     used to validate suggestion line ranges.
 *
 * Behavior is fail-open so it can never block a legitimate review:
 *   - missing CLI args            → exit 1 (usage error);
 *   - comments file absent/unreadable/unparseable → warn, exit 0, no change;
 *   - diff file absent/unreadable → strip ALL suggestion blocks (cannot verify
 *     ranges, so degrade to prose rather than risk a 422), exit 0;
 *   - otherwise                   → strip only malformed suggestions, exit 0.
 *
 * All progress is written to stderr so it surfaces in the Actions log without
 * polluting any captured stdout.
 *
 * See validate-suggestions.ts for the pure validation logic.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { type ReviewComment, sanitizeComments } from './validate-suggestions.js';

const [, , commentsPath, diffPath] = process.argv;

if (!commentsPath || !diffPath) {
  process.stderr.write('Usage: validate-suggestions <commentsJsonPath> <diffPath>\n');
  process.exit(1);
}

function warn(message: string): void {
  process.stderr.write(`${message}\n`);
}

// Read directly and handle failure in the catch rather than guarding with
// existsSync first: a check-then-use pair is a file-system race (CodeQL
// js/file-system-race). A missing file (ENOENT) is the "nothing to do" case;
// any other error means leave the file untouched.
let comments: ReviewComment[];
try {
  const parsed = JSON.parse(readFileSync(commentsPath, 'utf-8'));
  if (!Array.isArray(parsed)) {
    warn(`⚠️  ${commentsPath} is not a JSON array — leaving it unchanged`);
    process.exit(0);
  }
  comments = parsed;
} catch (err) {
  if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
    warn(`⚠️  No comments file at ${commentsPath} — nothing to validate`);
  } else {
    warn(
      `⚠️  Could not read ${commentsPath} (${err instanceof Error ? err.message : String(err)}) — leaving it unchanged`,
    );
  }
  process.exit(0);
}

let diff = '';
try {
  diff = readFileSync(diffPath, 'utf-8');
} catch (err) {
  // Same reasoning as above. A missing diff is expected (it triggers the
  // strip-all fail-safe below); only surface other read errors.
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
    warn(
      `⚠️  Could not read diff ${diffPath} (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}
if (!diff) {
  warn(
    `⚠️  No usable diff at ${diffPath} — cannot verify suggestion line ranges; ` +
      'stripping all suggestion blocks to avoid a malformed-suggestion 422',
  );
}

const result = sanitizeComments(comments, diff);

for (const issue of result.issues) {
  warn(`⚠️  Stripped suggestion on ${issue.path}:${issue.line} — ${issue.reason}`);
}

if (result.suggestionsStripped > 0) {
  writeFileSync(commentsPath, `${JSON.stringify(result.comments, null, 2)}\n`, 'utf-8');
  warn(
    `✅ Suggestion validation: kept ${result.suggestionsKept}, ` +
      `stripped ${result.suggestionsStripped} (rewrote ${commentsPath})`,
  );
} else {
  warn(`✅ Suggestion validation: kept ${result.suggestionsKept}, stripped 0 (no changes)`);
}
