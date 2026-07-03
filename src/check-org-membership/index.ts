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
 *   checkRepositoryWritePermission(repoToken, owner, repo, username) → boolean
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
// Core function: repository permission check
// ---------------------------------------------------------------------------

/**
 * Check whether `username` has write-level permission on the repository.
 *
 * This is the API-key-only fallback when Docker's AWS-backed org membership
 * token is unavailable.
 * It keeps fork PRs safe by authorizing only repository collaborators or
 * maintainers, including review-requested runs where the requester is resolved
 * from the trusted PR timeline.
 */
export async function checkRepositoryWritePermission(
  repoToken: string,
  owner: string,
  repo: string,
  username: string,
): Promise<boolean> {
  const octokit = new Octokit({ auth: repoToken });
  try {
    const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({
      owner,
      repo,
      username,
    });
    return ['admin', 'maintain', 'write'].includes(data.permission ?? '');
  } catch (err: unknown) {
    const status = (err as { status?: number }).status;
    if (status === 404) return false;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Core function: review-requester resolution (trusted, server-side)
// ---------------------------------------------------------------------------

interface TimelineReviewEvent {
  /**
   * 'review_requested' grants the request, 'review_request_removed' revokes it;
   * any other timeline event type is ignored. Typed as a literal union (widened
   * with `string` so the cast below still accepts the full timeline) to surface
   * the revocation case to future readers.
   */
  event?: 'review_requested' | 'review_request_removed' | (string & {});
  created_at?: string;
  actor?: { login?: string } | null;
  review_requester?: { login?: string } | null;
  requested_reviewer?: { login?: string } | null;
}

/**
 * Return the login of the user whose review request for `reviewerLogin` is still
 * in effect on the PR, or '' if there is no such request (or it was revoked).
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
  const events = (await octokit.paginate(octokit.rest.issues.listEventsForTimeline, {
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  })) as unknown as TimelineReviewEvent[];

  // Replay request/removal events for this reviewer in chronological order: a
  // 'review_requested' sets the current requester, a later 'review_request_removed'
  // clears it. This handles re-request-after-removal correctly and, critically,
  // ensures a retracted request never authorizes the review on the fork /
  // workflow_run path. Sort by created_at rather than trusting the array order: the
  // timeline endpoint returns ascending order in practice but does not guarantee it,
  // and an out-of-order request/removal pair would otherwise leave a retracted
  // request live — which the org-membership re-check cannot catch, since the stale
  // login is a real member. (ISO-8601 timestamps sort lexicographically.)
  events.sort((a, b) => {
    const at = a.created_at ?? '';
    const bt = b.created_at ?? '';
    return at < bt ? -1 : at > bt ? 1 : 0;
  });

  let requester = '';
  for (const ev of events) {
    if (ev.requested_reviewer?.login !== reviewerLogin) continue;
    if (ev.event === 'review_requested') {
      requester = ev.review_requester?.login ?? ev.actor?.login ?? '';
    } else if (ev.event === 'review_request_removed') {
      requester = '';
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
  // SECURITY: trustedRequester (REQUESTER = github.event.sender.login) is only
  // authoritative for a DIRECT same-repo pull_request:review_requested event,
  // which the workflow tags PR_SOURCE=event. The fork / workflow_run path is
  // tagged PR_SOURCE=trigger and is resolved from the server-side timeline below,
  // because its trigger artifact is written in the untrusted fork context. Gate
  // on the full (event, pull_request, review_requested) triple so that if a
  // caller ever routes another trigger through PR_SOURCE=event, the env-supplied
  // requester is never trusted — it falls through to '' (deny), not the timeline.
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

async function isAuthorizedUser(
  inputs: MembershipInputs,
  owner: string,
  repo: string,
  username: string,
): Promise<boolean> {
  if (!username) return false;
  if (inputs.orgToken && inputs.org) {
    return checkOrgMembership(inputs.orgToken, inputs.org, username);
  }
  return checkRepositoryWritePermission(inputs.repoToken, owner, repo, username);
}

/**
 * Decide whether the review is authorized, returning the subject and the path
 * that granted it. See the module header for the two authorization paths.
 */
export async function evaluateMembership(inputs: MembershipInputs): Promise<MembershipDecision> {
  const { prSource, eventName, commentAuthor } = inputs;
  const { owner, repo } = parseRepository(inputs.repository);

  // Comment-driven triggers (e.g. /review) authorize the commenter. EVENT_NAME may
  // be absent when called by an older caller; fall back to the presence of a
  // comment author to detect this path.
  const isCommentTrigger =
    prSource === 'event' &&
    (eventName === 'issue_comment' || (eventName === '' && commentAuthor !== ''));
  if (isCommentTrigger) {
    const ok = await isAuthorizedUser(inputs, owner, repo, commentAuthor);
    return { isMember: ok, subject: commentAuthor, via: ok ? 'comment' : 'none' };
  }

  if (!Number.isInteger(inputs.prNumber) || inputs.prNumber <= 0) {
    throw new Error(`Invalid pr-number: '${inputs.prNumber}' (expected positive integer)`);
  }

  // Path 1 — auto-run: the PR author must be an org member.
  const author = await resolvePrAuthor(inputs.repoToken, owner, repo, inputs.prNumber);
  if (author && (await isAuthorizedUser(inputs, owner, repo, author))) {
    return { isMember: true, subject: author, via: 'author' };
  }

  // Path 2 — review-requested: an org member who requested the review authorizes
  // it, even when the PR author is external (not an org member).
  const requester = await resolveTrustedRequester(inputs, owner, repo);
  if (requester && (await isAuthorizedUser(inputs, owner, repo, requester))) {
    return { isMember: true, subject: requester, via: 'requester' };
  }

  // Report whoever actually failed the membership check: the requester when path 2
  // was attempted (a requester was resolved), otherwise the PR author from path 1.
  return { isMember: false, subject: requester || author, via: 'none' };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const orgToken = process.env.ORG_MEMBERSHIP_TOKEN ?? '';
  const repoToken = process.env.GITHUB_APP_TOKEN || process.env.GITHUB_TOKEN || '';
  const org = process.env.ORG ?? '';

  if (!repoToken) {
    core.setFailed('GITHUB_APP_TOKEN or GITHUB_TOKEN is not set — cannot authorize the review.');
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
          ? `review requested by authorized user @${decision.subject}`
          : `@${decision.subject} is authorized`;
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
        `Failed to authorize the review: ${err instanceof Error ? err.message : String(err)}`,
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
