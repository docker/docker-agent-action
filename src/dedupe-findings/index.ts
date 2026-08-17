// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * dedupe-findings CLI entrypoint.
 *
 * Usage:
 *   node dist/dedupe-findings.js <newCommentsJsonPath> <existingCommentsJsonPath> [priorThreadsJsonPath]
 *
 *   newCommentsJsonPath       Path to the inline-comments JSON array the agent
 *                             built (e.g. /tmp/review_comments.json). Read and,
 *                             when duplicates are found, overwritten in-place.
 *   existingCommentsJsonPath  Path to the JSON array of the PR's existing
 *                             review comments (as returned by
 *                             GET /pulls/{n}/comments, pre-fetched by the
 *                             workflow to /tmp/existing_review_comments.json).
 *                             The path is required but the file is optional
 *                             context: absent or malformed it is treated as
 *                             an empty list so valid thread history can
 *                             still suppress duplicates.
 *   priorThreadsJsonPath      Optional path to the JSON array of the PR's
 *                             review threads (GraphQL `reviewThreads` nodes
 *                             carrying path, line, originalLine, isResolved,
 *                             isOutdated and comments.nodes). When present,
 *                             explicitly current (`isOutdated: false`) bot
 *                             threads — resolved or unresolved — also suppress
 *                             re-derived findings, including paraphrases
 *                             sharing multiple code anchors and meaningful
 *                             heading overlap; outdated threads never
 *                             suppress, so those findings are reassessed
 *                             against the new code, and a reassessed finding
 *                             returning at a HIGHER severity than its outdated
 *                             thread is flagged on stderr (never blocked) so
 *                             the escalation can be audited for changed-code
 *                             evidence.
 *
 * Behavior is fail-open so it can never block a legitimate review:
 *   - missing required CLI args              → exit 1 (usage error);
 *   - new-comments file absent/unparseable   → warn, exit 0, no change;
 *   - existing file absent/unparseable       → warn, continue with an empty
 *     REST list (valid thread history still suppresses duplicates);
 *   - prior-threads file absent/unparseable  → warn, continue with the
 *     REST-comment dedupe only (the third argument is optional history);
 *   - both dedupe sources unavailable        → nothing to match against,
 *     every finding is kept;
 *   - otherwise                              → drop only duplicates, exit 0.
 *
 * All progress is written to stderr so it surfaces in the Actions log without
 * polluting any captured stdout.
 *
 * See dedupe-findings.ts for the pure matching logic.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  dedupeComments,
  type ExistingComment,
  type NewComment,
  type PriorReviewThread,
} from './dedupe-findings.js';

type Warn = (message: string) => void;

const defaultWarn: Warn = (message) => {
  process.stderr.write(`${message}\n`);
};

function readJsonArray(
  path: string,
  label: string,
  consequence: string,
  warn: Warn,
): unknown[] | null {
  // Read directly and handle failure in the catch rather than guarding with
  // existsSync first (avoids a check-then-use file-system race).
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (!Array.isArray(parsed)) {
      warn(`⚠️  ${path} is not a JSON array — ${consequence}`);
      return null;
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      warn(`⚠️  No ${label} file at ${path} — ${consequence}`);
    } else {
      warn(
        `⚠️  Could not read ${path} (${err instanceof Error ? err.message : String(err)}) — ${consequence}`,
      );
    }
    return null;
  }
}

/**
 * The CLI body: takes the positional arguments (process.argv minus the node
 * and script entries) and returns the exit code. Extracted so tests can drive
 * the full file-level behavior without spawning a process; `warn` is
 * injectable for output assertions and defaults to stderr.
 */
export function run(args: string[], warn: Warn = defaultWarn): number {
  const [newCommentsPath, existingCommentsPath, priorThreadsPath] = args;

  if (!newCommentsPath || !existingCommentsPath) {
    warn(
      'Usage: dedupe-findings <newCommentsJsonPath> <existingCommentsJsonPath> [priorThreadsJsonPath]',
    );
    return 1;
  }

  const newComments = readJsonArray(
    newCommentsPath,
    'new comments',
    'skipping deduplication',
    warn,
  );
  if (newComments === null) return 0;

  // The two dedupe sources are independently optional: a missing or malformed
  // REST file must not disable valid thread history, and vice versa. With
  // neither source available nothing can match, so every finding is kept.
  const existingComments =
    readJsonArray(
      existingCommentsPath,
      'existing comments',
      'continuing without existing comments',
      warn,
    ) ?? [];

  // The thread-history file is optional context: when it is absent or malformed
  // the REST-comment deduplication above still runs unchanged.
  let priorThreads: PriorReviewThread[] | undefined;
  if (priorThreadsPath) {
    const parsed = readJsonArray(
      priorThreadsPath,
      'prior review threads',
      'continuing without thread history',
      warn,
    );
    if (parsed !== null) priorThreads = parsed as PriorReviewThread[];
  }

  const result = dedupeComments(
    newComments as NewComment[],
    existingComments as ExistingComment[],
    { priorThreads },
  );

  for (const drop of result.dropped) {
    const matched = drop.source === 'prior-thread' ? 'prior review thread' : 'existing comment';
    const how = drop.matchedBy === 'anchors' ? ' via shared code anchors' : '';
    warn(
      `⏭️ Dropped duplicate finding on ${drop.path}:${drop.line} ` +
        `(matches ${matched} at line ${drop.matchedLine}${how}: "${drop.signature}")`,
    );
  }

  // Deterministic severity-escalation audit (never blocks): reassessing an
  // outdated thread may legitimately escalate only with changed-code
  // evidence, which this CLI cannot judge — surface the pair for the review
  // policy to justify.
  for (const escalation of result.escalations) {
    warn(
      `⚠️ Severity escalation on ${escalation.path}:${escalation.line}: ` +
        `[${escalation.newSeverity}] vs [${escalation.priorSeverity}] on the outdated prior thread ` +
        `at line ${escalation.matchedLine} ("${escalation.signature}"). Kept for reassessment — ` +
        `the comment must cite changed-code evidence justifying the higher severity.`,
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
  return 0;
}

if (process.argv[1]?.endsWith('dedupe-findings.js') && !process.env.VITEST) {
  process.exit(run(process.argv.slice(2)));
}
