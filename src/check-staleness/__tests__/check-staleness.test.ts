// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@actions/core');

const { mockGetPull, MockOctokit, constructorTokens } = vi.hoisted(() => {
  const mockGetPull = vi.fn();
  const constructorTokens: string[] = [];
  class MockOctokit {
    constructor({ auth }: { auth: string }) {
      constructorTokens.push(auth);
    }
    rest = { pulls: { get: mockGetPull } };
  }
  return { mockGetPull, MockOctokit, constructorTokens };
});

vi.mock('@octokit/rest', () => ({ Octokit: MockOctokit }));

import { checkStaleness } from '../index.js';

beforeEach(() => {
  vi.clearAllMocks();
  constructorTokens.length = 0;
});

const opts = { owner: 'docker', repo: 'repo', prNumber: 9 };

describe('checkStaleness', () => {
  it('flags stale when the requested SHA differs from current head', async () => {
    mockGetPull.mockResolvedValueOnce({ data: { head: { sha: 'newsha111' } } });

    const r = await checkStaleness('tok', { ...opts, requestedSha: 'oldsha000' });

    expect(r).toEqual({ requestedSha: 'oldsha000', currentSha: 'newsha111', stale: true });
    expect(mockGetPull).toHaveBeenCalledWith({ owner: 'docker', repo: 'repo', pull_number: 9 });
    expect(constructorTokens).toEqual(['tok']);
  });

  it('is not stale when the requested SHA matches current head', async () => {
    mockGetPull.mockResolvedValueOnce({ data: { head: { sha: 'samesha' } } });
    const r = await checkStaleness('tok', { ...opts, requestedSha: 'samesha' });
    expect(r.stale).toBe(false);
  });

  it('is not stale (fail-open) when the requested SHA is empty', async () => {
    mockGetPull.mockResolvedValueOnce({ data: { head: { sha: 'newsha' } } });
    const r = await checkStaleness('tok', { ...opts, requestedSha: '' });
    expect(r).toEqual({ requestedSha: '', currentSha: 'newsha', stale: false });
  });

  it('trims surrounding whitespace on the requested SHA before comparing', async () => {
    mockGetPull.mockResolvedValueOnce({ data: { head: { sha: 'abc' } } });
    const r = await checkStaleness('tok', { ...opts, requestedSha: '  abc \n' });
    expect(r.stale).toBe(false);
    expect(r.requestedSha).toBe('abc');
  });

  it('is not stale when current head is unknown (missing head.sha)', async () => {
    mockGetPull.mockResolvedValueOnce({ data: { head: {} } });
    const r = await checkStaleness('tok', { ...opts, requestedSha: 'oldsha' });
    expect(r.currentSha).toBe('');
    expect(r.stale).toBe(false);
  });

  it('propagates API errors to the caller', async () => {
    mockGetPull.mockRejectedValueOnce(Object.assign(new Error('Not Found'), { status: 404 }));
    await expect(checkStaleness('tok', { ...opts, requestedSha: 'x' })).rejects.toThrow(
      'Not Found',
    );
  });
});
