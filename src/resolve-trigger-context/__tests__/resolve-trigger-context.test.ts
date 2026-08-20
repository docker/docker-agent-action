// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getWorkflowRun, listPulls, getPull, getReviewComment, paginate, MockOctokit } = vi.hoisted(
  () => {
    const getWorkflowRun = vi.fn();
    const listPulls = vi.fn();
    const getPull = vi.fn();
    const getReviewComment = vi.fn();
    const paginate = vi.fn();
    class MockOctokit {
      rest = {
        actions: { getWorkflowRun },
        pulls: { list: listPulls, get: getPull, getReviewComment },
      };
      paginate = paginate;
    }
    return { getWorkflowRun, listPulls, getPull, getReviewComment, paginate, MockOctokit };
  },
);

vi.mock('@octokit/rest', () => ({ Octokit: MockOctokit }));

import {
  main,
  resolverOutputs,
  writeCanonicalContext,
  writeCanonicalContextFile,
} from '../index.js';
import { resolveTriggerContext } from '../resolve-trigger-context.js';

const repository = 'docker/docker-agent-action';
const sha = 'a'.repeat(40);
const pr = {
  number: 42,
  head: { sha, repo: { full_name: 'external/repo' } },
  base: { sha: 'b'.repeat(40), ref: 'main' },
  user: { login: 'external' },
};

const canonicalContext = {
  event: 'pull_request_review_comment' as const,
  runId: 123,
  runHeadSha: sha,
  actor: 'external',
  pullRequest: {
    number: 42,
    headSha: sha,
    baseSha: 'b'.repeat(40),
    baseRef: 'main',
    author: 'external',
  },
  comment: {
    id: 5,
    author: 'external',
    authorType: 'User',
    body: '@docker-agent review this',
    inReplyToId: null,
    pullRequestUrl: `https://api.github.com/repos/${repository}/pulls/42`,
    path: 'src/example.ts',
    line: 42,
    originalLine: 40,
    side: 'RIGHT',
    startLine: 41,
    startSide: 'RIGHT',
    diffHunk: '@@ -40,3 +40,5 @@',
    commitId: sha,
    originalCommitId: 'b'.repeat(40),
  },
};

