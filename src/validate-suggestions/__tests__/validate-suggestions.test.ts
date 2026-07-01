// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for src/validate-suggestions.
 *
 * Cover diff parsing (addressable right-side lines), suggestion-block parsing
 * (single / multiple / unclosed / longer fences), anchor validation, and the
 * end-to-end sanitizer (keep valid, strip malformed, preserve prose + marker,
 * revert suggestion-only multi-line ranges, fail-safe on a missing diff).
 */
import { describe, expect, it } from 'vitest';
import {
  findSuggestionBlocks,
  parseAddressableLines,
  REVIEW_MARKER,
  type ReviewComment,
  sanitizeComments,
  validateAnchor,
} from '../validate-suggestions.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

/**
 * A diff for `file.ts` whose hunk starts at new-file line 10:
 *   10 context   (addressable)
 *   11 added     (addressable)
 *   12 added     (addressable)
 *   13 context   (addressable)
 *   -- deleted   (left side only)
 *   14 context   (addressable)
 * Right-side addressable lines: {10, 11, 12, 13, 14}.
 */
const DIFF = [
  'diff --git a/file.ts b/file.ts',
  'index abc..def 100644',
  '--- a/file.ts',
  '+++ b/file.ts',
  '@@ -10,5 +10,6 @@',
  ' const a = 1;',
  '+const b = 2;',
  '+const c = 3;',
  ' const d = 4;',
  '-const old = 5;',
  ' const e = 6;',
  '',
].join('\n');

function comment(overrides: Partial<ReviewComment>): ReviewComment {
  return {
    path: 'file.ts',
    line: 11,
    body: `**[medium] Issue**\n\nExplanation.\n\n${REVIEW_MARKER}`,
    ...overrides,
  };
}

