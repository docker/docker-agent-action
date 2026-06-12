// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';

vi.mock('@actions/core');

const { mockGetPull, MockOctokit } = vi.hoisted(() => {
  const mockGetPull = vi.fn().mockResolvedValue({
    data: {
      title: 'Fix the bug',
      body: 'This PR fixes the bug.',
      user: { login: 'pr-author' },
      base: { ref: 'main' },
    },
  });

  class MockOctokit {
    rest = { pulls: { get: mockGetPull } };
  }

  return { mockGetPull, MockOctokit };
});

vi.mock('@octokit/rest', () => ({ Octokit: MockOctokit }));

import { getPrMeta } from '../index.js';

const TOKEN = 'fake-token';
const OWNER = 'docker';
const REPO = 'myrepo';
const PR_NUMBER = 42;

describe('getPrMeta', () => {
  it('calls the pulls API with the correct parameters', async () => {
    await getPrMeta(TOKEN, OWNER, REPO, PR_NUMBER);

    expect(mockGetPull).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      pull_number: PR_NUMBER,
    });
  });

  it('maps the API response to a PrMeta object', async () => {
    const meta = await getPrMeta(TOKEN, OWNER, REPO, PR_NUMBER);

    expect(meta).toEqual({
      title: 'Fix the bug',
      body: 'This PR fixes the bug.',
      authorLogin: 'pr-author',
      baseRefName: 'main',
    });
  });

  it('falls back to "No description provided." when body is null', async () => {
    mockGetPull.mockResolvedValueOnce({
      data: { title: 'Empty PR', body: null, user: { login: 'alice' }, base: { ref: 'main' } },
    });

    const meta = await getPrMeta(TOKEN, OWNER, REPO, PR_NUMBER);

    expect(meta.body).toBe('No description provided.');
  });

  it('falls back to "unknown" when user is null', async () => {
    mockGetPull.mockResolvedValueOnce({
      data: { title: 'Bot PR', body: 'body', user: null, base: { ref: 'main' } },
    });

    const meta = await getPrMeta(TOKEN, OWNER, REPO, PR_NUMBER);

    expect(meta.authorLogin).toBe('unknown');
  });

  it('propagates API errors to the caller', async () => {
    mockGetPull.mockRejectedValueOnce(new Error('Not Found'));

    await expect(getPrMeta(TOKEN, OWNER, REPO, PR_NUMBER)).rejects.toThrow('Not Found');
  });
});
