// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * post-comment — create a comment on a GitHub issue or pull request.
 *
 * Exports:
 *   - postComment(token, owner, repo, issueNumber, body)
 *       Posts a top-level comment via the Issues API
 *       (/issues/{number}/comments). Works for both plain issues and PRs.
 *   - postReviewCommentReply(token, owner, repo, prNumber, inReplyToCommentId, body)
 *       Posts an inline reply in an existing PR review thread via the Pulls
 *       API (/pulls/{number}/comments) with `in_reply_to`.
 */
import { Octokit } from '@octokit/rest';

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Post `body` as a new top-level comment on issue/PR `issueNumber`.
 */
export async function postComment(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<void> {
  const octokit = new Octokit({ auth: token });
  await octokit.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body });
}

/**
 * Post `body` as an inline reply to an existing PR review comment thread.
 *
 * GitHub renders this in the same inline thread as `inReplyToCommentId`
 * (i.e. on the same file/line as the originating comment). The `commit_id`
 * of the reply is taken from the originating thread automatically.
 */
export async function postReviewCommentReply(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  inReplyToCommentId: number,
  body: string,
): Promise<void> {
  const octokit = new Octokit({ auth: token });
  await octokit.rest.pulls.createReplyForReviewComment({
    owner,
    repo,
    pull_number: prNumber,
    comment_id: inReplyToCommentId,
    body,
  });
}
