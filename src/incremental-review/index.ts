// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * incremental-review CLI entrypoint.
 *
 * Usage:
 *   node dist/incremental-review.js <diffPath>
 *
 *   diffPath  Path to the pre-fetched full PR diff (e.g. pr.diff). When an
 *             incremental review is possible the file is overwritten with the
 *             incremental diff and the original is preserved next to it as
 *             pr_full.diff (derived: `<name>_full.diff`) for anchor validation
 *             and stale-thread resolution.
 *
 * Environment:
 *   GITHUB_TOKEN / GH_TOKEN  Token with pull-request read scope
 *   GITHUB_REPOSITORY        "owner/repo"
 *   PR_NUMBER                Pull request number
 *   BASE_REF                 PR base branch name (e.g. "main")
 *   INCREMENTAL              "true" (default) enables incremental review;
 *                            "false" forces a full review
 *   REVIEW_BOT_LOGIN         Bot login whose reviews mark commits as reviewed
 *                            (default "docker-agent")
 *
 * Outputs (via @actions/core.setOutput):
 *   mode                "incremental" | "full"
 *   reason              "ok" for incremental, otherwise the fallback reason
 *   last-reviewed-sha   SHA of the last completed review ("" when none)
 *
 * Fail-open: every error path leaves the diff untouched and reports mode=full —
 * a full review is always correct, incremental is only an optimization.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '@actions/core';
import { Octokit } from '@octokit/rest';
import {
  findLastReviewedSha,
  type GitResult,
  type GitRunner,
  listDiffFiles,
  planIncrementalReview,
  type ReviewLike,
  restrictDiffToFiles,
} from './incremental-review.js';

export function runGit(args: string[]): GitResult {
  const res = spawnSync('git', args, { encoding: 'utf-8' });
  return { ok: res.status === 0, stdout: res.stdout ?? '' };
}

function setOutputs(mode: string, reason: string, lastReviewedSha: string | null): void {
  core.setOutput('mode', mode);
  core.setOutput('reason', reason);
  core.setOutput('last-reviewed-sha', lastReviewedSha ?? '');
}

/** Derive the preserved-full-diff path: "pr.diff" → "pr_full.diff". */
export function fullDiffPath(diffPath: string): string {
  return diffPath.endsWith('.diff')
    ? `${diffPath.slice(0, -'.diff'.length)}_full.diff`
    : `${diffPath}_full`;
}

async function fetchReviews(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<ReviewLike[]> {
  const octokit = new Octokit({ auth: token });
  return (await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  })) as ReviewLike[];
}

export interface MainDeps {
  git?: GitRunner;
  fetchReviews?: typeof fetchReviews;
}

export async function main(diffPath: string, deps: MainDeps = {}): Promise<void> {
  const git = deps.git ?? runGit;
  const fetch = deps.fetchReviews ?? fetchReviews;

  const enabled = (process.env.INCREMENTAL ?? 'true').trim().toLowerCase() !== 'false';
  if (!enabled) {
    core.info('ℹ️  Incremental review disabled via input — running a full review');
    setOutputs('full', 'disabled', null);
    return;
  }

  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '';
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  const prNumber = Number.parseInt(process.env.PR_NUMBER ?? '', 10);
  const baseRef = (process.env.BASE_REF ?? '').trim();
  const botLogin = process.env.REVIEW_BOT_LOGIN?.trim() || 'docker-agent';

  const slashIdx = repository.indexOf('/');
  if (!token || slashIdx < 0 || !Number.isInteger(prNumber) || prNumber <= 0) {
    core.warning(
      'incremental-review: missing token, repository, or PR number — falling back to full review',
    );
    setOutputs('full', 'error', null);
    return;
  }
  const owner = repository.slice(0, slashIdx);
  const repo = repository.slice(slashIdx + 1);

  let fullDiff: string;
  try {
    fullDiff = readFileSync(diffPath, 'utf-8');
  } catch {
    core.warning(`incremental-review: cannot read ${diffPath} — falling back to full review`);
    setOutputs('full', 'no-diff', null);
    return;
  }

  let lastReviewedSha: string | null;
  try {
    lastReviewedSha = findLastReviewedSha(await fetch(token, owner, repo, prNumber), botLogin);
  } catch (err: unknown) {
    core.warning(
      `incremental-review: failed to list reviews (${err instanceof Error ? err.message : String(err)}) — falling back to full review`,
    );
    setOutputs('full', 'error', null);
    return;
  }

  const plan = planIncrementalReview({ lastReviewedSha, baseRef, git });
  if (plan.mode === 'full') {
    core.info(`ℹ️  Full review: ${plan.reason}`);
    setOutputs('full', plan.reason, plan.lastReviewedSha);
    return;
  }

  // planIncrementalReview guarantees lastReviewedSha is a valid ancestor SHA here.
  const sha = plan.lastReviewedSha as string;
  const outPath = join(tmpdir(), `incremental-${process.pid}.diff`);
  try {
    if (!git(['diff', sha, 'HEAD', `--output=${outPath}`]).ok) {
      core.warning('incremental-review: git diff failed — falling back to full review');
      setOutputs('full', 'error', sha);
      return;
    }

    const incrementalDiff = readFileSync(outPath, 'utf-8');
    const result = restrictDiffToFiles(incrementalDiff, listDiffFiles(fullDiff));

    for (const dropped of result.droppedFiles) {
      core.info(`⏭️ Dropped from incremental diff (net-zero vs base): ${dropped}`);
    }

    if (result.keptFiles === 0) {
      // Changes since the last review cancel out against the base — a full
      // review still covers the PR correctly, so fall back rather than hand
      // the agent an empty diff.
      core.info('ℹ️  Incremental diff is empty after restriction — running a full review');
      setOutputs('full', 'net-zero-changes', sha);
      return;
    }

    const preservedPath = fullDiffPath(diffPath);
    copyFileSync(diffPath, preservedPath);
    writeFileSync(diffPath, result.restricted, 'utf-8');

    const fullLines = fullDiff.split('\n').length;
    const incLines = result.restricted.split('\n').length;
    core.info(
      `✅ Incremental review: diffing ${sha.slice(0, 12)}..HEAD ` +
        `(${incLines} lines vs ${fullLines} full, ${result.keptFiles} files; ` +
        `full diff preserved at ${preservedPath})`,
    );
    setOutputs('incremental', 'ok', sha);
  } catch (err: unknown) {
    core.warning(
      `incremental-review failed (${err instanceof Error ? err.message : String(err)}) — falling back to full review`,
    );
    setOutputs('full', 'error', sha);
  } finally {
    rmSync(outPath, { force: true });
  }
}

if (process.argv[1]?.endsWith('incremental-review.js') && !process.env.VITEST) {
  const [, , diffPath] = process.argv;
  if (!diffPath) {
    process.stderr.write('Usage: incremental-review <diffPath>\n');
    process.exit(1);
  }
  main(diffPath).catch((err: unknown) => {
    // Last-resort fail-open: report a full review rather than failing the step.
    core.warning(`incremental-review failed: ${err instanceof Error ? err.message : String(err)}`);
    core.setOutput('mode', 'full');
    core.setOutput('reason', 'error');
    core.setOutput('last-reviewed-sha', '');
  });
}
