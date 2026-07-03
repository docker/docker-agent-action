// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the incremental-review CLI wiring (main with injected deps).
 *
 * These pin the file effects and the fail-open contract: pr.diff is rewritten
 * only on the happy path (with the full diff preserved), and every error path
 * reports mode=full with the full diff left in pr.diff — restored from the
 * preserved copy when the rewrite had already started.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '@actions/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@actions/core');

// Passthrough fs mock: writeFileSync leaves a truncated file and throws when
// targeting failWriteAt, simulating a mid-write failure (e.g. disk full).
const fsControl = vi.hoisted(() => ({ failWriteAt: '' }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const writeFileSync: typeof actual.writeFileSync = (file, data, options) => {
    if (fsControl.failWriteAt !== '' && file === fsControl.failWriteAt) {
      actual.writeFileSync(file, '<truncated>', 'utf-8');
      throw new Error('ENOSPC: no space left on device, write');
    }
    actual.writeFileSync(file, data, options);
  };
  return { ...actual, writeFileSync };
});

import type { GitResult, ReviewLike } from '../incremental-review.js';
import { fullDiffPath, main } from '../index.js';

const SHA_A = 'a'.repeat(40);
const HEAD_SHA = 'c'.repeat(40);
const MERGE_BASE = 'd'.repeat(40);

const FULL_DIFF = [
  'diff --git a/src/kept.ts b/src/kept.ts',
  '--- a/src/kept.ts',
  '+++ b/src/kept.ts',
  '@@ -1,2 +1,3 @@',
  ' line1',
  '+added-in-old-commit',
  ' line2',
  'diff --git a/src/new.ts b/src/new.ts',
  '--- a/src/new.ts',
  '+++ b/src/new.ts',
  '@@ -1 +1,2 @@',
  ' base',
  '+added-in-new-commit',
  '',
].join('\n');

const INCREMENTAL_DIFF = [
  'diff --git a/src/new.ts b/src/new.ts',
  '--- a/src/new.ts',
  '+++ b/src/new.ts',
  '@@ -1 +1,2 @@',
  ' base',
  '+added-in-new-commit',
  'diff --git a/src/net-zero.ts b/src/net-zero.ts',
  '--- a/src/net-zero.ts',
  '+++ b/src/net-zero.ts',
  '@@ -1 +1 @@',
  '-x',
  '+x2',
  '',
].join('\n');

function completedReview(): ReviewLike {
  return {
    user: { login: 'docker-agent' },
    body: '### Assessment: 🟢 APPROVE',
    commit_id: SHA_A,
    submitted_at: '2026-01-01T10:00:00Z',
  };
}

/** Fake git that answers the happy-path plan and writes the incremental diff. */
function fakeGit(incrementalDiff: string) {
  return (args: string[]): GitResult => {
    const cmd = args.join(' ');
    if (cmd === 'rev-parse HEAD') return { ok: true, stdout: `${HEAD_SHA}\n` };
    if (cmd === `cat-file -e ${SHA_A}^{commit}`) return { ok: true, stdout: '' };
    if (cmd === `merge-base --is-ancestor ${SHA_A} HEAD`) return { ok: true, stdout: '' };
    if (cmd.startsWith('merge-base origin/main')) return { ok: true, stdout: `${MERGE_BASE}\n` };
    if (args[0] === 'diff') {
      const outputArg = args.find((a) => a.startsWith('--output='));
      if (outputArg) writeFileSync(outputArg.slice('--output='.length), incrementalDiff, 'utf-8');
      return { ok: true, stdout: '' };
    }
    return { ok: false, stdout: '' };
  };
}

function outputsByName(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [name, value] of vi.mocked(core.setOutput).mock.calls) {
    map[String(name)] = String(value);
  }
  return map;
}

