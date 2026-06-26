// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * rate-limit — detect (and let the workflow prevent) abnormally frequent review
 * activity on a single pull request.
 *
 * The existing per-PR cache lock (review-pr/action.yml) only stops *concurrent*
 * reviews and only on the review path; an authorized account can still drive the
 * bot at high frequency (each request costs an LLM run). This module adds a
 * frequency check: it counts how many docker-agent review/reply outputs landed
 * on the PR within a recent time window and flags the request as a rate anomaly
 * when that count crosses a threshold. The workflow gates the expensive review
 * step on the result, so a burst is throttled rather than run N times.
 *
 * Counting is per LLM run, so each run contributes exactly one unit:
 *   - Reviews are posted via the Reviews API (POST /pulls/{n}/reviews) with no
 *     inline marker — a findings review, a zero-finding APPROVE, and the
 *     timeout/error/LGTM fallbacks all land there. They are counted from
 *     `pulls.listReviews` by bot author (a real review run always carries an
 *     assessment/status body); the inline finding comments such a review carries
 *     are deliberately not counted, since that would be N units per single run.
 *   - Replies are posted as issue comments or inline review-comment replies,
 *     each carrying a `-reply` marker, and are counted from the comment
 *     endpoints (one marker per reply run).
 * Both signals are observable with the repo-scoped token already present and
 * together measure how hard the bot is being driven on that PR.
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

// Reply markers identify the bot's conversational replies — one per reply LLM
// run — posted as issue comments or inline review-comment replies. Full reviews
// carry no marker on the review body and are counted separately (see
// detectRateAnomaly), so the review/finding markers are intentionally absent
// here: counting them would double-count a review run that already shows up via
// the Reviews API. The legacy cagent-* marker keeps older reply threads
// countable during migration.
const REPLY_MARKERS = ['<!-- docker-agent-review-reply -->', '<!-- cagent-review-reply -->'];

// GitHub presents the bot identity as "docker-agent" when posting with a machine
// user token, or "docker-agent[bot]" through a GitHub App installation token.
// Match both so the count is correct regardless of which token posted.
function matchesBotLogin(login: string | null | undefined, botLogin: string): boolean {
  return login === botLogin || login === `${botLogin}[bot]`;
}

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

interface ReviewLike {
  user?: { login?: string } | null;
  body?: string | null;
  submitted_at?: string | null;
}

function isAgentReplyComment(c: CommentLike, botLogin: string, windowStartMs: number): boolean {
  if (!matchesBotLogin(c.user?.login, botLogin)) return false;
  const body = c.body ?? '';
  if (!REPLY_MARKERS.some((m) => body.includes(m))) return false;
  if (!c.created_at) return false;
  const created = Date.parse(c.created_at);
  return Number.isFinite(created) && created >= windowStartMs;
}

function isAgentReview(r: ReviewLike, botLogin: string, windowStartMs: number): boolean {
  if (!matchesBotLogin(r.user?.login, botLogin)) return false;
  // A real review run always carries an assessment/status body ("### Assessment:
  // …", or a timeout/error/LGTM fallback). Standalone inline comments and replies
  // surface in this endpoint as empty-body review entries; skipping them keeps
  // each review run counted exactly once and avoids double-counting an inline
  // reply (already counted via its reply marker on the comment endpoints).
  if (!r.body || r.body.trim().length === 0) return false;
  if (!r.submitted_at) return false;
  const submitted = Date.parse(r.submitted_at);
  return Number.isFinite(submitted) && submitted >= windowStartMs;
}

/**
 * Count docker-agent review/reply outputs on `prNumber` within the last
 * `windowSeconds` — full reviews (via the Reviews API) plus conversational
 * replies (issue comments and inline review-comment replies) — and decide
 * whether the count constitutes a rate anomaly.
 */
