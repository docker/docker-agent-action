// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the score-confidence CLI record parser.
 *
 * parseRecord maps the agent's snake_case finding records to the camelCase
 * FindingInput shape. These tests pin the input-coercion contract that guards
 * the scorer: required fields must be present, scope flags must be strict
 * booleans (never silently `false`, which would drop the finding at the scope
 * gate), and `line` must be a usable positive integer (never NaN, which would
 * break the GitHub review line anchor).
 */
import { describe, expect, it } from 'vitest';
import { parseRecord, toFindingRecords } from '../index.js';

/** A well-formed snake_case record (every required field present and valid). */
function validRaw(): Record<string, unknown> {
  return {
    file: 'pkg/auth/oidc.go',
    line: 72,
    category: 'security',
    verdict: 'CONFIRMED',
    evidence_strength: 'direct',
    context_completeness: 'full',
    drafter_severity: 'high',
    verifier_severity: 'high',
    in_diff: true,
    in_changed_code: true,
  };
}

describe('parseRecord — well-formed input', () => {
  it('maps every snake_case field to its camelCase counterpart', () => {
    expect(parseRecord(validRaw(), 0)).toEqual({
      file: 'pkg/auth/oidc.go',
      line: 72,
      category: 'security',
      verdict: 'CONFIRMED',
      evidenceStrength: 'direct',
      contextCompleteness: 'full',
      drafterSeverity: 'high',
      verifierSeverity: 'high',
      inDiff: true,
      inChangedCode: true,
    });
  });
});

describe('toFindingRecords — top-level input must be an array', () => {
  it('returns the array unchanged for a real findings array', () => {
    const arr = [validRaw()];
    expect(toFindingRecords(arr)).toBe(arr);
  });

  it('accepts an empty array (a genuine zero-findings run)', () => {
    expect(toFindingRecords([])).toEqual([]);
  });

  it('throws on a non-array value rather than silently yielding an empty report', () => {
    // The crux of the bug: each of these used to collapse to [] and exit 0,
    // indistinguishable from a real zero-findings run.
    expect(() => toFindingRecords({ findings: [] })).toThrow(/must be a JSON array of findings/);
    expect(() => toFindingRecords(null)).toThrow(/got null/);
    expect(() => toFindingRecords(42)).toThrow(/got number/);
    expect(() => toFindingRecords('nope')).toThrow(/got string/);
    expect(() => toFindingRecords(true)).toThrow(/got boolean/);
  });
});

describe('parseRecord — scope flags must be strict booleans', () => {
  it('throws (rather than silently dropping) when in_diff is missing', () => {
    const raw = validRaw();
    delete raw.in_diff;
    expect(() => parseRecord(raw, 3)).toThrow(/missing required field "in_diff"/);
  });

  it('throws when in_changed_code is missing', () => {
    const raw = validRaw();
    delete raw.in_changed_code;
    expect(() => parseRecord(raw, 0)).toThrow(/missing required field "in_changed_code"/);
  });

  it('coerces the canonical string forms "true"/"false" to real booleans', () => {
    const result = parseRecord({ ...validRaw(), in_diff: 'true', in_changed_code: 'false' }, 0);
    expect(result.inDiff).toBe(true);
    expect(result.inChangedCode).toBe(false);
  });

  it('treats the string "false" as false, not truthy', () => {
    // The crux of the original bug: a JSON-encoded "false" must NOT read as in-scope.
    expect(parseRecord({ ...validRaw(), in_diff: 'false' }, 0).inDiff).toBe(false);
  });

  it('throws on a non-boolean, non-canonical value', () => {
    expect(() => parseRecord({ ...validRaw(), in_diff: 'yes' }, 0)).toThrow(
      /field "in_diff" must be a boolean/,
    );
    expect(() => parseRecord({ ...validRaw(), in_changed_code: 1 }, 0)).toThrow(
      /field "in_changed_code" must be a boolean/,
    );
  });
});

describe('parseRecord — line must be a positive integer', () => {
  it('accepts a numeric string and coerces it', () => {
    expect(parseRecord({ ...validRaw(), line: '72' }, 0).line).toBe(72);
  });

  it('throws on a non-numeric line (would otherwise serialize as null)', () => {
    expect(() => parseRecord({ ...validRaw(), line: 'abc' }, 0)).toThrow(
      /field "line" must be a positive integer/,
    );
  });

  it('throws on zero, negative, and non-integer line numbers', () => {
    for (const line of [0, -5, 3.5]) {
      expect(() => parseRecord({ ...validRaw(), line }, 0)).toThrow(
        /field "line" must be a positive integer/,
      );
    }
  });

  it('throws when line is missing', () => {
    const raw = validRaw();
    delete raw.line;
    expect(() => parseRecord(raw, 0)).toThrow(/missing required field "line"/);
  });
});
