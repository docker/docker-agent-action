// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const getPull = vi.hoisted(() => vi.fn());

vi.mock('@octokit/rest', () => ({
  Octokit: class {
    rest = { pulls: { get: getPull } };
  },
}));

import { prepareReview } from '../prepare-review.js';

const directories: string[] = [];

function git(directory: string, args: string[]): string {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8' });
}

function createRepository(): { directory: string; baseSha: string; headSha: string } {
  const directory = mkdtempSync(join(tmpdir(), 'prepare-review-integration-'));
  directories.push(directory);
  git(directory, ['init']);
  git(directory, ['config', 'user.email', 'test@example.com']);
  git(directory, ['config', 'user.name', 'Test User']);
  writeFileSync(join(directory, 'large.bin'), Buffer.alloc(32));
  git(directory, ['add', 'large.bin']);
  git(directory, ['commit', '-m', 'base']);
  const baseSha = git(directory, ['rev-parse', 'HEAD']).trim();
  writeFileSync(join(directory, 'large.bin'), randomBytes(1024 * 1024 + 64 * 1024));
  git(directory, ['add', 'large.bin']);
  git(directory, ['commit', '-m', 'large binary change']);
  const headSha = git(directory, ['rev-parse', 'HEAD']).trim();
  return { directory, baseSha, headSha };
}

afterEach(() => {
  vi.clearAllMocks();
  while (directories.length) rmSync(directories.pop() as string, { recursive: true, force: true });
});

describe('prepareReview integration', () => {
  it('writes an immutable binary diff larger than one MiB', async () => {
    const { directory, baseSha, headSha } = createRepository();
    getPull.mockResolvedValue({
      data: {
        head: { sha: headSha, ref: 'feature' },
        base: { sha: baseSha, ref: 'main' },
        title: 'Large binary diff',
        body: null,
        user: { login: 'contributor' },
      },
    });

    await expect(
      prepareReview({
        repository: 'docker/docker-agent-action',
        pullNumber: '42',
        githubToken: 'token',
        workspace: directory,
        headSha,
        baseSha,
      }),
    ).resolves.toMatchObject({ headSha, baseSha, changedFiles: 1 });

    expect(readFileSync(join(directory, 'pr.diff')).byteLength).toBeGreaterThan(1024 * 1024);
    expect(readFileSync(join(directory, 'changed_files.txt'), 'utf8')).toBe('large.bin\n');
    expect(JSON.parse(readFileSync(join(directory, 'pr_metadata.json'), 'utf8'))).toEqual({
      title: 'Large binary diff',
      body: '',
      author: { login: 'contributor' },
      baseRefName: 'main',
      headRefName: 'feature',
    });
  });
});
