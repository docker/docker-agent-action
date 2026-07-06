// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the incremental-review core logic.
 *
 * These pin the three safety-critical behaviors:
 *   - findLastReviewedSha only trusts completed docker-agent reviews;
 *   - planIncrementalReview falls back to a full review on every ambiguous
 *     git state (force-push, rebase, merged base, missing objects);
 *   - restrictDiffToFiles never lets the incremental diff reference a file
 *     outside the full PR diff (which would 422 on inline comments).
 */
import { describe, expect, it } from 'vitest';
import {
  findLastReviewedSha,
  type GitResult,
  listDiffFiles,
  planIncrementalReview,
  type ReviewLike,
  restrictDiffToFiles,
} from '../incremental-review.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const HEAD_SHA = 'c'.repeat(40);

function review(overrides: Partial<ReviewLike> = {}): ReviewLike {
  return {
    user: { login: 'docker-agent' },
    body: '### Assessment: 🟢 APPROVE',
    commit_id: SHA_A,
    submitted_at: '2026-01-01T10:00:00Z',
    ...overrides,
  };
}

describe('findLastReviewedSha', () => {
  it('returns the SHA of the only completed bot review', () => {
    expect(findLastReviewedSha([review()])).toBe(SHA_A);
  });

  it('returns the newest completed review when several exist', () => {
    const reviews = [
      review({ commit_id: SHA_A, submitted_at: '2026-01-01T10:00:00Z' }),
      review({ commit_id: SHA_B, submitted_at: '2026-01-02T10:00:00Z' }),
    ];
    expect(findLastReviewedSha(reviews)).toBe(SHA_B);
  });

  it('prefers the later list entry on equal timestamps (API returns oldest-first)', () => {
    const reviews = [review({ commit_id: SHA_A }), review({ commit_id: SHA_B })];
    expect(findLastReviewedSha(reviews)).toBe(SHA_B);
  });

  it('ignores the incomplete-run fallback review (agent exited 0 without posting)', () => {
    const body = '⚠️ **Review did not complete** — the agent finished without posting a review.';
    expect(findLastReviewedSha([review({ body })])).toBeNull();
  });

  it('ignores the legacy LGTM fallback review (never a completed run)', () => {
    expect(findLastReviewedSha([review({ body: '🟢 **No issues found** — LGTM!' })])).toBeNull();
  });

  it('accepts the GitHub App bot login variant', () => {
    expect(findLastReviewedSha([review({ user: { login: 'docker-agent[bot]' } })])).toBe(SHA_A);
  });

  it('ignores reviews from other users even with a matching body', () => {
    expect(findLastReviewedSha([review({ user: { login: 'alice' } })])).toBeNull();
  });

  it('ignores timeout and failure fallback reviews (commits stay unreviewed)', () => {
    const reviews = [
      review({ body: '⏱️ **PR Review Timed Out** — retry.' }),
      review({ body: '❌ **PR Review Failed** — logs.' }),
    ];
    expect(findLastReviewedSha(reviews)).toBeNull();
  });

  it('ignores reviews with a malformed or missing commit_id', () => {
    expect(findLastReviewedSha([review({ commit_id: 'deadbeef' })])).toBeNull();
    expect(findLastReviewedSha([review({ commit_id: null })])).toBeNull();
  });

  it('ignores reviews without a parseable submitted_at', () => {
    expect(findLastReviewedSha([review({ submitted_at: null })])).toBeNull();
    expect(findLastReviewedSha([review({ submitted_at: 'not-a-date' })])).toBeNull();
  });

  it('returns null for an empty review list', () => {
    expect(findLastReviewedSha([])).toBeNull();
  });

  it('respects a custom bot login', () => {
    expect(findLastReviewedSha([review({ user: { login: 'my-bot' } })], 'my-bot')).toBe(SHA_A);
    expect(findLastReviewedSha([review()], 'my-bot')).toBeNull();
  });
});

