// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the dedupe-findings matching logic.
 *
 * These pin the contract that duplicates are dropped only on a triple match
 * (path + line proximity + signature similarity) and that human comments and
 * bot replies never suppress a finding.
 */
import { describe, expect, it } from 'vitest';
import {
  dedupeComments,
  type ExistingComment,
  findingSignature,
  type NewComment,
  signatureSimilarity,
} from '../dedupe-findings.js';

const MARKER = '<!-- docker-agent-review -->';
const LEGACY_MARKER = '<!-- cagent-review -->';
const REPLY_MARKER = '<!-- docker-agent-review-reply -->';

function existing(overrides: Partial<ExistingComment> = {}): ExistingComment {
  return {
    path: 'src/app.ts',
    line: 42,
    body: `**[high] Nil pointer dereference on user object**\n\ndetails\n\n${MARKER}`,
    ...overrides,
  };
}

function fresh(overrides: Partial<NewComment> = {}): NewComment {
  return {
    path: 'src/app.ts',
    line: 42,
    body: `**[high] Nil pointer dereference on user object**\n\nre-derived details\n\n${MARKER}`,
    ...overrides,
  };
}

describe('findingSignature', () => {
  it('extracts normalized tokens from the leading bold heading', () => {
    expect(findingSignature('**[high] Race condition in cache-refresh**\n\nbody')).toEqual([
      'high',
      'race',
      'condition',
      'in',
      'cache',
      'refresh',
    ]);
  });

  it('falls back to the first non-empty line when no bold block exists', () => {
    expect(findingSignature('\n\nUnchecked error return\nmore')).toEqual([
      'unchecked',
      'error',
      'return',
    ]);
  });

  it('ignores bold spans that wrap across lines and falls back to the first line', () => {
    expect(findingSignature('**[high] Race condition\nin cache-refresh**\n\nbody')).toEqual([
      'high',
      'race',
      'condition',
    ]);
  });

  it('deduplicates repeated tokens', () => {
    expect(findingSignature('**error error error**')).toEqual(['error']);
  });

  it('returns null for empty or symbol-only bodies', () => {
    expect(findingSignature('')).toBeNull();
    expect(findingSignature('***')).toBeNull();
  });
});

describe('signatureSimilarity', () => {
  it('is 1 for identical token sets', () => {
    expect(signatureSimilarity(['a', 'b'], ['a', 'b'])).toBe(1);
  });

  it('is 0 for disjoint token sets', () => {
    expect(signatureSimilarity(['a'], ['b'])).toBe(0);
  });

  it('computes Jaccard for partial overlap', () => {
    // {a,b,c} ∩ {b,c,d} = 2, union = 4
    expect(signatureSimilarity(['a', 'b', 'c'], ['b', 'c', 'd'])).toBe(0.5);
  });

  it('is 0 when either side is empty', () => {
    expect(signatureSimilarity([], ['a'])).toBe(0);
    expect(signatureSimilarity(['a'], [])).toBe(0);
  });
});

describe('dedupeComments', () => {
  it('drops a comment matching an existing finding on path, line, and signature', () => {
    const result = dedupeComments([fresh()], [existing()]);
    expect(result.kept).toEqual([]);
    expect(result.dropped).toEqual([
      expect.objectContaining({ path: 'src/app.ts', line: 42, matchedLine: 42 }),
    ]);
  });

  it('drops a comment whose line shifted within the tolerance', () => {
    const result = dedupeComments([fresh({ line: 44 })], [existing()]);
    expect(result.kept).toEqual([]);
    expect(result.dropped).toHaveLength(1);
  });

  it('drops a duplicate even when the existing bold heading wraps across lines', () => {
    const wrapped =
      '**[high] Nil pointer dereference on user object\n' +
      'which can crash the request handler when the session store returns an expired entry**';
    const result = dedupeComments(
      [fresh()],
      [existing({ body: `${wrapped}\n\ndetails\n\n${MARKER}` })],
    );
    expect(result.kept).toEqual([]);
    expect(result.dropped).toHaveLength(1);
  });

  it('keeps a comment whose line is beyond the tolerance', () => {
    const result = dedupeComments([fresh({ line: 50 })], [existing()]);
    expect(result.kept).toHaveLength(1);
    expect(result.dropped).toEqual([]);
  });

  it('keeps a comment on a different file even with identical text', () => {
    const result = dedupeComments([fresh({ path: 'src/other.ts' })], [existing()]);
    expect(result.kept).toHaveLength(1);
  });

  it('keeps a comment whose finding text differs (same spot, new issue)', () => {
    const result = dedupeComments(
      [fresh({ body: `**[medium] Unclosed file handle leaks descriptor**\n\n${MARKER}` })],
      [existing()],
    );
    expect(result.kept).toHaveLength(1);
  });

  it('never dedupes against human comments (no marker)', () => {
    const result = dedupeComments(
      [fresh()],
      [existing({ body: '**[high] Nil pointer dereference on user object**\n\nI agree' })],
    );
    expect(result.kept).toHaveLength(1);
  });

  it('never dedupes against bot conversational replies', () => {
    const result = dedupeComments(
      [fresh()],
      [
        existing({
          body: `**[high] Nil pointer dereference on user object**\n\nreply\n\n${REPLY_MARKER}`,
        }),
      ],
    );
    expect(result.kept).toHaveLength(1);
  });

  it('dedupes against legacy cagent-review comments during migration', () => {
    const result = dedupeComments(
      [fresh()],
      [
        existing({
          body: `**[high] Nil pointer dereference on user object**\n\n${LEGACY_MARKER}`,
        }),
      ],
    );
    expect(result.dropped).toHaveLength(1);
  });

  it('matches outdated existing comments via original_line when line is null', () => {
    const result = dedupeComments([fresh()], [existing({ line: null, original_line: 41 })]);
    expect(result.dropped).toHaveLength(1);
  });

  it('skips existing comments with no usable anchor at all', () => {
    const result = dedupeComments([fresh()], [existing({ line: null, original_line: null })]);
    expect(result.kept).toHaveLength(1);
  });

  it('keeps malformed new comments for downstream validation to handle', () => {
    const malformed: NewComment[] = [
      { body: 'no path or line' },
      { path: 'src/app.ts', line: 'not-a-number', body: 'x' },
    ];
    const result = dedupeComments(malformed, [existing()]);
    expect(result.kept).toEqual(malformed);
  });

  it('returns everything unchanged when there are no existing bot comments', () => {
    const comments = [fresh(), fresh({ path: 'b.ts' })];
    const result = dedupeComments(comments, []);
    expect(result.kept).toEqual(comments);
    expect(result.dropped).toEqual([]);
  });

  it('preserves extra fields (side, start_line) on kept comments', () => {
    const comment = fresh({ path: 'src/other.ts', side: 'LEFT', start_line: 40 });
    const result = dedupeComments([comment], [existing()]);
    expect(result.kept[0]).toBe(comment);
  });

  it('honors custom tolerance and similarity options', () => {
    const strict = dedupeComments([fresh({ line: 44 })], [existing()], { lineTolerance: 1 });
    expect(strict.kept).toHaveLength(1);

    const lax = dedupeComments(
      [fresh({ body: `**[high] Nil pointer somewhere else entirely**\n\n${MARKER}` })],
      [existing()],
      { similarityThreshold: 0.2 },
    );
    expect(lax.dropped).toHaveLength(1);
  });
});
