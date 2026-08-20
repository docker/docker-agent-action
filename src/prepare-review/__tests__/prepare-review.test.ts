// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { execFileSync, getPull, MockOctokit } = vi.hoisted(() => {
  const execFileSync = vi.fn();
  const getPull = vi.fn();
  class MockOctokit {
    rest = { pulls: { get: getPull } };
  }
  return { execFileSync, getPull, MockOctokit };
});

vi.mock('node:child_process', () => ({ execFileSync }));
vi.mock('@octokit/rest', () => ({ Octokit: MockOctokit }));

import { GIT_OUTPUT_MAX_BUFFER, prepareReview } from '../prepare-review.js';

const liveHead = 'a'.repeat(40);
const liveBase = 'b'.repeat(40);
const selectedHead = 'c'.repeat(40);
const selectedBase = 'd'.repeat(40);
const workspaces: string[] = [];

function workspace(): string {
  const value = mkdtempSync(join(tmpdir(), 'prepare-review-'));
  workspaces.push(value);
  return value;
}

function configurePull(): void {
  getPull.mockResolvedValue({
    data: {
      head: { sha: liveHead, ref: 'feature' },
      base: { sha: liveBase, ref: 'main' },
      title: 'Review this',
      body: 'Description',
      user: { login: 'contributor' },
    },
  });
}

function configureGit(existing = new Set<string>()): void {
  execFileSync.mockImplementation((_command: string, args: string[]) => {
    if (args[0] === 'cat-file') {
      const sha = args[2]?.replace('^{commit}', '') ?? '';
      if (!existing.has(sha)) throw new Error('missing object');
      return '';
    }
    if (args[0] === 'fetch') {
      existing.add(args[3] ?? '');
      return '';
    }
    if (args[0] === 'checkout') return '';
    if (args[0] === 'diff' && args[1] === '--binary') return 'diff --git a/file.ts b/file.ts\n';
    if (args[0] === 'diff' && args[1] === '--name-only') return 'file.ts\n';
    throw new Error(`Unexpected git invocation: ${args.join(' ')}`);
  });
}

function inputs(overrides: Partial<Parameters<typeof prepareReview>[0]> = {}) {
  return {
    repository: 'docker/docker-agent-action',
    pullNumber: '42',
    githubToken: 'token',
    workspace: workspace(),
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  while (workspaces.length) rmSync(workspaces.pop() as string, { recursive: true, force: true });
});

describe('prepareReview', () => {
  it('checks out and diffs the explicit immutable commit pair', async () => {
    configurePull();
    configureGit(new Set([selectedBase, selectedHead]));
    const request = inputs({ headSha: selectedHead, baseSha: selectedBase });

    await expect(prepareReview(request)).resolves.toMatchObject({
      headSha: selectedHead,
      baseSha: selectedBase,
      changedFiles: 1,
    });

    expect(execFileSync).toHaveBeenCalledWith(
      'git',
      ['checkout', '--detach', selectedHead],
      expect.objectContaining({ cwd: request.workspace }),
    );
    expect(execFileSync).toHaveBeenCalledWith(
      'git',
      ['diff', '--binary', `${selectedBase}...${selectedHead}`],
      expect.objectContaining({ maxBuffer: GIT_OUTPUT_MAX_BUFFER }),
    );
    expect(execFileSync).toHaveBeenCalledWith(
      'git',
      ['diff', '--name-only', `${selectedBase}...${selectedHead}`],
      expect.objectContaining({ maxBuffer: GIT_OUTPUT_MAX_BUFFER }),
    );
    expect(readFileSync(join(request.workspace, 'pr.diff'), 'utf8')).toContain('diff --git');
    expect(readFileSync(join(request.workspace, 'changed_files.txt'), 'utf8')).toBe('file.ts\n');
    expect(JSON.parse(readFileSync(join(request.workspace, 'pr_metadata.json'), 'utf8'))).toEqual({
      title: 'Review this',
      body: 'Description',
      author: { login: 'contributor' },
      baseRefName: 'main',
      headRefName: 'feature',
    });
  });

  it('uses the current API commits only when neither immutable SHA is supplied', async () => {
    configurePull();
    configureGit(new Set([liveBase, liveHead]));

    await expect(prepareReview(inputs())).resolves.toMatchObject({
      headSha: liveHead,
      baseSha: liveBase,
    });
    expect(execFileSync).toHaveBeenCalledWith(
      'git',
      ['diff', '--binary', `${liveBase}...${liveHead}`],
      expect.any(Object),
    );
  });

  it.each([
    { headSha: selectedHead },
    { baseSha: selectedBase },
  ])('rejects an incomplete immutable SHA pair', async (shaInputs) => {
    await expect(prepareReview(inputs(shaInputs))).rejects.toThrow(
      'pr-head-sha and pr-base-sha must be provided together',
    );
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('validates immutable SHA inputs before using Git', async () => {
    await expect(
      prepareReview(inputs({ headSha: 'not-a-sha', baseSha: selectedBase })),
    ).rejects.toThrow("Invalid pr-head-sha: 'not-a-sha'");
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('fetches unavailable selected commits by their immutable SHA', async () => {
    configurePull();
    configureGit();

    await prepareReview(inputs({ headSha: selectedHead, baseSha: selectedBase }));

    expect(execFileSync).toHaveBeenCalledWith(
      'git',
      ['fetch', '--no-tags', 'origin', selectedBase],
      expect.any(Object),
    );
    expect(execFileSync).toHaveBeenCalledWith(
      'git',
      ['fetch', '--no-tags', 'origin', selectedHead],
      expect.any(Object),
    );
  });

  it('preserves Git failure context for immutable diff errors', async () => {
    configurePull();
    configureGit(new Set([selectedBase, selectedHead]));
    const failure = new Error('stdout maxBuffer length exceeded');
    execFileSync.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === 'diff' && args[1] === '--binary') throw failure;
      if (args[0] === 'cat-file' || args[0] === 'checkout') return '';
      throw new Error(`Unexpected git invocation: ${args.join(' ')}`);
    });

    await expect(
      prepareReview(inputs({ headSha: selectedHead, baseSha: selectedBase })),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        `Git diff --binary ${selectedBase}...${selectedHead} failed`,
      );
      expect((error as Error).message).not.toContain('Unable to obtain the selected Git object');
      expect((error as Error & { cause?: unknown }).cause).toBe(failure);
      return true;
    });
  });

  it('fails closed when an unavailable commit cannot be fetched', async () => {
    configurePull();
    execFileSync.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === 'cat-file' || args[0] === 'fetch') throw new Error('unavailable');
      return '';
    });

    await expect(
      prepareReview(inputs({ headSha: selectedHead, baseSha: selectedBase })),
    ).rejects.toThrow(`Selected commit ${selectedBase} is unavailable`);
  });
});
