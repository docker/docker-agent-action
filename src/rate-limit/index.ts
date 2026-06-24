// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * rate-limit — detect (and let the workflow prevent) abnormally frequent review
 * activity on a single pull request.
 *
 * The existing per-PR cache lock (review-pr/action.yml) only stops *concurrent*
 * reviews and only on the review path; an authorized account can still drive the
 * bot at high frequency (each request costs an LLM run). This module adds a
 * frequency check: it counts how many docker-agent review/reply comments were
 * posted on the PR within a recent time window and flags the request as a rate
 * anomaly when that count crosses a threshold. The workflow gates the expensive
 * review step on the result, so a burst is throttled rather than run N times.
 *
 * Counting the bot's own marker comments (rather than raw triggers) is the
 * signal that is reliably observable with the repo-scoped token already present,
 * and it directly measures how hard the bot is being driven on that PR.
 *
 * Exported:
 *   detectRateAnomaly(token, opts) → RateAnomalyResult
 *
 * CLI (invoked via dist/rate-limit.js): inputs from environment variables:
 *   GITHUB_TOKEN / GH_TOKEN   Token with pull-request read scope
 *   GITHUB_REPOSITORY         "owner/repo"
 *   RATE_PR_NUMBER            PR number
 *   RATE_WINDOW_SECONDS       Sliding window in seconds (default 600)
 *   RATE_MAX_REQUESTS         Anomaly threshold (default 8)
 *   RATE_BOT_LOGIN            Bot login whose comments are counted (default "docker-agent")
 * Outputs (via @actions/core.setOutput): anomalous ("true"|"false"), count, window, threshold.
 */
import * as core from '@actions/core';
import { Octokit } from '@octokit/rest';

// Review markers also matched by review-pr.yml / review-pr/action.yml. Counting
// any of these captures both full reviews and conversational replies, and the
// legacy cagent-* markers keep older threads countable during migration.
const REVIEW_MARKERS = [
  '<!-- docker-agent-review -->',
  '<!-- docker-agent-review-reply -->',
  '<!-- cagent-review -->',
  '<!-- cagent-review-reply -->',
];

export interface RateAnomalyOptions {
  owner: string;
  repo: string;
  prNumber: number;
  /** Sliding window in seconds. */
  windowSeconds: number;
  /** Inclusive count at/above which the request is flagged anomalous. */
  threshold: number;
  /** Login whose review/reply comments are counted. */
  botLogin: string;
  /** Reference "now" in epoch ms (injectable for deterministic tests). */
  nowMs?: number;
}

export interface RateAnomalyResult {
  count: number;
  anomalous: boolean;
  windowSeconds: number;
  threshold: number;
}

interface CommentLike {
  user?: { login?: string } | null;
  body?: string | null;
  created_at?: string;
}

function isAgentReviewComment(c: CommentLike, botLogin: string, windowStartMs: number): boolean {
  if (c.user?.login !== botLogin) return false;
  const body = c.body ?? '';
  if (!REVIEW_MARKERS.some((m) => body.includes(m))) return false;
  if (!c.created_at) return false;
  const created = Date.parse(c.created_at);
  return Number.isFinite(created) && created >= windowStartMs;
}

/**
 * Count docker-agent review/reply comments on `prNumber` created within the last
 * `windowSeconds`, across both issue comments and inline review comments, and
 * decide whether the count constitutes a rate anomaly.
 */
export async function detectRateAnomaly(
  token: string,
  opts: RateAnomalyOptions,
): Promise<RateAnomalyResult> {
  const octokit = new Octokit({ auth: token });
  const now = opts.nowMs ?? Date.now();
  const windowStartMs = now - opts.windowSeconds * 1000;
  const since = new Date(windowStartMs).toISOString();

  // `since` filters server-side by updated_at; the per-comment created_at check
  // below enforces the precise creation window. paginate() handles busy PRs.
  const issueComments: CommentLike[] = await octokit.paginate(octokit.rest.issues.listComments, {
    owner: opts.owner,
    repo: opts.repo,
    issue_number: opts.prNumber,
    since,
    per_page: 100,
  });
  const reviewComments: CommentLike[] = await octokit.paginate(
    octokit.rest.pulls.listReviewComments,
    {
      owner: opts.owner,
      repo: opts.repo,
      pull_number: opts.prNumber,
      since,
      per_page: 100,
    },
  );

  const count = [...issueComments, ...reviewComments].filter((c) =>
    isAgentReviewComment(c, opts.botLogin, windowStartMs),
  ).length;

  return {
    count,
    anomalous: count >= opts.threshold,
    windowSeconds: opts.windowSeconds,
    threshold: opts.threshold,
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

async function main(): Promise<void> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '';
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  const prNumber = Number.parseInt(process.env.RATE_PR_NUMBER ?? '', 10);
  const windowSeconds = parsePositiveInt(process.env.RATE_WINDOW_SECONDS, 600);
  const threshold = parsePositiveInt(process.env.RATE_MAX_REQUESTS, 8);
  const botLogin = process.env.RATE_BOT_LOGIN?.trim() || 'docker-agent';

  // Fail open: a missing token or unparseable PR number must not block reviews.
  if (!token || !Number.isInteger(prNumber) || prNumber <= 0) {
    core.warning('rate-limit: missing token or PR number — skipping rate check (fail-open)');
    core.setOutput('anomalous', 'false');
    core.setOutput('count', '0');
    return;
  }

  const slashIdx = repository.indexOf('/');
  if (slashIdx < 0) {
    core.warning(`rate-limit: invalid GITHUB_REPOSITORY '${repository}' — skipping (fail-open)`);
    core.setOutput('anomalous', 'false');
    core.setOutput('count', '0');
    return;
  }
  const owner = repository.slice(0, slashIdx);
  const repo = repository.slice(slashIdx + 1);

  try {
    const result = await detectRateAnomaly(token, {
      owner,
      repo,
      prNumber,
      windowSeconds,
      threshold,
      botLogin,
    });
    core.setOutput('anomalous', String(result.anomalous));
    core.setOutput('count', String(result.count));
    core.setOutput('window', String(result.windowSeconds));
    core.setOutput('threshold', String(result.threshold));

    if (result.anomalous) {
      core.warning(
        `Rate anomaly on PR #${prNumber}: ${result.count} agent review/reply comments in the ` +
          `last ${windowSeconds}s (threshold ${threshold}). Throttling this request.`,
      );
    } else {
      core.info(
        `✅ Rate OK on PR #${prNumber}: ${result.count}/${threshold} agent comments in ${windowSeconds}s`,
      );
    }
  } catch (err: unknown) {
    // Fail open on API errors — never let the rate check itself break reviews.
    core.warning(
      `rate-limit check failed (fail-open): ${err instanceof Error ? err.message : String(err)}`,
    );
    core.setOutput('anomalous', 'false');
    core.setOutput('count', '0');
  }
}

if (process.argv[1]?.endsWith('rate-limit.js') && !process.env.VITEST) {
  main().catch((err: unknown) => {
    core.warning(`rate-limit failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}