function withSuggestion(body: string, replacement: string): string {
  return body.replace(
    REVIEW_MARKER,
    `\`\`\`suggestion\n${replacement}\n\`\`\`\n\n${REVIEW_MARKER}`,
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// parseAddressableLines
// ═════════════════════════════════════════════════════════════════════════════

describe('parseAddressableLines', () => {
  it('records added and context lines on the right side, skipping deleted', () => {
    const map = parseAddressableLines(DIFF);
    expect([...(map.get('file.ts') ?? [])].sort((a, b) => a - b)).toEqual([10, 11, 12, 13, 14]);
  });

  it('handles multiple files independently', () => {
    const diff = `${DIFF}${[
      'diff --git a/other.go b/other.go',
      'index 111..222 100644',
      '--- a/other.go',
      '+++ b/other.go',
      '@@ -1,0 +1,2 @@',
      '+package main',
      '+// x',
      '',
    ].join('\n')}`;
    const map = parseAddressableLines(diff);
    expect(map.get('file.ts')?.has(11)).toBe(true);
    expect([...(map.get('other.go') ?? [])].sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it('resets numbering per hunk', () => {
    const diff = [
      '--- a/m.ts',
      '+++ b/m.ts',
      '@@ -1,1 +1,1 @@',
      '+first',
      '@@ -50,1 +60,2 @@',
      '+near-sixty',
      '+also',
      '',
    ].join('\n');
    const lines = parseAddressableLines(diff).get('m.ts');
    expect([...(lines ?? [])].sort((a, b) => a - b)).toEqual([1, 60, 61]);
  });

  it('does not record right-side lines for a deleted file (+++ /dev/null)', () => {
    const diff = [
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-was here',
      '-and here',
      '',
    ].join('\n');
    expect(parseAddressableLines(diff).size).toBe(0);
  });

  it("strips git's trailing TAB from a path containing a space", () => {
    // git delimits a space-containing name with a trailing TAB in the header.
    const diff = [
      '--- a/my file.txt\t',
      '+++ b/my file.txt\t',
      '@@ -1,1 +1,2 @@',
      ' one',
      '+two',
      '',
    ].join('\n');
    const map = parseAddressableLines(diff);
    expect([...(map.get('my file.txt') ?? [])].sort((a, b) => a - b)).toEqual([1, 2]);
    expect(map.has('my file.txt\t')).toBe(false);
  });

  it('decodes a C-quoted non-ASCII path back to UTF-8', () => {
    // git C-quotes non-ASCII headers, octal-escaping each UTF-8 byte (é = \303\251).
    const diff = [
      '--- "a/caf\\303\\251.ts"',
      '+++ "b/caf\\303\\251.ts"',
      '@@ -1,1 +1,2 @@',
      ' existing',
      '+added',
      '',
    ].join('\n');
    const map = parseAddressableLines(diff);
    expect([...(map.get('café.ts') ?? [])].sort((a, b) => a - b)).toEqual([1, 2]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// findSuggestionBlocks
// ═════════════════════════════════════════════════════════════════════════════

describe('findSuggestionBlocks', () => {
  it('finds a single closed block', () => {
    const lines = ['text', '```suggestion', 'new code', '```', 'more'].join('\n').split('\n');
    expect(findSuggestionBlocks(lines)).toEqual([{ start: 1, end: 3, closed: true }]);
  });

  it('finds multiple closed blocks', () => {
    const lines = '```suggestion\na\n```\nmid\n```suggestion\nb\n```'.split('\n');
    const blocks = findSuggestionBlocks(lines);
    expect(blocks).toHaveLength(2);
    expect(blocks.every((b) => b.closed)).toBe(true);
  });

  it('flags an unclosed block spanning to the end of the body', () => {
    const lines = 'before\n```suggestion\nnew code\nno closer'.split('\n');
    expect(findSuggestionBlocks(lines)).toEqual([{ start: 1, end: 3, closed: false }]);
  });

  it('accepts longer fences and a case-insensitive info string', () => {
    const lines = '````Suggestion\ncode\n````'.split('\n');
    expect(findSuggestionBlocks(lines)).toEqual([{ start: 0, end: 2, closed: true }]);
  });

  it('returns nothing for a plain code fence', () => {
    const lines = '```ts\nconst x = 1;\n```'.split('\n');
    expect(findSuggestionBlocks(lines)).toEqual([]);
  });

  it('does not let a shorter inner fence close a longer suggestion block', () => {
    const lines = '````suggestion\nsome code\n```\nmore code\n````'.split('\n');
    expect(findSuggestionBlocks(lines)).toEqual([{ start: 0, end: 4, closed: true }]);
  });

  it('flags a longer fence as unclosed when only a shorter inner fence follows', () => {
    const lines = '````suggestion\ncode\n```\nmore'.split('\n');
    expect(findSuggestionBlocks(lines)).toEqual([{ start: 0, end: 3, closed: false }]);
  });

  it('treats a second opener before any closer as the first block being unclosed', () => {
    const lines = '```suggestion\nconst b = 2;\nmid\n```suggestion\nconst c = 3;\n```'.split('\n');
    expect(findSuggestionBlocks(lines)).toEqual([{ start: 0, end: 5, closed: false }]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// validateAnchor
// ═════════════════════════════════════════════════════════════════════════════

describe('validateAnchor', () => {
  const addr = parseAddressableLines(DIFF);

  it('accepts a single addressable right-side line', () => {
    expect(validateAnchor(comment({ line: 11 }), addr).valid).toBe(true);
  });

  it('accepts a context line as a valid anchor', () => {
    expect(validateAnchor(comment({ line: 10 }), addr).valid).toBe(true);
  });

  it('rejects a LEFT-side (deleted-line) anchor', () => {
    const v = validateAnchor(comment({ line: 11, side: 'LEFT' }), addr);
    expect(v.valid).toBe(false);
    expect(v.reason).toContain('LEFT');
  });

  it('rejects a line outside the diff', () => {
    expect(validateAnchor(comment({ line: 99 }), addr).valid).toBe(false);
  });

  it('rejects an unknown file', () => {
    expect(validateAnchor(comment({ path: 'nope.ts', line: 11 }), addr).valid).toBe(false);
  });

  it('accepts a contiguous multi-line range within a hunk', () => {
    expect(validateAnchor(comment({ start_line: 11, line: 13 }), addr).valid).toBe(true);
  });

  it('rejects start_line >= line', () => {
    expect(validateAnchor(comment({ start_line: 13, line: 11 }), addr).valid).toBe(false);
  });

  it('rejects a multi-line range that crosses a hunk gap', () => {
    const diff = [
      '--- a/m.ts',
      '+++ b/m.ts',
      '@@ -1,1 +1,1 @@',
      '+first',
      '@@ -50,1 +60,1 @@',
      '+sixty',
      '',
    ].join('\n');
    const v = validateAnchor(
      comment({ path: 'm.ts', start_line: 1, line: 60 }),
      parseAddressableLines(diff),
    );
    expect(v.valid).toBe(false);
  });

  it('rejects a multi-line range with start_side LEFT', () => {
    expect(
      validateAnchor(comment({ start_line: 11, start_side: 'LEFT', line: 13 }), addr).valid,
    ).toBe(false);
  });

  it('fails closed when the comment has no numeric line anchor', () => {
    const c = { path: 'file.ts', body: 'x' } as unknown as ReviewComment;
    const v = validateAnchor(c, addr);
    expect(v.valid).toBe(false);
    expect(v.reason).toContain('line anchor');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// sanitizeComments
// ═════════════════════════════════════════════════════════════════════════════

describe('sanitizeComments', () => {
  it('keeps a valid single-line suggestion', () => {
    const c = comment({ line: 11, body: withSuggestion(comment({}).body, 'const b = 22;') });
    const res = sanitizeComments([c], DIFF);
    expect(res.suggestionsKept).toBe(1);
    expect(res.suggestionsStripped).toBe(0);
    expect(res.comments[0].body).toContain('```suggestion');
    expect(res.issues).toHaveLength(0);
  });

  it('keeps a valid multi-line suggestion', () => {
    const c = comment({
      start_line: 11,
      line: 12,
      body: withSuggestion(comment({}).body, 'const b = 22;\nconst c = 33;'),
    });
    const res = sanitizeComments([c], DIFF);
    expect(res.suggestionsKept).toBe(1);
    expect(res.comments[0].body).toContain('```suggestion');
    expect(res.comments[0].start_line).toBe(11);
  });

  it('strips a suggestion on a LEFT (deleted) line but keeps the prose and marker', () => {
    const original = comment({ line: 11, side: 'LEFT' });
    const c = comment({ line: 11, side: 'LEFT', body: withSuggestion(original.body, 'x') });
    const res = sanitizeComments([c], DIFF);
    expect(res.suggestionsStripped).toBe(1);
    expect(res.comments[0].body).not.toContain('```suggestion');
    expect(res.comments[0].body).toContain('Explanation.');
    expect(res.comments[0].body).toContain(REVIEW_MARKER);
    expect(res.issues[0].reason).toContain('LEFT');
  });

  it('strips a suggestion anchored outside the diff', () => {
    const c = comment({ line: 99, body: withSuggestion(comment({}).body, 'x') });
    const res = sanitizeComments([c], DIFF);
    expect(res.suggestionsStripped).toBe(1);
    expect(res.comments[0].body).not.toContain('```suggestion');
  });

  it('reverts a suggestion-only multi-line range when the range is invalid', () => {
    const c = comment({
      start_line: 13,
      line: 11, // start >= line → invalid
      body: withSuggestion(comment({}).body, 'x'),
    });
    const res = sanitizeComments([c], DIFF);
    expect(res.suggestionsStripped).toBe(1);
    expect(res.comments[0].start_line).toBeUndefined();
    expect(res.comments[0].start_side).toBeUndefined();
    expect(res.comments[0].line).toBe(11);
  });

  it('strips an unclosed suggestion fence while keeping the marker', () => {
    const body = `**[medium] Issue**\n\nExplanation.\n\n\`\`\`suggestion\nconst b = 22;\n\n${REVIEW_MARKER}`;
    const c = comment({ line: 11, body });
    const res = sanitizeComments([c], DIFF);
    expect(res.suggestionsStripped).toBe(1);
    expect(res.comments[0].body).not.toContain('```suggestion');
    expect(res.comments[0].body).toContain(REVIEW_MARKER);
    expect(res.comments[0].body).toContain('Explanation.');
  });

  it('keeps a closed block but strips and reports an unclosed block that follows it', () => {
    const body = [
      '**[medium] Issue**',
      '',
      '```suggestion',
      'const b = 22;',
      '```',
      '',
      'Some prose.',
      '',
      '```suggestion',
      'const c = 33;',
      '',
      REVIEW_MARKER,
    ].join('\n');
    const res = sanitizeComments([comment({ line: 11, body })], DIFF);
    expect(res.suggestionsKept).toBe(1);
    expect(res.suggestionsStripped).toBe(1);
    expect(res.comments[0].body).toContain('const b = 22;'); // closed block before the unclosed one survives
    expect(res.comments[0].body).not.toContain('const c = 33;');
    expect(res.comments[0].body).toContain(REVIEW_MARKER);
    expect(res.issues[0].reason).toContain('unclosed');
  });

  it('strips a block that follows an unclosed fence (swallow-to-end matches GitHub rendering)', () => {
    // An unclosed fence runs to the end of the document in Markdown, so a later
    // block is part of it and would not render as a separate suggestion on
    // GitHub either; stripping it (and reporting the unclosed fence) is correct.
    const body = [
      '**[medium] Issue**',
      '',
      '```suggestion',
      'const b = 22;',
      '```',
      '',
      'prose',
      '',
      '```suggestion',
      'const c = 33;',
      '```suggestion',
      'const d = 44;',
      '```',
      '',
      REVIEW_MARKER,
    ].join('\n');
    const res = sanitizeComments([comment({ line: 11, body })], DIFF);
    expect(res.suggestionsKept).toBe(1);
    expect(res.suggestionsStripped).toBe(1);
    expect(res.comments[0].body).toContain('const b = 22;');
    expect(res.comments[0].body).not.toContain('const c = 33;');
    expect(res.comments[0].body).not.toContain('const d = 44;');
    expect(res.comments[0].body).toContain(REVIEW_MARKER);
    expect(res.issues[0].reason).toContain('unclosed');
  });

  it('leaves comments without suggestions untouched', () => {
    const c = comment({ line: 99 }); // bad line, but no suggestion → not our concern
    const res = sanitizeComments([c], DIFF);
    expect(res.comments[0]).toBe(c);
    expect(res.suggestionsStripped).toBe(0);
  });

  it('preserves unrelated comment fields when sanitizing', () => {
    const c = comment({
      line: 99,
      body: withSuggestion(comment({}).body, 'x'),
      category: 'logic_error',
    });
    const res = sanitizeComments([c], DIFF);
    expect(res.comments[0].category).toBe('logic_error');
    expect(res.comments[0].path).toBe('file.ts');
  });

  it('strips all suggestions when the diff is empty (fail-safe)', () => {
    const c = comment({ line: 11, body: withSuggestion(comment({}).body, 'const b = 22;') });
    const res = sanitizeComments([c], '');
    expect(res.suggestionsStripped).toBe(1);
    expect(res.suggestionsKept).toBe(0);
    expect(res.comments[0].body).not.toContain('```suggestion');
  });

  it('keeps a valid suggestion on a path containing a space', () => {
    const diff = [
      '--- a/my file.txt\t',
      '+++ b/my file.txt\t',
      '@@ -1,1 +1,2 @@',
      ' one',
      '+two',
      '',
    ].join('\n');
    const c = comment({
      path: 'my file.txt',
      line: 2,
      body: withSuggestion(comment({}).body, 'two!'),
    });
    const res = sanitizeComments([c], diff);
    expect(res.suggestionsKept).toBe(1);
    expect(res.suggestionsStripped).toBe(0);
    expect(res.comments[0].body).toContain('```suggestion');
  });

  it('keeps a valid suggestion on a non-ASCII (C-quoted) path', () => {
    const diff = [
      '--- "a/caf\\303\\251.ts"',
      '+++ "b/caf\\303\\251.ts"',
      '@@ -1,1 +1,2 @@',
      ' existing',
      '+added',
      '',
    ].join('\n');
    const c = comment({
      path: 'café.ts',
      line: 2,
      body: withSuggestion(comment({}).body, 'added!'),
    });
    const res = sanitizeComments([c], diff);
    expect(res.suggestionsKept).toBe(1);
    expect(res.suggestionsStripped).toBe(0);
    expect(res.comments[0].body).toContain('```suggestion');
  });
});