describe('canonical context staging', () => {
  it('writes the canonical context in a randomized private directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'runner-temp-'));
    try {
      const first = writeCanonicalContext(canonicalContext, root);
      const second = writeCanonicalContext(canonicalContext, root);

      expect(dirname(first)).not.toBe(dirname(second));
      expect(dirname(first)).not.toBe(root);
      expect(first).toMatch(/canonical-trigger-context\.json$/);
      expect(statSync(dirname(first)).mode & 0o777).toBe(0o700);
      expect(statSync(first).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(first, 'utf8'))).toEqual(canonicalContext);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

it('creates canonical context files exclusively', () => {
  const directory = mkdtempSync(join(tmpdir(), 'canonical-context-'));
  try {
    writeCanonicalContextFile(directory, canonicalContext);
    expect(() => writeCanonicalContextFile(directory, canonicalContext)).toThrow(/EEXIST/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('requires RUNNER_TEMP for canonical context staging', () => {
  expect(() => writeCanonicalContext(canonicalContext, '')).toThrow(/RUNNER_TEMP/);
});

it('keeps canonical context staging under the supplied runner temp root', () => {
  const root = mkdtempSync(join(tmpdir(), 'runner-temp-'));
  try {
    const contextPath = writeCanonicalContext(canonicalContext, root);
    expect(contextPath.startsWith(`${root}/`)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function run(overrides: Record<string, unknown> = {}) {
  return {
    repository: { id: 1, full_name: repository },
    event: 'pull_request',
    status: 'completed',
    conclusion: 'success',
    actor: { login: 'external' },
    head_sha: sha,
    head_branch: 'feature',
    head_repository: { full_name: 'external/repo', owner: { login: 'external' } },
    pull_requests: [
      {
        number: 42,
        head: { sha },
        base: {
          repo: {
            id: 1,
            name: 'docker-agent-action',
            url: `https://api.github.com/repos/${repository}`,
          },
        },
      },
    ],
    ...overrides,
  };
}

function artifacts(files: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), 'trigger-context-'));
  for (const [name, value] of Object.entries(files)) {
    mkdirSync(join(directory, '..'), { recursive: true });
    writeFileSync(join(directory, name), value);
  }
  return directory;
}

async function resolve(directory: string) {
  return resolveTriggerContext({
    triggerRunId: '123',
    repository,
    repoToken: 'token',
    artifactDirectory: directory,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getWorkflowRun.mockResolvedValue({ data: run() });
  getPull.mockResolvedValue({ data: pr });
  listPulls.mockResolvedValue({ data: [pr] });
  paginate.mockResolvedValue([pr]);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolver entrypoint', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
  ])('does not fall back to /tmp/context or another implicit directory when TRIGGER_ARTIFACT_DIRECTORY is %s', async (_description, artifactDirectory) => {
    vi.stubEnv('GITHUB_APP_TOKEN', 'token');
    vi.stubEnv('GITHUB_TOKEN', '');
    vi.stubEnv('TRIGGER_ARTIFACT_DIRECTORY', artifactDirectory);

    await expect(main()).rejects.toThrow('TRIGGER_ARTIFACT_DIRECTORY is not set');
    expect(getWorkflowRun).not.toHaveBeenCalled();
  });
});

describe('resolveTriggerContext', () => {
  it.each([
    [
      'a threaded live review comment',
      {
        id: 5,
        author: 'external',
        authorType: 'User',
        body: '@docker-agent review this',
        inReplyToId: 1,
        pullRequestUrl: `https://api.github.com/repos/${repository}/pulls/42`,
      },
      '1',
    ],
    [
      'a top-level live review comment',
      {
        id: 5,
        author: 'external',
        authorType: 'User',
        body: '@docker-agent review this',
        inReplyToId: null,
        pullRequestUrl: `https://api.github.com/repos/${repository}/pulls/42`,
      },
      '',
    ],
    ['a comment-less pull request', null, ''],
  ])('emits only live-derived reply-parent output for %s', (_description, comment, parentOutput) => {
    const outputs = resolverOutputs({
      event: comment ? 'pull_request_review_comment' : 'pull_request',
      runId: 123,
      runHeadSha: sha,
      actor: 'external',
      pullRequest: {
        number: 42,
        headSha: sha,
        baseSha: 'b'.repeat(40),
        baseRef: 'main',
        author: 'external',
      },
      comment,
    });

    expect(outputs['comment-in-reply-to-id']).toBe(parentOutput);
    expect(outputs).not.toHaveProperty('comment-body');
    expect(outputs).not.toHaveProperty('comment-id');
    expect(outputs).not.toHaveProperty('actor');
  });

  it('rejects a workflow run from another repository before PR lookup', async () => {
    getWorkflowRun.mockResolvedValue({ data: run({ repository: { full_name: 'other/repo' } }) });
    const directory = artifacts({ 'event_name.txt': 'pull_request' });
    try {
      await expect(resolve(directory)).rejects.toThrow(/different repository/);
      expect(getPull).not.toHaveBeenCalled();
      expect(listPulls).not.toHaveBeenCalled();
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  it.each([
    ['an incomplete workflow run', { status: 'in_progress' }],
    ['an unsuccessful workflow run', { conclusion: 'failure' }],
  ])('rejects %s before PR lookup', async (_description, overrides) => {
    getWorkflowRun.mockResolvedValue({ data: run(overrides) });
    const directory = artifacts({ 'event_name.txt': 'pull_request' });
    try {
      await expect(resolve(directory)).rejects.toThrow(/did not complete successfully/);
      expect(getPull).not.toHaveBeenCalled();
      expect(listPulls).not.toHaveBeenCalled();
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  it('rejects an unsupported workflow event before PR lookup', async () => {
    getWorkflowRun.mockResolvedValue({ data: run({ event: 'push' }) });
    const directory = artifacts({ 'event_name.txt': 'push' });
    try {
      await expect(resolve(directory)).rejects.toThrow(/Unsupported workflow run event/);
      expect(getPull).not.toHaveBeenCalled();
      expect(listPulls).not.toHaveBeenCalled();
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  it('rejects a workflow run with no original actor before PR lookup', async () => {
    getWorkflowRun.mockResolvedValue({ data: run({ actor: { login: '' } }) });
    const directory = artifacts({ 'event_name.txt': 'pull_request' });
    try {
      await expect(resolve(directory)).rejects.toThrow(/no original actor/);
      expect(getPull).not.toHaveBeenCalled();
      expect(listPulls).not.toHaveBeenCalled();
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  it('rejects a workflow run with a non-immutable head SHA before PR lookup', async () => {
    getWorkflowRun.mockResolvedValue({ data: run({ head_sha: 'not-a-sha' }) });
    const directory = artifacts({ 'event_name.txt': 'pull_request' });
    try {
      await expect(resolve(directory)).rejects.toThrow(/workflow run head SHA/);
      expect(getPull).not.toHaveBeenCalled();
      expect(listPulls).not.toHaveBeenCalled();
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  it.each([
    [
      'wrong base repository',
      { base: { repo: { id: 2, name: 'repo', url: 'https://api.github.com/repos/other/repo' } } },
    ],
    [
      'malformed base repository',
      { base: { repo: { id: 2, name: 'repo', url: 'https://api.github.com/repos/other/repo' } } },
    ],
  ])('rejects associated PR metadata with a %s', async (_description, association) => {
    getWorkflowRun.mockResolvedValue({
      data: run({ pull_requests: [{ number: 42, ...association }] }),
    });
    const directory = artifacts({ 'event_name.txt': 'pull_request' });
    try {
      await expect(resolve(directory)).rejects.toThrow(/metadata does not match/);
      expect(getPull).not.toHaveBeenCalled();
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  it('selects an advanced live PR head over the workflow-run provenance SHA', async () => {
    getPull.mockResolvedValue({ data: { ...pr, head: { ...pr.head, sha: 'b'.repeat(40) } } });
    const directory = artifacts({ 'event_name.txt': 'pull_request' });
    try {
      await expect(resolve(directory)).resolves.toMatchObject({
        pullRequest: { headSha: 'b'.repeat(40) },
        headAdvanced: true,
      });
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  it('rejects a review comment whose PR differs from the workflow run association', async () => {
    getWorkflowRun.mockResolvedValue({
      data: run({
        event: 'pull_request_review_comment',
        pull_requests: [
          {
            number: 99,
            head: { sha },
            base: {
              repo: {
                id: 1,
                name: 'docker-agent-action',
                url: `https://api.github.com/repos/${repository}`,
              },
            },
          },
        ],
      }),
    });
    getReviewComment.mockResolvedValue({
      data: {
        id: 5,
        body: 'live body',
        user: { login: 'external', type: 'User' },
        pull_request_url: `https://api.github.com/repos/${repository}/pulls/42`,
      },
    });
    const directory = artifacts({
      'event_name.txt': 'pull_request_review_comment',
      'comment_id.txt': '5',
    });
    try {
      await expect(resolve(directory)).rejects.toThrow(/does not match workflow run PR/);
      expect(getPull).not.toHaveBeenCalled();
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  it('rejects malformed legacy comment JSON', async () => {
    getWorkflowRun.mockResolvedValue({
      data: run({ event: 'pull_request_review_comment', pull_requests: [] }),
    });
    const directory = artifacts({
      'event_name.txt': 'pull_request_review_comment',
      'comment.json': '{',
    });
    try {
      await expect(resolve(directory)).rejects.toThrow(/Legacy comment.json is malformed/);
      expect(getReviewComment).not.toHaveBeenCalled();
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  it('uses only trusted workflow metadata and live PR data for pull requests', async () => {
    const directory = artifacts({
      'event_name.txt': 'pull_request',
      'pr_number.txt': '999',
      'pr_head_sha.txt': 'b'.repeat(40),
      'requested_reviewer.txt': 'member',
    });
    try {
      await expect(resolve(directory)).resolves.toMatchObject({
        pullRequest: { number: 42, headSha: sha },
      });
      expect(getPull).toHaveBeenCalledWith({
        owner: 'docker',
        repo: 'docker-agent-action',
        pull_number: 42,
      });
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  it('falls back to a unique trusted head lookup when no PR is associated', async () => {
    getWorkflowRun.mockResolvedValue({ data: run({ pull_requests: [] }) });
    const directory = artifacts({ 'event_name.txt': 'pull_request' });
    try {
      await expect(resolve(directory)).resolves.toMatchObject({ pullRequest: { number: 42 } });
      expect(paginate).toHaveBeenCalledWith(
        listPulls,
        expect.objectContaining({ head: 'external:feature' }),
      );
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  it('fails closed when the fallback has zero or multiple matching PRs', async () => {
    getWorkflowRun.mockResolvedValue({ data: run({ pull_requests: [] }) });
    paginate.mockResolvedValue([pr, pr]);
    const directory = artifacts({ 'event_name.txt': 'pull_request' });
    try {
      await expect(resolve(directory)).rejects.toThrow(/ambiguous or empty/);
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  it('preserves every server-derived inline anchor in canonical review comments', async () => {
    getWorkflowRun.mockResolvedValue({
      data: run({ event: 'pull_request_review_comment', pull_requests: [] }),
    });
    getReviewComment.mockResolvedValue({
      data: {
        id: 5,
        body: '@docker-agent review this',
        in_reply_to_id: 1,
        user: { login: 'external', type: 'User' },
        pull_request_url: `https://api.github.com/repos/${repository}/pulls/42`,
        path: 'src/example.ts',
        line: 42,
        original_line: 40,
        side: 'RIGHT',
        start_line: 41,
        start_side: 'RIGHT',
        diff_hunk: '@@ -40,3 +40,5 @@',
        commit_id: sha,
        original_commit_id: 'b'.repeat(40),
      },
    });
    const directory = artifacts({
      'event_name.txt': 'pull_request_review_comment',
      'comment_id.txt': '5',
    });
    try {
      await expect(resolve(directory)).resolves.toMatchObject({
        comment: {
          path: 'src/example.ts',
          line: 42,
          originalLine: 40,
          side: 'RIGHT',
          startLine: 41,
          startSide: 'RIGHT',
          diffHunk: '@@ -40,3 +40,5 @@',
          commitId: sha,
          originalCommitId: 'b'.repeat(40),
        },
      });
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  it('binds a live review comment to the original actor, not a rerunner', async () => {
    getWorkflowRun.mockResolvedValue({
      data: run({ event: 'pull_request_review_comment', pull_requests: [] }),
    });
    getReviewComment.mockResolvedValue({
      data: {
        id: 5,
        body: '@docker-agent review this',
        in_reply_to_id: 1,
        user: { login: 'external', type: 'User' },
        pull_request_url: `https://api.github.com/repos/${repository}/pulls/42`,
      },
    });
    const directory = artifacts({
      'event_name.txt': 'pull_request_review_comment',
      'comment_id.txt': '5',
    });
    try {
      await expect(resolve(directory)).resolves.toMatchObject({
        event: 'pull_request_review_comment',
        comment: { id: 5, author: 'external', inReplyToId: 1 },
      });
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  it('supports legacy comment.json as a locator without trusting its body or author', async () => {
    getWorkflowRun.mockResolvedValue({
      data: run({ event: 'pull_request_review_comment', pull_requests: [] }),
    });
    getReviewComment.mockResolvedValue({
      data: {
        id: 5,
        body: 'live body',
        user: { login: 'external', type: 'User' },
        pull_request_url: `https://api.github.com/repos/${repository}/pulls/42`,
      },
    });
    const directory = artifacts({
      'event_name.txt': 'pull_request_review_comment',
      'comment.json': JSON.stringify({ id: 5, body: 'forged body', user: { login: 'member' } }),
    });
    try {
      await expect(resolve(directory)).resolves.toMatchObject({
        comment: { body: 'live body', author: 'external' },
      });
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  it.each([
    ['a malformed run ID', { triggerRunId: 'bad' }],
    ['an artifact event mismatch', {}],
  ])('fails closed on %s', async (_description, overrides) => {
    const directory = artifacts({ 'event_name.txt': 'pull_request_review_comment' });
    try {
      await expect(
        resolveTriggerContext({
          triggerRunId: '123',
          repository,
          repoToken: 'token',
          artifactDirectory: directory,
          ...overrides,
        }),
      ).rejects.toThrow();
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  it('rejects forged actor, cross-repository comment URLs, and malformed comment IDs', async () => {
    getWorkflowRun.mockResolvedValue({
      data: run({ event: 'pull_request_review_comment', pull_requests: [] }),
    });
    getReviewComment.mockResolvedValue({
      data: {
        id: 5,
        body: '',
        user: { login: 'member', type: 'User' },
        pull_request_url: 'https://api.github.com/repos/other/repo/pulls/42',
      },
    });
    const directory = artifacts({
      'event_name.txt': 'pull_request_review_comment',
      'comment_id.txt': 'not-a-number',
    });
    try {
      await expect(resolve(directory)).rejects.toThrow(/comment ID/);
      writeFileSync(join(directory, 'comment_id.txt'), '5');
      await expect(resolve(directory)).rejects.toThrow(/author/);
    } finally {
      rmSync(directory, { recursive: true });
    }
  });
});
