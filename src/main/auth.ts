// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * auth.ts — 4-tier authorization waterfall for comment-triggered events.
 *
 * Mirrors the `Check authorization` step of the original composite action.yml.
 * Tiers (in priority order):
 *
 *   0. skip-auth=true       → pass through (caller already verified)
 *   1. Not a comment event  → pass through (PR-triggered workflows are safe)
 *   2. Trusted-bot bypass   → resolve github-token's login via GET /user; if it
 *                             matches the comment author, authorize.
 *   3. Org membership       → call GET /orgs/{org}/members/{user} (preferred)
 *   4. author_association   → legacy fallback (OWNER/MEMBER/COLLABORATOR)
 *
 * Returns an AuthResult describing the outcome so the caller can set outputs
 * and decide whether to continue or fail.
 */

import * as fs from 'node:fs';
import * as core from '@actions/core';
import { Octokit } from '@octokit/rest';
import { checkOrgMembership } from '../check-org-membership/index.js';
import { checkAuth } from '../security/check-auth.js';

export interface AuthResult {
  /** Whether the actor is authorized to proceed. */
  authorized: boolean;
  /**
   * Human-readable reason for the decision.
   * Also used as the value of the `authorized` composite output:
   *   'skipped-by-caller' | 'skipped' | 'true' | 'false'
   */
  outcome:
    | 'skipped-by-caller'
    | 'skipped'
    | 'trusted-bot'
    | 'org-member'
    | 'author-association'
    | 'denied';
}

/** GitHub event payload shape (minimal — only the fields we read). */
interface CommentPayload {
  comment?: {
    author_association?: string;
    user?: {
      login?: string;
    };
  };
}

/**
 * Run the 4-tier authorization waterfall.
 *
 * @param opts.skipAuth          Value of the `skip-auth` input.
 * @param opts.githubToken       Resolved GitHub token (input override or GITHUB_TOKEN).
 * @param opts.orgMembershipToken PAT for org membership check (may be empty).
 * @param opts.authOrg           Org to check membership against (may be empty).
 * @param opts.eventPayloadPath  Path to $GITHUB_EVENT_PATH.
 */
export async function checkAuthorization(opts: {
  skipAuth: boolean;
  githubToken: string;
  orgMembershipToken: string;
  authOrg: string;
  eventPayloadPath: string;
}): Promise<AuthResult> {
  const { skipAuth, githubToken, orgMembershipToken, authOrg, eventPayloadPath } = opts;

  // ── Tier 0: caller bypasses auth ────────────────────────────────────────
  if (skipAuth) {
    core.info('ℹ️ Skipping auth check (caller already verified authorization)');
    return { authorized: true, outcome: 'skipped-by-caller' };
  }

  // ── Read event payload ───────────────────────────────────────────────────
  let payload: CommentPayload = {};
  try {
    const raw = fs.readFileSync(eventPayloadPath, 'utf-8');
    payload = JSON.parse(raw) as CommentPayload;
  } catch {
    core.warning(
      `Could not read event payload from ${eventPayloadPath}; treating as non-comment event`,
    );
  }

  const commentAssociation = payload.comment?.author_association ?? '';
  const commentUserLogin = payload.comment?.user?.login ?? '';

  // ── Tier 1: not a comment event — skip auth ──────────────────────────────
  if (!commentAssociation && !commentUserLogin) {
    core.info('ℹ️ Skipping auth check (not a comment-triggered event)');
    return { authorized: true, outcome: 'skipped' };
  }

  // ── Tier 2: trusted-bot bypass ───────────────────────────────────────────
  // Resolve the github-token's owner login via GET /user. If it matches the
  // comment author, the comment was authored by our own bot — authorize.
  try {
    const botOctokit = new Octokit({ auth: githubToken });
    const { data } = await botOctokit.rest.users.getAuthenticated();
    const trustedBotLogin = data.login;
    if (commentUserLogin && commentUserLogin === trustedBotLogin) {
      core.info(`ℹ️ Skipping auth check (trusted bot: ${commentUserLogin})`);
      return { authorized: true, outcome: 'trusted-bot' };
    }
  } catch (err: unknown) {
    core.warning(
      `Could not resolve bot login from github-token (${(err as Error).message}); trusted-bot bypass will not apply`,
    );
  }

  // ── Tier 3: org membership check ────────────────────────────────────────
  if (orgMembershipToken && authOrg && commentUserLogin) {
    core.info(`Checking org membership for @${commentUserLogin} in ${authOrg}...`);
    try {
      const isMember = await checkOrgMembership(orgMembershipToken, authOrg, commentUserLogin);
      if (isMember) {
        core.info(`✅ Authorization successful: @${commentUserLogin} is a ${authOrg} org member`);
        return { authorized: true, outcome: 'org-member' };
      } else {
        core.error(`❌ Authorization failed: @${commentUserLogin} is not a ${authOrg} org member`);
        return { authorized: false, outcome: 'denied' };
      }
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if (status === 401) {
        core.error(`Org membership token is invalid (HTTP 401): ${(err as Error).message}`);
        return { authorized: false, outcome: 'denied' };
      }
      // Network / 5xx: warn and fall through to Tier 4
      core.warning(
        `Org membership check failed (${(err as Error).message}); falling back to author_association`,
      );
    }
  }

  // ── Tier 4: author_association fallback ──────────────────────────────────
  if (commentAssociation) {
    core.warning(
      `Using author_association fallback (${commentAssociation}). Configure org-membership-token and auth-org for more reliable authorization.`,
    );
    const allowedRoles = ['OWNER', 'MEMBER', 'COLLABORATOR'];
    const ok = checkAuth(commentAssociation, allowedRoles);
    if (ok) {
      return { authorized: true, outcome: 'author-association' };
    }
    return { authorized: false, outcome: 'denied' };
  }

  // No method available
  core.error('No authorization method available (no org token, no author_association)');
  return { authorized: false, outcome: 'denied' };
}
