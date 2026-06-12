// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';

vi.mock('@actions/core');

const { mockCreateComment, mockCreateReplyForReviewComment, MockOctokit } = vi.hoisted(() => {
  const mockCreateComment = vi.fn().mockResolvedValue({});
  const mockCreateReplyForReviewComment = vi.fn().mockResolvedValue({});

  class MockOctokit {
    rest = {
      issues: { createComment: mockCreateComment },
      pulls: { createReplyForReviewComment: mockCreateReplyForReviewComment },
    };
  }

  return { mockCreateComment, mockCreateReplyForReviewComment, MockOctokit };
});

vi.mock('@octokit/rest', () => ({ Octokit: MockOctokit }));

import { postComment, postReviewCommentReply } from '../index.js';

const TOKEN = 'fake-token';
const OWNER = 'docker';
const REPO = 'myrepo';
const ISSUE_NUMBER = 42;
const BODY = 'Hello from the agent.\n\n<!-- cagent-review-reply -->';

describe('postComment', () => {
  it('calls createComment with the correct parameters', async () => {
    await postComment(TOKEN, OWNER, REPO, ISSUE_NUMBER, BODY);

    expect(mockCreateComment).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      issue_number: ISSUE_NUMBER,
      body: BODY,
    });
  });

  it('propagates API errors to the caller', async () => {
    mockCreateComment.mockRejectedValueOnce(new Error('Forbidden'));

    await expect(postComment(TOKEN, OWNER, REPO, ISSUE_NUMBER, BODY)).rejects.toThrow('Forbidden');
  });
});

describe('postReviewCommentReply', () => {
  const PR_NUMBER = 42;
  const IN_REPLY_TO = 12345;

  it('calls createReplyForReviewComment with the correct parameters', async () => {
    await postReviewCommentReply(TOKEN, OWNER, REPO, PR_NUMBER, IN_REPLY_TO, BODY);

    expect(mockCreateReplyForReviewComment).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      pull_number: PR_NUMBER,
      comment_id: IN_REPLY_TO,
      body: BODY,
    });
  });

  it('propagates API errors to the caller', async () => {
    mockCreateReplyForReviewComment.mockRejectedValueOnce(new Error('Not Found'));

    await expect(
      postReviewCommentReply(TOKEN, OWNER, REPO, PR_NUMBER, IN_REPLY_TO, BODY),
    ).rejects.toThrow('Not Found');
  });
});
