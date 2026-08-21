// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Octokit } from '@octokit/rest';

export interface PrepareReviewInputs {
  repository: string;
  pullNumber: string;
  githubToken: string;
  workspace: string;
  headSha?: string;
  baseSha?: string;
}

export interface PreparedReview {
  headSha: string;
  baseSha: string;
  baseRef: string;
  title: string;
  body: string;
  author: string;
  changedFiles: number;
}

function requireSha(value: string, label: string): string {
  if (!/^[a-f0-9]{40}$/i.test(value)) throw new Error(`Invalid ${label}: '${value}'`);
  return value;
}

function parseRepository(value: string): [string, string] {
  const [owner, repo, ...extra] = value.split('/');
  if (!owner || !repo || extra.length) throw new Error(`Invalid repository: '${value}'`);
  return [owner, repo];
}

function requirePullNumber(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) <= 0)
    throw new Error(`Invalid pull request number: '${value}'`);
  return Number(value);
}

export const GIT_OUTPUT_MAX_BUFFER = 64 * 1024 * 1024;

function git(workspace: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd: workspace,
      encoding: 'utf8',
      maxBuffer: GIT_OUTPUT_MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new Error(`Git ${args.join(' ')} failed while preparing the immutable PR snapshot`, {
      cause: error,
    });
  }
}

function ensureObject(workspace: string, sha: string): void {
  try {
    git(workspace, ['cat-file', '-e', `${sha}^{commit}`]);
  } catch {
    try {
      git(workspace, ['fetch', '--no-tags', 'origin', sha]);
    } catch {
      throw new Error(
        `Selected commit ${sha} is unavailable. Use actions/checkout with fetch-depth: 0 or fetch that immutable SHA before invoking review-pr.`,
      );
    }
    git(workspace, ['cat-file', '-e', `${sha}^{commit}`]);
  }
}

export async function prepareReview(inputs: PrepareReviewInputs): Promise<PreparedReview> {
  const [owner, repo] = parseRepository(inputs.repository);
  const pullNumber = requirePullNumber(inputs.pullNumber);
  const hasHead = Boolean(inputs.headSha);
  const hasBase = Boolean(inputs.baseSha);
  if (hasHead !== hasBase) throw new Error('pr-head-sha and pr-base-sha must be provided together');
  const octokit = new Octokit({ auth: inputs.githubToken });
  const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber });
  const liveHead = requireSha(pr.head.sha, 'PR head SHA');
  const liveBase = requireSha(pr.base.sha, 'PR base SHA');
  const headSha = hasHead ? requireSha(inputs.headSha ?? '', 'pr-head-sha') : liveHead;
  const baseSha = hasBase ? requireSha(inputs.baseSha ?? '', 'pr-base-sha') : liveBase;

  ensureObject(inputs.workspace, baseSha);
  ensureObject(inputs.workspace, headSha);
  git(inputs.workspace, ['checkout', '--detach', headSha]);
  const diff = git(inputs.workspace, ['diff', '--binary', `${baseSha}...${headSha}`]);
  const changedFiles = git(inputs.workspace, ['diff', '--name-only', `${baseSha}...${headSha}`]);
  writeFileSync(join(inputs.workspace, 'pr.diff'), diff);
  writeFileSync(join(inputs.workspace, 'changed_files.txt'), changedFiles);
  writeFileSync(
    join(inputs.workspace, 'pr_metadata.json'),
    `${JSON.stringify({
      title: pr.title,
      body: pr.body ?? '',
      author: { login: pr.user?.login ?? '' },
      baseRefName: pr.base.ref,
      headRefName: pr.head.ref,
    })}\n`,
  );
  return {
    headSha,
    baseSha,
    baseRef: pr.base.ref,
    title: pr.title,
    body: pr.body ?? '',
    author: pr.user?.login ?? '',
    changedFiles: changedFiles.split('\n').filter(Boolean).length,
  };
}
