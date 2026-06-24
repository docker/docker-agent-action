// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * check-org-membership — decide whether a PR review is authorized.
 *
 * Two authorization paths feed the same review pipeline:
 *   1. Auto-run        — a PR opened/updated by an org MEMBER is reviewed
 *                        automatically. Authorized on the PR AUTHOR's membership.
 *   2. Review-requested — when `docker-agent` is requested as a reviewer, the
 *                        review is authorized on the REQUESTER's membership, not
 *                        the author's. This lets a maintainer pull an EXTERNAL
 *                        contributor's PR into the review pipeline on demand.
 *
 * Security note: the requester is only ever taken from a TRUSTED source — the
 * `github.event.sender.login` of a same-repo pull_request event, or (on the
 * fork / workflow_run path) re-derived from the PR timeline via the GitHub API.
 * It is NEVER read from the trigger artifact, because a fork PR controls its own
 * trigger workflow and could otherwise forge a member login.
 *
 * Exported functions:
 *   checkOrgMembership(orgToken, org, username) → boolean
 *   resolvePrAuthor(repoToken, owner, repo, prNumber) → string
 *   resolveReviewRequester(repoToken, owner, repo, prNumber, reviewerLogin) → string
 *   evaluateMembership(inputs) → { isMember, subject, via }
 *
 * CLI (invoked as a shell run step via dist/check-org-membership.js):
 *   All inputs are read from environment variables:
 *     ORG_MEMBERSHIP_TOKEN   PAT with read:org scope (set by setup-credentials)
 *     GITHUB_APP_TOKEN       PAT with repo scope (set by setup-credentials)
 *     GITHUB_REPOSITORY      "owner/repo" (standard GitHub Actions env var)
 *     ORG                    GitHub org name to check (e.g. "docker")
 *     PR_SOURCE              "event" | "trigger" | "input"
 *     PR_NUMBER              PR number as string (required for PR-driven paths)
 *     COMMENT_AUTHOR         User login (used on the issue_comment path)
 *     EVENT_NAME             github.event_name (issue_comment | pull_request | …)
 *     EVENT_ACTION           github.event.action (e.g. "review_requested")
 *     REQUESTER              github.event.sender.login (trusted; direct path only)
 *     AGENT_LOGIN            Reviewer login to match (default "docker-agent")
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
// Core function: review-requester resolution (trusted, server-side)
// ---------------------------------------------------------------------------

interface TimelineReviewRequestedEvent {
  event?: string;
  actor?: { login?: string } | null;
  review_requester?: { login?: string } | null;
  requested_reviewer?: { login?: string } | null;
}

/**
 * Return the login of the user who most recently requested `reviewerLogin` as a
 * reviewer on the PR, or '' if no such request exists.
 *
 * Derived from the PR timeline via the GitHub API using `repoToken`. This is the
 * authoritative, non-forgeable source for the requester on the fork / workflow_run
 * path, where the triggering event payload is not directly available and the
 * trigger artifact is written in the untrusted fork context.
 */
export async function resolveReviewRequester(
  repoToken: string,
  owner: string,
  repo: string,
  prNumber: number,
  reviewerLogin: string,
): Promise<string> {
  const octokit = new Octokit({ auth: repoToken });
  // Paginate: the relevant review_requested event may be anywhere in the timeline,
  // and timelines are returned in chronological (ascending) order, so the latest
  // matching event — the one we want — is towards the end.
  const events = (await octokit.paginate(octokit.rest.issues.listEventsForTimeline, {
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  })) as unknown as TimelineReviewRequestedEvent[];

  let requester = '';
  for (const ev of events) {
    if (ev.event === 'review_requested' && ev.requested_reviewer?.login === reviewerLogin) {
      const actor = ev.review_requester?.login ?? ev.actor?.login ?? '';
      if (actor) requester = actor;
    }
  }
  return requester;
}

// ---------------------------------------------------------------------------
// Authorization decision
// ---------------------------------------------------------------------------

export interface MembershipInputs {
  orgToken: string;
  repoToken: string;
  org: string;
  reviewerLogin: string;
  repository: string;
  prSource: string;
  eventName: string;
  eventAction: string;
  prNumber: number;
  commentAuthor: string;
  /** Trusted requester login from github.event.sender.login (direct path only). */
  trustedRequester: string;
}

export interface MembershipDecision {
  isMember: boolean;
  subject: string;
  via: 'comment' | 'author' | 'requester' | 'none';
}

function parseRepository(repository: string): { owner: string; repo: string } {
  const slashIdx = repository.indexOf('/');
  if (slashIdx < 0) {
    throw new Error(`Invalid GITHUB_REPOSITORY: '${repository}' (expected 'owner/repo')`);
  }
  return { owner: repository.slice(0, slashIdx), repo: repository.slice(slashIdx + 1) };
}

