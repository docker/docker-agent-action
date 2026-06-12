// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * get-pr-meta — fetch core metadata for a GitHub pull request.
 *
 * Exported function: getPrMeta(token, owner, repo, prNumber) → PrMeta
 *
 * Outputs: title, body, author-login, base-ref-name
 */
import { Octokit } from '@octokit/rest';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PrMeta {
  title: string;
  body: string;
  authorLogin: string;
  baseRefName: string;
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/**
 * Fetch title, description, author, and base branch for pull request `prNumber`.
 */
export async function getPrMeta(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<PrMeta> {
  const octokit = new Octokit({ auth: token });
  const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  return {
    title: data.title,
    body: data.body ?? 'No description provided.',
    authorLogin: data.user?.login ?? 'unknown',
    baseRefName: data.base.ref,
  };
}
