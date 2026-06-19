// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MARKER = '<!-- docker-agent-review-reply -->';

// ---------------------------------------------------------------------------
// Hoist mock functions and MockOctokit class before vi.mock() calls
// ---------------------------------------------------------------------------
const { mockPaginate, mockCreateReplyForReviewComment, mockCreateIssueComment, MockOctokit } =
  vi.hoisted(() => {
    const mockPaginate = vi.fn().mockResolvedValue([]);
    const mockCreateReplyForReviewComment = vi.fn().mockResolvedValue({});
    const mockCreateIssueComment = vi.fn().mockResolvedValue({});

    class MockOctokit {
      paginate = mockPaginate;
      rest = {
        pulls: {
          listReviewComments: vi.fn(),
          createReplyForReviewComment: mockCreateReplyForReviewComment,
        },
        issues: {
          createComment: mockCreateIssueComment,
        },
      };
    }

    return { mockPaginate, mockCreateReplyForReviewComment, mockCreateIssueComment, MockOctokit };
  });

vi.mock('@octokit/rest', () => ({ Octokit: MockOctokit }));

// Imports of code-under-test come AFTER all vi.mock() calls
import { type PostMentionReplyConfig, run } from '../index.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let outputFile: string;

const BASE_CONFIG: PostMentionReplyConfig = {
  secretsDetected: '',
  outputFile: '', // overridden in beforeEach
  owner: 'docker',
  repo: 'myrepo',
  prNumber: '42',
  isInline: false,
  inReplyToId: '',
  token: 'fake-token',
};

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'post-mention-reply-test-'));
  outputFile = join(tmpDir, 'output.txt');
  writeFileSync(outputFile, `Some agent reply.\n\n${MARKER}\n`);

  vi.clearAllMocks();

  // Re-apply defaults after clearAllMocks
  mockPaginate.mockResolvedValue([]);
  mockCreateReplyForReviewComment.mockResolvedValue({});
  mockCreateIssueComment.mockResolvedValue({});
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Guard 1 — SECRETS_DETECTED
// ---------------------------------------------------------------------------