export async function detectRateAnomaly(
  token: string,
  opts: RateAnomalyOptions,
): Promise<RateAnomalyResult> {
  if (!Number.isFinite(opts.windowSeconds) || opts.windowSeconds <= 0) {
    throw new RangeError(
      `windowSeconds must be a positive finite number, got ${opts.windowSeconds}`,
    );
  }
  if (!Number.isFinite(opts.threshold) || opts.threshold <= 0) {
    throw new RangeError(`threshold must be a positive integer, got ${opts.threshold}`);
  }

  const octokit = new Octokit({ auth: token });
  const now = opts.nowMs ?? Date.now();
  const windowStartMs = now - opts.windowSeconds * 1000;
  const since = new Date(windowStartMs).toISOString();

  // `since` filters the comment endpoints server-side by updated_at; the
  // per-comment created_at check below enforces the precise window. All three
  // fetches run in parallel to cut wall-clock time.
  const [issueComments, reviewComments, reviews] = await Promise.all([
    octokit.paginate(octokit.rest.issues.listComments, {
      owner: opts.owner,
      repo: opts.repo,
      issue_number: opts.prNumber,
      since,
      per_page: 100,
    }) as Promise<CommentLike[]>,
    octokit.paginate(octokit.rest.pulls.listReviewComments, {
      owner: opts.owner,
      repo: opts.repo,
      pull_number: opts.prNumber,
      since,
      per_page: 100,
    }) as Promise<CommentLike[]>,
    // The Reviews API has no `since` parameter. Use paginate.iterator and stop
    // early once the entire page predates the window (GitHub returns reviews
    // oldest-first), avoiding unbounded API calls on heavily-reviewed PRs.
    (async (): Promise<ReviewLike[]> => {
      const acc: ReviewLike[] = [];
      for await (const page of octokit.paginate.iterator(octokit.rest.pulls.listReviews, {
        owner: opts.owner,
        repo: opts.repo,
        pull_number: opts.prNumber,
        per_page: 100,
      })) {
        acc.push(...(page.data as ReviewLike[]));
        const allBeforeWindow = page.data.every((r) => {
          const submittedAt = (r as ReviewLike).submitted_at;
          return !submittedAt || Date.parse(submittedAt) < windowStartMs;
        });
        if (allBeforeWindow) break;
      }
      return acc;
    })(),
  ]);

  const replyCount = [...issueComments, ...reviewComments].filter((c) =>
    isAgentReplyComment(c, opts.botLogin, windowStartMs),
  ).length;
  const reviewCount = reviews.filter((r) => isAgentReview(r, opts.botLogin, windowStartMs)).length;
  const count = replyCount + reviewCount;

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

export async function main(): Promise<void> {
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
    core.setOutput('window', String(windowSeconds));
    core.setOutput('threshold', String(threshold));
    return;
  }

  const slashIdx = repository.indexOf('/');
  if (slashIdx < 0) {
    core.warning(`rate-limit: invalid GITHUB_REPOSITORY '${repository}' — skipping (fail-open)`);
    core.setOutput('anomalous', 'false');
    core.setOutput('count', '0');
    core.setOutput('window', String(windowSeconds));
    core.setOutput('threshold', String(threshold));
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
        `Rate anomaly on PR #${prNumber}: ${result.count} agent reviews/replies in the ` +
          `last ${windowSeconds}s (threshold ${threshold}). Throttling this request.`,
      );
    } else {
      core.info(
        `✅ Rate OK on PR #${prNumber}: ${result.count}/${threshold} agent reviews/replies in ${windowSeconds}s`,
      );
    }
  } catch (err: unknown) {
    // Fail open on API errors — never let the rate check itself break reviews.
    core.warning(
      `rate-limit check failed (fail-open): ${err instanceof Error ? err.message : String(err)}`,
    );
    core.setOutput('anomalous', 'false');
    core.setOutput('count', '0');
    core.setOutput('window', String(windowSeconds));
    core.setOutput('threshold', String(threshold));
  }
}

if (process.argv[1]?.endsWith('rate-limit.js') && !process.env.VITEST) {
  main().catch((err: unknown) => {
    core.warning(`rate-limit failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}