describe('planIncrementalReview', () => {
  /**
   * Build a fake git runner from a command→result table. Commands are keyed by
   * their joined argv; unlisted commands fail.
   */
  function fakeGit(table: Record<string, GitResult>) {
    return (args: string[]): GitResult => table[args.join(' ')] ?? { ok: false, stdout: '' };
  }

  const MERGE_BASE = 'd'.repeat(40);

  function happyTable(): Record<string, GitResult> {
    return {
      'rev-parse HEAD': { ok: true, stdout: `${HEAD_SHA}\n` },
      [`cat-file -e ${SHA_A}^{commit}`]: { ok: true, stdout: '' },
      [`merge-base --is-ancestor ${SHA_A} HEAD`]: { ok: true, stdout: '' },
      [`merge-base origin/main ${SHA_A}`]: { ok: true, stdout: `${MERGE_BASE}\n` },
      'merge-base origin/main HEAD': { ok: true, stdout: `${MERGE_BASE}\n` },
    };
  }

  it('plans an incremental review when the last SHA is a clean ancestor', () => {
    const plan = planIncrementalReview({
      lastReviewedSha: SHA_A,
      baseRef: 'main',
      git: fakeGit(happyTable()),
    });
    expect(plan).toEqual({
      mode: 'incremental',
      reason: 'ok',
      lastReviewedSha: SHA_A,
      headSha: HEAD_SHA,
    });
  });

  it('falls back when there is no previous review', () => {
    const plan = planIncrementalReview({
      lastReviewedSha: null,
      baseRef: 'main',
      git: fakeGit({}),
    });
    expect(plan.mode).toBe('full');
    expect(plan.reason).toBe('no-previous-review');
  });

  it('falls back when HEAD is the last reviewed commit (explicit re-request)', () => {
    const table = happyTable();
    table['rev-parse HEAD'] = { ok: true, stdout: `${SHA_A}\n` };
    const plan = planIncrementalReview({
      lastReviewedSha: SHA_A,
      baseRef: 'main',
      git: fakeGit(table),
    });
    expect(plan.mode).toBe('full');
    expect(plan.reason).toBe('no-new-commits');
  });

  it('falls back when the last reviewed SHA is not in the local clone (force-push)', () => {
    const table = happyTable();
    delete table[`cat-file -e ${SHA_A}^{commit}`];
    const plan = planIncrementalReview({
      lastReviewedSha: SHA_A,
      baseRef: 'main',
      git: fakeGit(table),
    });
    expect(plan.mode).toBe('full');
    expect(plan.reason).toBe('unknown-sha');
  });

  it('falls back when the last reviewed SHA is not an ancestor of HEAD (rebase)', () => {
    const table = happyTable();
    table[`merge-base --is-ancestor ${SHA_A} HEAD`] = { ok: false, stdout: '' };
    const plan = planIncrementalReview({
      lastReviewedSha: SHA_A,
      baseRef: 'main',
      git: fakeGit(table),
    });
    expect(plan.mode).toBe('full');
    expect(plan.reason).toBe('history-rewritten');
  });

  it('falls back when the base branch was merged into the PR after the last review', () => {
    const table = happyTable();
    table['merge-base origin/main HEAD'] = { ok: true, stdout: `${'e'.repeat(40)}\n` };
    const plan = planIncrementalReview({
      lastReviewedSha: SHA_A,
      baseRef: 'main',
      git: fakeGit(table),
    });
    expect(plan.mode).toBe('full');
    expect(plan.reason).toBe('base-merged-in');
  });

  it('falls back when the base ref is empty or cannot be resolved', () => {
    const empty = planIncrementalReview({
      lastReviewedSha: SHA_A,
      baseRef: '',
      git: fakeGit(happyTable()),
    });
    expect(empty.mode).toBe('full');
    expect(empty.reason).toBe('base-unresolved');

    const table = happyTable();
    delete table['merge-base origin/main HEAD'];
    const unresolved = planIncrementalReview({
      lastReviewedSha: SHA_A,
      baseRef: 'main',
      git: fakeGit(table),
    });
    expect(unresolved.mode).toBe('full');
    expect(unresolved.reason).toBe('base-unresolved');
  });

  it('rejects a base ref that could be parsed as a git option', () => {
    const plan = planIncrementalReview({
      lastReviewedSha: SHA_A,
      baseRef: '--upload-pack=evil',
      git: fakeGit(happyTable()),
    });
    expect(plan.mode).toBe('full');
    expect(plan.reason).toBe('base-unresolved');
  });

  it('falls back when HEAD cannot be resolved', () => {
    const table = happyTable();
    table['rev-parse HEAD'] = { ok: false, stdout: '' };
    const plan = planIncrementalReview({
      lastReviewedSha: SHA_A,
      baseRef: 'main',
      git: fakeGit(table),
    });
    expect(plan.mode).toBe('full');
    expect(plan.reason).toBe('error');
  });
});

