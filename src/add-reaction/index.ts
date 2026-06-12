// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * add-reaction — post a reaction emoji on a GitHub issue comment or
 * pull request review comment.
 *
 * Exported function: addReaction(token, owner, repo, commentId, content, commentType?)
 *
 * Output: none (best-effort; logs a warning on failure instead of failing).
 */
import * as core from '@actions/core';
import { Octokit } from '@octokit/rest';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReactionContent =
  | '+1'
  | '-1'
  | 'laugh'
  | 'confused'
  | 'heart'
  | 'hooray'
  | 'rocket'
  | 'eyes';

export type CommentType = 'issue' | 'pull_request_review';

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/**
 * Post a reaction on a GitHub comment (best-effort — warns on failure).
 *
 * @param commentType - 'issue' (default) uses the issue comment API;
 *   'pull_request_review' uses the PR review comment API.
 */
export async function addReaction(
  token: string,
  owner: string,
  repo: string,
  commentId: number,
  content: ReactionContent,
  commentType: CommentType = 'issue',
): Promise<void> {
  const octokit = new Octokit({ auth: token });
  try {
    if (commentType === 'pull_request_review') {
      await octokit.rest.reactions.createForPullRequestReviewComment({
        owner,
        repo,
        comment_id: commentId,
        content,
      });
    } else {
      await octokit.rest.reactions.createForIssueComment({
        owner,
        repo,
        comment_id: commentId,
        content,
      });
    }
  } catch (err) {
    core.warning(
      `Failed to add ${content} reaction: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