/**
 * Resolve the review requester from a trusted source only.
 *  - Direct same-repo pull_request review_requested → github.event.sender.login.
 *  - Fork / workflow_run path → re-derived from the PR timeline (server-side).
 * Returns '' when there is no trustworthy requester.
 */
async function resolveTrustedRequester(
  inputs: MembershipInputs,
  owner: string,
  repo: string,
): Promise<string> {
  const { prSource, eventName, eventAction, trustedRequester } = inputs;
  if (prSource === 'event' && eventName === 'pull_request' && eventAction === 'review_requested') {
    return trustedRequester;
  }
  if (prSource === 'trigger') {
    try {
      return await resolveReviewRequester(
        inputs.repoToken,
        owner,
        repo,
        inputs.prNumber,
        inputs.reviewerLogin,
      );
    } catch (err: unknown) {
      core.warning(
        `Failed to resolve review requester for #${inputs.prNumber}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return '';
    }
  }
  return '';
}

/**
 * Decide whether the review is authorized, returning the subject and the path
 * that granted it. See the module header for the two authorization paths.
 */
export async function evaluateMembership(inputs: MembershipInputs): Promise<MembershipDecision> {
  const { orgToken, org, prSource, eventName, commentAuthor } = inputs;

  // Comment-driven triggers (e.g. /review) authorize the commenter. EVENT_NAME may
  // be absent when called by an older caller; fall back to the presence of a
  // comment author to detect this path.
  const isCommentTrigger =
    prSource === 'event' &&
    (eventName === 'issue_comment' || (eventName === '' && commentAuthor !== ''));
  if (isCommentTrigger) {
    const ok = commentAuthor !== '' && (await checkOrgMembership(orgToken, org, commentAuthor));
    return { isMember: ok, subject: commentAuthor, via: ok ? 'comment' : 'none' };
  }

  const { owner, repo } = parseRepository(inputs.repository);
  if (!Number.isInteger(inputs.prNumber) || inputs.prNumber <= 0) {
    throw new Error(`Invalid pr-number: '${inputs.prNumber}' (expected positive integer)`);
  }

  // Path 1 — auto-run: the PR author must be an org member.
  const author = await resolvePrAuthor(inputs.repoToken, owner, repo, inputs.prNumber);
  if (author && (await checkOrgMembership(orgToken, org, author))) {
    return { isMember: true, subject: author, via: 'author' };
  }

  // Path 2 — review-requested: an org member who requested the review authorizes
  // it, even when the PR author is external (not an org member).
  const requester = await resolveTrustedRequester(inputs, owner, repo);
  if (requester && (await checkOrgMembership(orgToken, org, requester))) {
    return { isMember: true, subject: requester, via: 'requester' };
  }

  return { isMember: false, subject: author, via: 'none' };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const orgToken = process.env.ORG_MEMBERSHIP_TOKEN ?? '';
  const repoToken = process.env.GITHUB_APP_TOKEN ?? '';
  const org = process.env.ORG ?? '';

  if (!orgToken) {
    core.setFailed('ORG_MEMBERSHIP_TOKEN is not set — ensure setup-credentials ran successfully.');
    return;
  }
  if (!repoToken) {
    core.setFailed('GITHUB_APP_TOKEN is not set — ensure setup-credentials ran successfully.');
    return;
  }

  const inputs: MembershipInputs = {
    orgToken,
    repoToken,
    org,
    reviewerLogin: process.env.AGENT_LOGIN ?? 'docker-agent',
    repository: process.env.GITHUB_REPOSITORY ?? '',
    prSource: process.env.PR_SOURCE ?? '',
    eventName: process.env.EVENT_NAME ?? '',
    eventAction: process.env.EVENT_ACTION ?? '',
    prNumber: Number.parseInt(process.env.PR_NUMBER ?? '', 10),
    commentAuthor: process.env.COMMENT_AUTHOR ?? '',
    trustedRequester: process.env.REQUESTER ?? '',
  };

  try {
    const decision = await evaluateMembership(inputs);
    core.setOutput('is_member', String(decision.isMember));
    if (decision.isMember) {
      const reason =
        decision.via === 'requester'
          ? `review requested by ${org} org member @${decision.subject}`
          : `@${decision.subject} is a ${org} org member`;
      core.info(`✅ ${reason} — proceeding with review`);
    } else {
      core.info(
        `⏭️ Not authorized to review (subject: @${decision.subject || 'unknown'}) — skipping`,
      );
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