const DIFF = [
  'diff --git a/src/kept.ts b/src/kept.ts',
  'index 111..222 100644',
  '--- a/src/kept.ts',
  '+++ b/src/kept.ts',
  '@@ -1,2 +1,3 @@',
  ' line1',
  '+added',
  ' line2',
  'diff --git a/src/dropped.ts b/src/dropped.ts',
  'index 333..444 100644',
  '--- a/src/dropped.ts',
  '+++ b/src/dropped.ts',
  '@@ -1 +1 @@',
  '-old',
  '+new',
  '',
].join('\n');

describe('listDiffFiles', () => {
  it('collects paths from ---/+++ lines', () => {
    expect(listDiffFiles(DIFF)).toEqual(new Set(['src/kept.ts', 'src/dropped.ts']));
  });

  it('collects deletion paths (only --- a/ carries the real path)', () => {
    const deletion = [
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
    ].join('\n');
    expect(listDiffFiles(deletion)).toEqual(new Set(['gone.ts']));
  });

  it('collects both sides of a pure rename', () => {
    const rename = [
      'diff --git a/old-name.ts b/new-name.ts',
      'similarity index 100%',
      'rename from old-name.ts',
      'rename to new-name.ts',
    ].join('\n');
    expect(listDiffFiles(rename)).toEqual(new Set(['old-name.ts', 'new-name.ts']));
  });

  it('returns an empty set for an empty diff', () => {
    expect(listDiffFiles('')).toEqual(new Set());
  });
});

describe('restrictDiffToFiles', () => {
  it('keeps only sections whose file is in the allowed set', () => {
    const result = restrictDiffToFiles(DIFF, new Set(['src/kept.ts']));
    expect(result.keptFiles).toBe(1);
    expect(result.droppedFiles).toEqual(['src/dropped.ts']);
    expect(result.restricted).toContain('diff --git a/src/kept.ts b/src/kept.ts');
    expect(result.restricted).not.toContain('src/dropped.ts');
  });

  it('keeps everything when all files are allowed', () => {
    const result = restrictDiffToFiles(DIFF, new Set(['src/kept.ts', 'src/dropped.ts']));
    expect(result.keptFiles).toBe(2);
    expect(result.droppedFiles).toEqual([]);
    expect(result.restricted).toBe(DIFF);
  });

  it('drops everything when nothing is allowed', () => {
    const result = restrictDiffToFiles(DIFF, new Set());
    expect(result.keptFiles).toBe(0);
    expect(result.droppedFiles).toEqual(['src/kept.ts', 'src/dropped.ts']);
  });

  it('keeps a renamed section when either side is allowed', () => {
    const rename = [
      'diff --git a/old-name.ts b/new-name.ts',
      'similarity index 100%',
      'rename from old-name.ts',
      'rename to new-name.ts',
    ].join('\n');
    const result = restrictDiffToFiles(rename, new Set(['new-name.ts']));
    expect(result.keptFiles).toBe(1);
  });

  it('handles an empty diff', () => {
    expect(restrictDiffToFiles('', new Set(['a.ts']))).toEqual({
      restricted: '',
      keptFiles: 0,
      droppedFiles: [],
    });
  });
});
