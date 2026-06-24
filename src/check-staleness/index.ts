// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * check-staleness — detect when a PR was force-pushed / rebased between the
 * moment a review was requested and the moment it actually runs.
 *
 * Review requests capture the head SHA at trigger time (e.g. pr_head_sha.txt in
 * the trigger artifact, or github.event.pull_request.head.sha on the direct
 * path), but every review checks out refs/pull/N/head, which always resolves to
 * the *current* head. If the branch was force-pushed in between, the review
 * silently runs against a different commit than the one requested, and the
 * posted review / check run end up pinned to a SHA nobody asked to review.
 *
 * This module re-fetches the current head SHA and compares it to the requested
 * SHA so the workflow can record the SHA actually reviewed and post a notice
 * when the two diverge. The review proceeds against current head (the freshest
 * commit is what should be reviewed) — the safeguard is detection + an honest
 * record, not blocking.
 *
 * Exported:
 *   checkStaleness(token, opts) → StalenessResult
 *
 * CLI (invoked via dist/check-staleness.js): inputs from environment variables:
 *   GITHUB_TOKEN / GH_TOKEN   Token with pull-request read scope
 *   GITHUB_REPOSITORY         "owner/repo"
 *   STALE_PR_NUMBER           PR number
 *   STALE_REQUESTED_SHA       Head SHA captured when the review was requested
 * Outputs (via @actions/core.setOutput):
 *   stale ("true"|"false"), current-sha, requested-sha
 */
import * as core from '@actions/core';
import { Octokit } from '@octokit/rest';

export interface StalenessOptions {
  owner: string;
  repo: string;
  prNumber: number;
  /** Head SHA captured when the review was requested ("" when unknown). */
  requestedSha: string;
}

export interface StalenessResult {
  requestedSha: string;
  currentSha: string;
  /** True only when both SHAs are known and differ. */
  stale: boolean;
}

/**
 * Fetch the current PR head SHA and compare it to `requestedSha`. When the
 * requested SHA is empty/unknown, staleness cannot be determined and `stale` is
 * false (fail-open: never block on missing data).
 */
export async function checkStaleness(
  token: string,
  opts: StalenessOptions,
): Promise<StalenessResult> {
  const octokit = new Octokit({ auth: token });
  const { data: pr } = await octokit.rest.pulls.get({
    owner: opts.owner,
    repo: opts.repo,
    pull_number: opts.prNumber,
  });
  const currentSha = pr.head?.sha ?? '';
  const requestedSha = opts.requestedSha.trim();
  const stale = requestedSha !== '' && currentSha !== '' && requestedSha !== currentSha;
  return { requestedSha, currentSha, stale };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '';
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  const prNumber = Number.parseInt(process.env.STALE_PR_NUMBER ?? '', 10);
  const requestedSha = process.env.STALE_REQUESTED_SHA ?? '';

  if (!token || !Number.isInteger(prNumber) || prNumber <= 0) {
    core.warning('check-staleness: missing token or PR number — skipping (fail-open)');
    core.setOutput('stale', 'false');
    return;
  }

  const slashIdx = repository.indexOf('/');
  if (slashIdx < 0) {
    core.warning(`check-staleness: invalid GITHUB_REPOSITORY '${repository}' — skipping`);
    core.setOutput('stale', 'false');
    return;
  }
  const owner = repository.slice(0, slashIdx);
  const repo = repository.slice(slashIdx + 1);

  try {
    const result = await checkStaleness(token, { owner, repo, prNumber, requestedSha });
    core.setOutput('stale', String(result.stale));
    core.setOutput('current-sha', result.currentSha);
    core.setOutput('requested-sha', result.requestedSha);

    if (result.stale) {
      core.notice(
        `PR #${prNumber} was updated after the review was requested: requested ` +
          `${result.requestedSha.slice(0, 8)}, now reviewing ${result.currentSha.slice(0, 8)}. ` +
          `The review will run against the latest commit.`,
        { title: 'Force-push detected — reviewing latest commit' },
      );
    } else {
      core.info(`✅ PR #${prNumber} head is current (${result.currentSha.slice(0, 8)})`);
    }
  } catch (err: unknown) {
    core.warning(
      `check-staleness failed (fail-open): ${err instanceof Error ? err.message : String(err)}`,
    );
    core.setOutput('stale', 'false');
  }
}

if (process.argv[1]?.endsWith('check-staleness.js') && !process.env.VITEST) {
  main().catch((err: unknown) => {
    core.warning(`check-staleness failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}
