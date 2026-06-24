// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * audit-log — emit a structured audit record for every review request.
 *
 * This is an abuse safeguard: GitHub Actions run logs are not a reliable audit
 * store (short retention, no query/export, deletable by repo admins), so each
 * review request — on every trigger path and crucially on every *denial* path —
 * is recorded as a single correlated record that joins the fields needed to
 * investigate abuse after the fact: who triggered it, when, via which trigger,
 * on which PR/SHA, and what the authorization decision was.
 *
 * Each invocation emits the record three ways:
 *   1. core.notice  — a queryable workflow annotation (survives in the run UI
 *                     and via the GitHub API even when raw logs are gone)
 *   2. job summary  — a human-readable line appended to $GITHUB_STEP_SUMMARY
 *   3. JSONL file   — an append-only line the workflow uploads as a
 *                     long-retention artifact for durable, machine-readable audit
 *
 * CLI (invoked as a shell run step via dist/audit-log.js):
 *   All inputs are read from environment variables:
 *     AUDIT_TRIGGER       Trigger type (e.g. "review_requested", "mention", "automatic")
 *     AUDIT_ACTOR         Login of the user who triggered the request
 *     AUDIT_DECISION      "authorized" | "denied" | "skipped" | "throttled" | "stale"
 *     AUDIT_REASON        Free-text reason for the decision (optional)
 *     AUDIT_PR_NUMBER     PR number (optional)
 *     AUDIT_HEAD_SHA      Reviewed head SHA (optional)
 *     AUDIT_REQUESTED_SHA SHA the review was requested for, if different (optional)
 *     AUDIT_EVENT         GitHub event name (optional; defaults to GITHUB_EVENT_NAME)
 *     AUDIT_TIMESTAMP     ISO-8601 timestamp (optional; defaults to now)
 *     REVIEW_AUDIT_FILE   Path for the JSONL audit file (optional; defaults to
 *                         $RUNNER_TEMP/review-audit.jsonl, else /tmp/review-audit.jsonl)
 *     GITHUB_REPOSITORY   "owner/repo" (standard GitHub Actions env var)
 *     GITHUB_RUN_ID       Run id (standard GitHub Actions env var)
 *     GITHUB_SERVER_URL   Server url (standard GitHub Actions env var)
 *
 * Guard: the CLI entry point only executes when process.argv[1] ends with
 * "audit-log.js" and VITEST is not set, so importing this module as a library
 * never triggers a write.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as core from '@actions/core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Authorization / handling outcome recorded for a review request. */
export type AuditDecision = 'authorized' | 'denied' | 'skipped' | 'throttled' | 'stale';

const VALID_DECISIONS: readonly AuditDecision[] = [
  'authorized',
  'denied',
  'skipped',
  'throttled',
  'stale',
];

export interface ReviewAuditRecord {
  /** ISO-8601 timestamp of when the request was processed. */
  timestamp: string;
  /** GitHub event name (e.g. "pull_request", "issue_comment"). */
  event: string;
  /** Logical trigger type (e.g. "review_requested", "mention", "automatic"). */
  trigger: string;
  /** Login of the user who triggered the request ("unknown" when unresolved). */
  actor: string;
  /** "owner/repo". */
  repository: string;
  /** PR number, or empty string when not applicable. */
  prNumber: string;
  /** Reviewed head SHA, or empty string. */
  headSha: string;
  /** SHA the review was requested for, when it differs from headSha. */
  requestedSha: string;
  /** Authorization / handling outcome. */
  decision: AuditDecision;
  /** Human-readable reason for the decision. */
  reason: string;
  /** Workflow run id. */
  runId: string;
  /** Direct URL to the workflow run, when derivable. */
  runUrl: string;
}

// ---------------------------------------------------------------------------
// Pure builder
// ---------------------------------------------------------------------------

/**
 * Build a {@link ReviewAuditRecord} from environment variables. Pure: performs
 * no I/O. Unknown/empty fields fall back to safe defaults so a partially-wired
 * caller still produces a usable record rather than throwing.
 */