describe('incremental-review main', () => {
  let dir: string;
  let diffPath: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    fsControl.failWriteAt = '';
    dir = mkdtempSync(join(tmpdir(), 'incremental-review-test-'));
    diffPath = join(dir, 'pr.diff');
    writeFileSync(diffPath, FULL_DIFF, 'utf-8');
    process.env.GITHUB_TOKEN = 'tok';
    process.env.GITHUB_REPOSITORY = 'docker/repo';
    process.env.PR_NUMBER = '7';
    process.env.BASE_REF = 'main';
    delete process.env.INCREMENTAL;
    delete process.env.REVIEW_BOT_LOGIN;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.env = { ...savedEnv };
  });

  it('rewrites pr.diff with the restricted incremental diff and preserves the full diff', async () => {
    await main(diffPath, {
      git: fakeGit(INCREMENTAL_DIFF),
      fetchReviews: async () => [completedReview()],
    });

    const outputs = outputsByName();
    expect(outputs.mode).toBe('incremental');
    expect(outputs.reason).toBe('ok');
    expect(outputs['last-reviewed-sha']).toBe(SHA_A);

    const rewritten = readFileSync(diffPath, 'utf-8');
    expect(rewritten).toContain('src/new.ts');
    // net-zero.ts is not in the full PR diff — restricted out.
    expect(rewritten).not.toContain('src/net-zero.ts');
    expect(readFileSync(fullDiffPath(diffPath), 'utf-8')).toBe(FULL_DIFF);
  });

  it('reports full/disabled without any API or git calls when INCREMENTAL=false', async () => {
    process.env.INCREMENTAL = 'false';
    const git = vi.fn();
    const fetchReviews = vi.fn();

    await main(diffPath, { git, fetchReviews });

    expect(outputsByName()).toMatchObject({ mode: 'full', reason: 'disabled' });
    expect(git).not.toHaveBeenCalled();
    expect(fetchReviews).not.toHaveBeenCalled();
    expect(readFileSync(diffPath, 'utf-8')).toBe(FULL_DIFF);
  });

  it('reports full/no-previous-review and leaves the diff untouched', async () => {
    await main(diffPath, {
      git: fakeGit(INCREMENTAL_DIFF),
      fetchReviews: async () => [],
    });

    expect(outputsByName()).toMatchObject({ mode: 'full', reason: 'no-previous-review' });
    expect(readFileSync(diffPath, 'utf-8')).toBe(FULL_DIFF);
  });

  it('fails open to a full review when the reviews API errors', async () => {
    await main(diffPath, {
      git: fakeGit(INCREMENTAL_DIFF),
      fetchReviews: async () => {
        throw new Error('boom');
      },
    });

    expect(outputsByName()).toMatchObject({ mode: 'full', reason: 'error' });
    expect(vi.mocked(core.warning)).toHaveBeenCalledWith(expect.stringContaining('boom'));
    expect(readFileSync(diffPath, 'utf-8')).toBe(FULL_DIFF);
  });

  it('fails open when token or PR number is missing', async () => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    await main(diffPath, { git: fakeGit(INCREMENTAL_DIFF), fetchReviews: async () => [] });
    expect(outputsByName()).toMatchObject({ mode: 'full', reason: 'error' });
  });

  it('reports full/no-diff when the diff file does not exist', async () => {
    rmSync(diffPath);
    await main(diffPath, {
      git: fakeGit(INCREMENTAL_DIFF),
      fetchReviews: async () => [completedReview()],
    });
    expect(outputsByName()).toMatchObject({ mode: 'full', reason: 'no-diff' });
  });

  it('falls back to full when the incremental diff is net-zero against the PR diff', async () => {
    const netZeroOnly = [
      'diff --git a/src/net-zero.ts b/src/net-zero.ts',
      '--- a/src/net-zero.ts',
      '+++ b/src/net-zero.ts',
      '@@ -1 +1 @@',
      '-x',
      '+x2',
      '',
    ].join('\n');

    await main(diffPath, {
      git: fakeGit(netZeroOnly),
      fetchReviews: async () => [completedReview()],
    });

    expect(outputsByName()).toMatchObject({ mode: 'full', reason: 'net-zero-changes' });
    expect(readFileSync(diffPath, 'utf-8')).toBe(FULL_DIFF);
  });

  it('fails open to full when git diff itself fails', async () => {
    const git = (args: string[]): GitResult => {
      if (args[0] === 'diff') return { ok: false, stdout: '' };
      return fakeGit('')(args);
    };

    await main(diffPath, { git, fetchReviews: async () => [completedReview()] });

    expect(outputsByName()).toMatchObject({ mode: 'full', reason: 'error' });
    expect(readFileSync(diffPath, 'utf-8')).toBe(FULL_DIFF);
  });

  it('restores pr.diff from the preserved copy when the incremental rewrite fails', async () => {
    fsControl.failWriteAt = diffPath;

    await main(diffPath, {
      git: fakeGit(INCREMENTAL_DIFF),
      fetchReviews: async () => [completedReview()],
    });

    const outputs = outputsByName();
    expect(outputs.mode).toBe('full');
    expect(outputs.reason).toBe('error');
    expect(outputs['last-reviewed-sha']).toBe(SHA_A);
    expect(vi.mocked(core.warning)).toHaveBeenCalledWith(expect.stringContaining('ENOSPC'));

    // pr.diff must be intact and the preserved copy gone, so downstream steps
    // see a plain full-review state.
    expect(readFileSync(diffPath, 'utf-8')).toBe(FULL_DIFF);
    expect(existsSync(fullDiffPath(diffPath))).toBe(false);
  });
});

describe('fullDiffPath', () => {
  it('inserts _full before the .diff extension', () => {
    expect(fullDiffPath('pr.diff')).toBe('pr_full.diff');
    expect(fullDiffPath('/work/pr.diff')).toBe('/work/pr_full.diff');
  });

  it('appends _full when there is no .diff extension', () => {
    expect(fullDiffPath('prdiff')).toBe('prdiff_full');
  });
});