describe('guard: SECRETS_DETECTED=true', () => {
  it('skips without posting when secrets detected', async () => {
    await run({ ...BASE_CONFIG, outputFile, secretsDetected: 'true' });

    expect(mockCreateIssueComment).not.toHaveBeenCalled();
    expect(mockCreateReplyForReviewComment).not.toHaveBeenCalled();
    expect(mockPaginate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Guard 2 — output file
// ---------------------------------------------------------------------------

describe('guard: output file missing', () => {
  it('skips when outputFile is empty string', async () => {
    await run({ ...BASE_CONFIG, outputFile: '' });

    expect(mockCreateIssueComment).not.toHaveBeenCalled();
    expect(mockCreateReplyForReviewComment).not.toHaveBeenCalled();
  });

  it('skips when output file does not exist on disk', async () => {
    await run({ ...BASE_CONFIG, outputFile: '/nonexistent/path/output.txt' });

    expect(mockCreateIssueComment).not.toHaveBeenCalled();
    expect(mockCreateReplyForReviewComment).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Guard 3 — marker absent
// ---------------------------------------------------------------------------

describe('guard: marker absent from output file', () => {
  it('skips when output file has no <!-- docker-agent-review-reply --> marker', async () => {
    writeFileSync(outputFile, 'Some agent content with no marker.');

    await run({ ...BASE_CONFIG, outputFile });

    expect(mockCreateIssueComment).not.toHaveBeenCalled();
    expect(mockCreateReplyForReviewComment).not.toHaveBeenCalled();
  });

  it('skips top-level post when marker absent (guard 3 applies to all paths)', async () => {
    writeFileSync(outputFile, 'No marker here at all.');

    await run({ ...BASE_CONFIG, outputFile, isInline: false });

    expect(mockCreateIssueComment).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Guard 4 — routing variables
// ---------------------------------------------------------------------------

describe('guard: routing variables empty', () => {
  it('skips when OWNER is empty', async () => {
    await run({ ...BASE_CONFIG, outputFile, owner: '' });

    expect(mockCreateIssueComment).not.toHaveBeenCalled();
    expect(mockCreateReplyForReviewComment).not.toHaveBeenCalled();
  });

  it('skips when REPO is empty', async () => {
    await run({ ...BASE_CONFIG, outputFile, repo: '' });

    expect(mockCreateIssueComment).not.toHaveBeenCalled();
  });

  it('skips when PR_NUMBER is empty', async () => {
    await run({ ...BASE_CONFIG, outputFile, prNumber: '' });

    expect(mockCreateIssueComment).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Guard 5 — IS_INLINE=true with empty IN_REPLY_TO_ID
// ---------------------------------------------------------------------------

describe('guard: IS_INLINE=true with empty IN_REPLY_TO_ID', () => {
  it('skips and does not paginate when inReplyToId is empty', async () => {
    await run({ ...BASE_CONFIG, outputFile, isInline: true, inReplyToId: '' });

    expect(mockPaginate).not.toHaveBeenCalled();
    expect(mockCreateReplyForReviewComment).not.toHaveBeenCalled();
    expect(mockCreateIssueComment).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Guard 6 — IN_REPLY_TO_ID numeric validation
// ---------------------------------------------------------------------------

describe('guard: IN_REPLY_TO_ID numeric validation (IS_INLINE=true)', () => {
  it('skips when IN_REPLY_TO_ID is a non-numeric string', async () => {
    await run({ ...BASE_CONFIG, outputFile, isInline: true, inReplyToId: 'abc' });

    expect(mockPaginate).not.toHaveBeenCalled();
    expect(mockCreateReplyForReviewComment).not.toHaveBeenCalled();
    expect(mockCreateIssueComment).not.toHaveBeenCalled();
  });

  it('skips when IN_REPLY_TO_ID is "0"', async () => {
    await run({ ...BASE_CONFIG, outputFile, isInline: true, inReplyToId: '0' });

    expect(mockPaginate).not.toHaveBeenCalled();
    expect(mockCreateReplyForReviewComment).not.toHaveBeenCalled();
    expect(mockCreateIssueComment).not.toHaveBeenCalled();
  });

  it('skips when IN_REPLY_TO_ID is a negative number string', async () => {
    await run({ ...BASE_CONFIG, outputFile, isInline: true, inReplyToId: '-5' });

    expect(mockPaginate).not.toHaveBeenCalled();
    expect(mockCreateReplyForReviewComment).not.toHaveBeenCalled();
    expect(mockCreateIssueComment).not.toHaveBeenCalled();
  });

  it('does not apply the guard when IS_INLINE=false (non-numeric ID is ignored)', async () => {
    // When IS_INLINE=false, inReplyToId is unused and guard 6 must not fire
    await run({ ...BASE_CONFIG, outputFile, isInline: false, inReplyToId: 'abc' });

    expect(mockCreateIssueComment).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Inline dedup (Guard 7)
// ---------------------------------------------------------------------------

describe('inline dedup', () => {
  it('skips inline post when dedup finds an existing reply in the thread', async () => {
    mockPaginate.mockResolvedValue([
      {
        id: 999,
        in_reply_to_id: 77,
        body: `An existing agent reply.\n\n${MARKER}`,
      },
    ]);

    await run({ ...BASE_CONFIG, outputFile, isInline: true, inReplyToId: '77' });

    expect(mockCreateReplyForReviewComment).not.toHaveBeenCalled();
    expect(mockCreateIssueComment).not.toHaveBeenCalled();
  });

  it('does not skip when existing reply is in a different thread (different in_reply_to_id)', async () => {
    mockPaginate.mockResolvedValue([
      {
        id: 999,
        in_reply_to_id: 999, // different thread
        body: `A reply in another thread.\n\n${MARKER}`,
      },
    ]);

    await run({ ...BASE_CONFIG, outputFile, isInline: true, inReplyToId: '77' });

    expect(mockCreateReplyForReviewComment).toHaveBeenCalled();
  });

  it('does not skip when existing reply in thread has no marker', async () => {
    mockPaginate.mockResolvedValue([
      {
        id: 999,
        in_reply_to_id: 77,
        body: 'A reply without the marker.',
      },
    ]);

    await run({ ...BASE_CONFIG, outputFile, isInline: true, inReplyToId: '77' });

    expect(mockCreateReplyForReviewComment).toHaveBeenCalled();
  });

  it('posts inline reply via Pulls API when no duplicate found', async () => {
    mockPaginate.mockResolvedValue([]);

    await run({ ...BASE_CONFIG, outputFile, isInline: true, inReplyToId: '77' });

    expect(mockCreateReplyForReviewComment).toHaveBeenCalledWith({
      owner: 'docker',
      repo: 'myrepo',
      pull_number: 42,
      comment_id: 77,
      body: expect.stringContaining(MARKER),
    });
    expect(mockCreateIssueComment).not.toHaveBeenCalled();
  });

  it('does not call paginate for top-level replies (no dedup for top-level)', async () => {
    await run({ ...BASE_CONFIG, outputFile, isInline: false });

    expect(mockPaginate).not.toHaveBeenCalled();
  });

  it('logs a warning and posts anyway when paginate throws', async () => {
    mockPaginate.mockRejectedValue(new Error('API rate limit exceeded'));
    const stdoutSpy = vi.spyOn(process.stdout, 'write');

    await run({ ...BASE_CONFIG, outputFile, isInline: true, inReplyToId: '77' });

    // Must post despite the dedup failure
    expect(mockCreateReplyForReviewComment).toHaveBeenCalledWith({
      owner: 'docker',
      repo: 'myrepo',
      pull_number: 42,
      comment_id: 77,
      body: expect.stringContaining(MARKER),
    });
    expect(mockCreateIssueComment).not.toHaveBeenCalled();

    // Must log the warning with the error message
    const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('\u26a0\ufe0f Dedup check failed');
    expect(output).toContain('API rate limit exceeded');

    stdoutSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Posting — top-level
// ---------------------------------------------------------------------------

describe('posting: top-level reply', () => {
  it('posts top-level reply via Issues API', async () => {
    await run({ ...BASE_CONFIG, outputFile, isInline: false });

    expect(mockCreateIssueComment).toHaveBeenCalledWith({
      owner: 'docker',
      repo: 'myrepo',
      issue_number: 42,
      body: expect.stringContaining(MARKER),
    });
    expect(mockCreateReplyForReviewComment).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Body extraction
// ---------------------------------------------------------------------------

describe('body extraction', () => {
  it('includes content up to and including the marker line, excludes content after', async () => {
    writeFileSync(outputFile, `Part 1.\nPart 2.\n\n${MARKER}\n\nExtra content after marker.`);

    await run({ ...BASE_CONFIG, outputFile, isInline: false });

    const call = mockCreateIssueComment.mock.calls[0]?.[0] as { body: string };
    expect(call.body).toContain('Part 1.');
    expect(call.body).toContain('Part 2.');
    expect(call.body).toContain(MARKER);
    expect(call.body).not.toContain('Extra content after marker.');
  });

  it('passes extracted body to inline reply API', async () => {
    writeFileSync(outputFile, `Inline answer here.\n\n${MARKER}\n\nSome trailing content.`);

    await run({ ...BASE_CONFIG, outputFile, isInline: true, inReplyToId: '55' });

    const call = mockCreateReplyForReviewComment.mock.calls[0]?.[0] as { body: string };
    expect(call.body).toContain('Inline answer here.');
    expect(call.body).toContain(MARKER);
    expect(call.body).not.toContain('Some trailing content.');
  });
});