export function buildAuditRecord(env: NodeJS.ProcessEnv): ReviewAuditRecord {
  const repository = env.GITHUB_REPOSITORY ?? '';
  const runId = env.GITHUB_RUN_ID ?? '';
  const serverUrl = env.GITHUB_SERVER_URL ?? 'https://github.com';

  const decisionRaw = (env.AUDIT_DECISION ?? '').trim() as AuditDecision;
  const decision: AuditDecision = VALID_DECISIONS.includes(decisionRaw) ? decisionRaw : 'skipped';

  return {
    timestamp: env.AUDIT_TIMESTAMP?.trim() || new Date().toISOString(),
    event: (env.AUDIT_EVENT ?? env.GITHUB_EVENT_NAME ?? '').trim(),
    trigger: (env.AUDIT_TRIGGER ?? '').trim() || 'unknown',
    actor: (env.AUDIT_ACTOR ?? '').trim() || 'unknown',
    repository,
    prNumber: (env.AUDIT_PR_NUMBER ?? '').trim(),
    headSha: (env.AUDIT_HEAD_SHA ?? '').trim(),
    requestedSha: (env.AUDIT_REQUESTED_SHA ?? '').trim(),
    decision,
    reason: (env.AUDIT_REASON ?? '').trim(),
    runId,
    runUrl: repository && runId ? `${serverUrl}/${repository}/actions/runs/${runId}` : '',
  };
}

// ---------------------------------------------------------------------------
// Formatters (pure)
// ---------------------------------------------------------------------------

/** Single-line annotation message. The `[review-request-audit]` prefix makes
 *  records greppable in logs and filterable via the annotations API. */
export function formatNotice(record: ReviewAuditRecord): string {
  return `[review-request-audit] ${JSON.stringify(record)}`;
}

/** One markdown bullet for the job summary. SHAs are short-formed for brevity. */
export function formatSummaryLine(record: ReviewAuditRecord): string {
  const sha = record.headSha ? ` \`${record.headSha.slice(0, 8)}\`` : '';
  const pr = record.prNumber ? ` PR #${record.prNumber}` : '';
  const reason = record.reason ? ` — ${record.reason}` : '';
  return `- \`${record.timestamp}\` **${record.decision}** ${record.trigger} by @${record.actor}${pr}${sha}${reason}`;
}

/** Resolve the JSONL audit file path, honoring REVIEW_AUDIT_FILE then RUNNER_TEMP. */
export function resolveAuditFilePath(env: NodeJS.ProcessEnv): string {
  if (env.REVIEW_AUDIT_FILE?.trim()) return env.REVIEW_AUDIT_FILE.trim();
  const base = env.RUNNER_TEMP?.trim() || '/tmp';
  return `${base}/review-audit.jsonl`;
}

// ---------------------------------------------------------------------------
// Emitter (side effects)
// ---------------------------------------------------------------------------

export interface EmitOptions {
  /** Path to append the JSONL record to. */
  auditFilePath: string;
}

/**
 * Emit the record as a notice + job-summary line + JSONL append. Persisting the
 * record is best-effort: a failed file append must never block a review, so it
 * downgrades to a warning rather than throwing.
 */
export function emitAuditRecord(record: ReviewAuditRecord, opts: EmitOptions): void {
  core.notice(formatNotice(record), { title: 'Review request audit' });
  core.summary.addRaw(`${formatSummaryLine(record)}\n`, false);

  try {
    mkdirSync(dirname(opts.auditFilePath), { recursive: true });
    appendFileSync(opts.auditFilePath, `${JSON.stringify(record)}\n`);
  } catch (err: unknown) {
    core.warning(
      `Failed to persist audit record to ${opts.auditFilePath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const record = buildAuditRecord(process.env);
  emitAuditRecord(record, { auditFilePath: resolveAuditFilePath(process.env) });
  // Surface the chosen path so the workflow can upload it as an artifact.
  core.setOutput('audit-file', resolveAuditFilePath(process.env));
  await core.summary.write();
}

// Guard: only run as CLI when invoked directly as dist/audit-log.js.
if (process.argv[1]?.endsWith('audit-log.js') && !process.env.VITEST) {
  main().catch((err: unknown) => {
    // Audit logging must never fail a review; warn and exit 0.
    core.warning(`audit-log failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}
