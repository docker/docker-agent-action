// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * check-org-membership — verify whether a GitHub user belongs to an org.
 *
 * Exported functions:
 *   checkOrgMembership(orgToken, org, username) → boolean
 *   resolvePrAuthor(repoToken, owner, repo, prNumber) → string
 *
 * CLI (invoked as a shell run step via dist/check-org-membership.js):
 *   All inputs are read from environment variables:
 *     ORG_MEMBERSHIP_TOKEN   PAT with read:org scope (set by setup-credentials)
 *     GITHUB_APP_TOKEN       PAT with repo scope (set by setup-credentials)
 *     GITHUB_REPOSITORY      "owner/repo" (standard GitHub Actions env var)
 *     ORG                    GitHub org name to check (e.g. "docker")
 *     PR_SOURCE              "event" | "trigger" | "input"
 *     PR_NUMBER              PR number as string (required when no author env is set)
 *     COMMENT_AUTHOR         Comment author login (set on comment-triggered events)
 *     PR_AUTHOR              PR author login (set on pull_request events so the direct
 *                            auto-review path verifies the PR author, not an empty
 *                            comment author; falls back to a live API lookup if unset)
 *
 *   Outputs are written via @actions/core.setOutput (writes to $GITHUB_OUTPUT):
 *     is_member              "true" | "false"
 *
 * Guard: the CLI entry point only executes when process.argv[1] ends with
 * "check-org-membership.js" and VITEST is not set. This prevents the CLI from
 * firing when this module is bundled into dist/mention-reply.js or dist/main.js
 * as a library dependency.
 */
import * as core from '@actions/core';
import { Octokit } from '@octokit/rest';

// ---------------------------------------------------------------------------
// Core function: membership check
// ---------------------------------------------------------------------------

/**
 * Check whether `username` is a member of `org`.
 * Uses `orgToken` (must have read:org scope) for the membership API.
 */
export async function checkOrgMembership(
  orgToken: string,
  org: string,
  username: string,
): Promise<boolean> {
  const octokit = new Octokit({ auth: orgToken });
  try {
    await octokit.rest.orgs.checkMembershipForUser({ org, username });
    return true;
  } catch (err: unknown) {
    const status = (err as { status?: number }).status;
    if (status === 404 || status === 302) return false;
    if (status === 401) {
      throw Object.assign(
        new Error(
          'Org membership token is missing or invalid (HTTP 401). ' +
            "Ensure the job has 'id-token: write' permission and OIDC is configured.",
        ),
        { status: 401 },
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Core function: PR author resolution
// ---------------------------------------------------------------------------

/**
 * Fetch the login of the PR author via the GitHub REST API.
 *
 * Uses `repoToken` (must have repo scope) — intentionally separate from
 * `orgToken` so the read:org token is never used for repo-scoped API calls.
 */
export async function resolvePrAuthor(
  repoToken: string,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<string> {
  const octokit = new Octokit({ auth: repoToken });
  const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  return pr.user?.login ?? '';
}

// ---------------------------------------------------------------------------
// Core function: resolve which user's membership to verify
// ---------------------------------------------------------------------------

export interface ResolveUsernameOptions {
  /** "event" | "trigger" | "input" — how the PR number was resolved. */
  prSource: string;
  /** Comment author login (set on comment-triggered events). */
  commentAuthor: string;
  /** PR author login (set on pull_request events). */
  prAuthor: string;
  /** Repo-scoped token used for the live PR-author lookup fallback. */
  repoToken: string;
  owner: string;
  repo: string;
  prNumber: number;
}

/**
 * Resolve the login whose org membership must be verified for this request.
 *
 * Precedence:
 *   1. On an "event" trigger, the comment author (comment-driven events) or the
 *      PR author (pull_request events expose PR_AUTHOR, not a comment author).
 *   2. Otherwise — and as a fallback when both author envs are empty — resolve
 *      the PR author live via the API.
 *
 * The fallback closes the historical gap where a directly-wired pull_request
 * auto-review passed an empty COMMENT_AUTHOR, so the PR author was never checked.
 */
export async function resolveUsername(opts: ResolveUsernameOptions): Promise<string> {
  if (opts.prSource === 'event') {
    const fromEvent = opts.commentAuthor || opts.prAuthor;
    if (fromEvent) return fromEvent;
  }
  return resolvePrAuthor(opts.repoToken, opts.owner, opts.repo, opts.prNumber);
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const orgToken = process.env.ORG_MEMBERSHIP_TOKEN ?? '';
  const repoToken = process.env.GITHUB_APP_TOKEN ?? '';
  const org = process.env.ORG ?? '';
  const prSource = process.env.PR_SOURCE ?? '';
  const prNumberStr = process.env.PR_NUMBER ?? '';
  const commentAuthor = process.env.COMMENT_AUTHOR ?? '';
  const prAuthor = process.env.PR_AUTHOR ?? '';
  const repository = process.env.GITHUB_REPOSITORY ?? '';

  if (!orgToken) {
    core.setFailed('ORG_MEMBERSHIP_TOKEN is not set — ensure setup-credentials ran successfully.');
    return;
  }
  if (!repoToken) {
    core.setFailed('GITHUB_APP_TOKEN is not set — ensure setup-credentials ran successfully.');
    return;
  }

  // A PR number is always required: even on the "event" path the author env may
  // be empty (directly-wired pull_request auto-review), which falls back to a
  // live PR-author lookup.
  const prNumber = parseInt(prNumberStr, 10);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    core.setFailed(`Invalid pr-number: '${prNumberStr}' (expected positive integer)`);
    return;
  }
  const slashIdx = repository.indexOf('/');
  if (slashIdx < 0) {
    core.setFailed(`Invalid GITHUB_REPOSITORY: '${repository}' (expected 'owner/repo')`);
    return;
  }
  const owner = repository.slice(0, slashIdx);
  const repo = repository.slice(slashIdx + 1);

  let username: string;
  try {
    username = await resolveUsername({
      prSource,
      commentAuthor,
      prAuthor,
      repoToken,
      owner,
      repo,
      prNumber,
    });
  } catch (err: unknown) {
    core.setFailed(
      `Failed to resolve user for membership check on #${prNumber}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  if (!username) {
    // No resolvable user — fail closed: do not authorize a review we can't attribute.
    core.setOutput('is_member', 'false');
    core.info('⏭️ Could not resolve a user to verify org membership — skipping review');
    return;
  }

  try {
    const isMember = await checkOrgMembership(orgToken, org, username);
    core.setOutput('is_member', String(isMember));
    if (isMember) {
      core.info(`✅ ${username} is a ${org} org member — proceeding with review`);
    } else {
      core.info(`⏭️ ${username} is not a ${org} org member — skipping review`);
    }
  } catch (err: unknown) {
    const status = (err as { status?: number }).status;
    if (status === 401) {
      core.setFailed(
        `❌ Org membership token is missing or invalid (HTTP 401).\n\n` +
          `This token is fetched automatically from AWS Secrets Manager in docker/* repos.\n` +
          `Ensure the workflow job has 'id-token: write' permission and OIDC is configured.`,
      );
    } else {
      core.setFailed(
        `Failed to check org membership: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

// Guard: only run as CLI when invoked directly as dist/check-org-membership.js,
// never when bundled into dist/mention-reply.js or dist/main.js as a library.
if (process.argv[1]?.endsWith('check-org-membership.js') && !process.env.VITEST) {
  main().catch((err: unknown) => {
    core.setFailed(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  });
}
