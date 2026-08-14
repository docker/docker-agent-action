// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression tests for the anti-refusal contracts of review-pr/agents/pr-review.yaml.
 *
 * A sub-agent that refuses (or whose `transfer_task` delegation errors) must never
 * be able to steer the review toward approval. Two layers enforce this:
 *
 *   1. Schema hardening — the drafter and verifier structured-output schemas reject
 *      empty/whitespace-only values in every human-meaningful string field, require
 *      line numbers >= 1, and reject the bare literal "placeholder" (any case,
 *      optional surrounding ASCII whitespace) that a refusing model emits to satisfy
 *      `required` fields. The pattern is engine-portable by construction: no
 *      lookaheads, every alternative anchored `^...$` so JSON Schema search
 *      semantics and provider constrained decoders that full-match accept the same
 *      strings, and explicit ASCII classes `[ \t\n\r\f]` instead of `\s`/`\S` so Go
 *      RE2 and ECMA agree (NBSP and other non-ASCII whitespace count as content).
 *      Every copy of the pattern must stay byte-identical.
 *   2. Orchestration contracts — the root instructions must treat a `transfer_task`
 *      tool error exactly like empty/malformed output (never approve, never retry),
 *      aggregate batched CI drafter responses fail-closed (merged review_complete is
 *      true only when EVERY delegation returned valid JSON with review_complete
 *      true; an incomplete merge never approves at ANY finding count — zero or
 *      nonzero — and must post an explicit incomplete heading carrying the
 *      diagnostic merged summary instead of an assessment/approve label), assign
 *      each verifier-delegated finding a deterministic `finding_id` and pair
 *      verdicts one-to-one by that ID with an exact file+line cross-check
 *      (omission/addition/duplicate/mismatch => inconclusive COMMENT fallback, no
 *      partial merge — JSON Schema cannot express this cardinality, so it lives in
 *      the instructions), and route malformed/refused drafter JSON through the
 *      existing incomplete-review fallback.
 *
 * Like src/caller-permissions, this reads the YAML as text with a focused,
 * dependency-free extractor instead of pulling in a YAML parser.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const YAML_PATH = resolve(import.meta.dirname, '../../../review-pr/agents/pr-review.yaml');
const source = readFileSync(YAML_PATH, 'utf-8');

/**
 * The canonical anti-placeholder pattern. Every alternative is anchored `^...$`
 * and consumes the whole value, so validators that search (JSON Schema) and
 * constrained decoders that full-match accept exactly the same strings.
 * Whitespace is the explicit ASCII class `[ \t\n\r\f]` (JSON whitespace plus
 * form feed — exactly Go RE2's `\s`), so NBSP and other non-ASCII whitespace
 * count as content in every engine. Alternatives, in order: a single content
 * run of 1–10 chars; of 12+ chars; two or more runs separated by whitespace;
 * an 11-char run deviating from "placeholder" (ASCII case-insensitive) at some
 * position. Their union accepts exactly the strings that contain a
 * non-whitespace character and are not the bare literal "placeholder" after
 * trimming ASCII whitespace.
 */
const ANTI_PLACEHOLDER = String.raw`^[ \t\n\r\f]*[^ \t\n\r\f]{1,10}[ \t\n\r\f]*$|^[ \t\n\r\f]*[^ \t\n\r\f]{12,}[ \t\n\r\f]*$|^[ \t\n\r\f]*[^ \t\n\r\f]+(?:[ \t\n\r\f]+[^ \t\n\r\f]+)+[ \t\n\r\f]*$|^[ \t\n\r\f]*(?:[^ \t\n\r\fPp][^ \t\n\r\f]{10}|[Pp][^ \t\n\r\fLl][^ \t\n\r\f]{9}|[Pp][Ll][^ \t\n\r\fAa][^ \t\n\r\f]{8}|[Pp][Ll][Aa][^ \t\n\r\fCc][^ \t\n\r\f]{7}|[Pp][Ll][Aa][Cc][^ \t\n\r\fEe][^ \t\n\r\f]{6}|[Pp][Ll][Aa][Cc][Ee][^ \t\n\r\fHh][^ \t\n\r\f]{5}|[Pp][Ll][Aa][Cc][Ee][Hh][^ \t\n\r\fOo][^ \t\n\r\f]{4}|[Pp][Ll][Aa][Cc][Ee][Hh][Oo][^ \t\n\r\fLl][^ \t\n\r\f]{3}|[Pp][Ll][Aa][Cc][Ee][Hh][Oo][Ll][^ \t\n\r\fDd][^ \t\n\r\f]{2}|[Pp][Ll][Aa][Cc][Ee][Hh][Oo][Ll][Dd][^ \t\n\r\fEe][^ \t\n\r\f]|[Pp][Ll][Aa][Cc][Ee][Hh][Oo][Ll][Dd][Ee][^ \t\n\r\fRr])[ \t\n\r\f]*$`;

function sliceBetween(text: string, startMarker: string, endMarker: string): string {
  const start = text.indexOf(startMarker);
  if (start === -1) throw new Error(`marker not found: ${startMarker}`);
  const end = text.indexOf(endMarker, start + startMarker.length);
  if (end === -1) throw new Error(`marker not found after ${startMarker}: ${endMarker}`);
  return text.slice(start, end);
}

const rootAgent = sliceBetween(source, '\n  root:', '\n  drafter:');
const drafterAgent = sliceBetween(source, '\n  drafter:', '\n  verifier:');
const verifierAgent = source.slice(source.indexOf('\n  verifier:'));
const drafterSchema = sliceBetween(drafterAgent, 'name: draft_findings', 'toolsets:');
const verifierSchema = sliceBetween(verifierAgent, 'name: verification_verdicts', 'permissions:');

/** Collapse runs of whitespace so assertions survive YAML line wrapping. */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ');
}

/**
 * Extract the lines of one property subschema: everything indented deeper than
 * the `<indent-spaces>name:` key line, stopping at the next same-or-shallower
 * line (which also makes YAML comments between properties act as terminators).
 */
function propertySubschema(schemaText: string, propName: string, indent: number): string {
  const lines = schemaText.split('\n');
  const key = `${' '.repeat(indent)}${propName}:`;
  const start = lines.indexOf(key);
  if (start === -1) throw new Error(`property not found: ${propName} at indent ${indent}`);
  const block: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    const lineIndent = line.length - line.trimStart().length;
    if (line.trim() === '' || lineIndent <= indent) break;
    block.push(line);
  }
  return block.join('\n');
}

function patternOf(block: string): string {
  const match = block.match(/pattern: '([^']*)'/);
  if (!match) throw new Error(`no single-quoted pattern in block:\n${block}`);
  return match[1];
}

/** Split a regex on its top-level `|`, honoring groups, classes, and escapes. */
function topLevelBranches(pattern: string): string[] {
  const branches: string[] = [];
  let depth = 0;
  let inClass = false;
  let current = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\') {
      current += ch + (pattern[i + 1] ?? '');
      i++;
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
    } else if (ch === '[') {
      inClass = true;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
    } else if (ch === '|' && depth === 0) {
      branches.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  branches.push(current);
  return branches;
}

describe('structured-output schema hardening', () => {
  // Free-text fields and their key indent within each schema block.
  const drafterTextFields: Array<[string, number]> = [
    ['file', 16],
    ['issue', 16],
    ['details', 16],
    ['summary', 10],
  ];
  const verifierTextFields: Array<[string, number]> = [
    ['file', 16],
    ['issue', 16],
    ['details', 16],
  ];

  it.each(drafterTextFields)('drafter %s rejects empty/placeholder values', (name, indent) => {
    const block = propertySubschema(drafterSchema, name, indent);
    expect(block).toContain('minLength: 1');
    expect(patternOf(block)).toBe(ANTI_PLACEHOLDER);
  });

  it.each(verifierTextFields)('verifier %s rejects empty/placeholder values', (name, indent) => {
    const block = propertySubschema(verifierSchema, name, indent);
    expect(block).toContain('minLength: 1');
    expect(patternOf(block)).toBe(ANTI_PLACEHOLDER);
  });

  it('keeps every pattern occurrence in the file byte-identical', () => {
    const copies = source.split(`pattern: '${ANTI_PLACEHOLDER}'`).length - 1;
    const total = (source.match(/pattern: '/g) ?? []).length;
    expect(copies).toBe(7);
    expect(total).toBe(7);
  });

  it('requires line >= 1 in both schemas', () => {
    expect(propertySubschema(drafterSchema, 'line', 16)).toContain('minimum: 1');
    expect(propertySubschema(verifierSchema, 'line', 16)).toContain('minimum: 1');
  });

  it('keeps the verifier verdicts array non-empty', () => {
    expect(propertySubschema(verifierSchema, 'verdicts', 10)).toContain('minItems: 1');
  });

  it('requires an integer finding_id >= 1 echoed in every verifier verdict', () => {
    const block = propertySubschema(verifierSchema, 'finding_id', 16);
    expect(block).toContain('type: integer');
    expect(block).toContain('minimum: 1');
    expect(normalize(verifierSchema)).toContain(
      'required: [ "verdict", "finding_id", "file", "line", "severity", "issue", "details", "in_changed_code", "evidence_strength", "context_completeness", ]',
    );
  });
});

describe('anti-placeholder pattern portability', () => {
  it('anchors every top-level alternative on both ends (full-match safe)', () => {
    const branches = topLevelBranches(ANTI_PLACEHOLDER);
    expect(branches.length).toBeGreaterThanOrEqual(4);
    for (const branch of branches) {
      expect(branch.startsWith('^')).toBe(true);
      expect(branch.endsWith('$')).toBe(true);
    }
  });

  it('avoids engine-specific syntax: \\s/\\S classes, lookarounds, inline flags', () => {
    expect(ANTI_PLACEHOLDER).not.toMatch(/\\[sS]/);
    // Only non-capturing groups: after rewriting `(?:` no `(?` construct
    // (lookaround or inline flag) may remain.
    expect(ANTI_PLACEHOLDER.replaceAll('(?:', '(')).not.toContain('(?');
  });
});

describe('anti-placeholder pattern behavior', () => {
  const searchRe = new RegExp(ANTI_PLACEHOLDER);
  // Constrained decoders match the pattern against the ENTIRE value; anchored
  // alternatives make that equivalent to JSON Schema's search semantics.
  const fullMatchRe = new RegExp(`^(?:${ANTI_PLACEHOLDER})$`);

  const rejected = [
    '',
    ' ',
    '\t',
    ' \t\n ',
    '\f',
    '\r\n',
    'placeholder',
    'Placeholder',
    'PLACEHOLDER',
    'PlAcEhOlDeR',
    ' placeholder',
    'placeholder ',
    '  placeholder  ',
    '\tPLACEHOLDER\n',
    ' \f placeholder \r ',
  ];

  const accepted = [
    'src/score-confidence/index.ts',
    'placeholder.go',
    'placeholders',
    'placeholde',
    'a placeholder value reaches production',
    'place holder',
    'p',
    'N/A',
    // Ordinary short-word sentences (regression: the old pattern's unanchored
    // `\S\s+\S` branch accepted these only under search semantics).
    'a b',
    'to do',
    'fix the bug',
    // 11 chars — same length as "placeholder" — deviating at the first and
    // last positions.
    'credentials',
    'placeholdex',
    'Err — “quoted”, 100% Unicode: héllo 🚀',
    '檔案路徑/main.go',
    // NBSP is not ASCII JSON whitespace: it counts as content, uniformly in
    // Go RE2 and ECMA (unlike `\s`, which ECMA extends to Unicode whitespace).
    '\u00a0',
    'foo\u00a0bar',
    'placeholder\u00a0',
    '\u00a0placeholder\u00a0',
    'nil deref on line 12.\nTriggered when x == nil; fix: guard before use.',
    'ERROR: Diff file not found at the specified path. The orchestrator must write the diff to disk before delegating.',
  ];

  it.each(rejected)('rejects %j under search and full-match semantics', (value) => {
    expect(searchRe.test(value)).toBe(false);
    expect(fullMatchRe.test(value)).toBe(false);
  });

  it.each(accepted)('accepts %j under search and full-match semantics', (value) => {
    expect(searchRe.test(value)).toBe(true);
    expect(fullMatchRe.test(value)).toBe(true);
  });

  /** Deterministic PRNG (mulberry32) so the fuzz corpus is stable across runs. */
  function mulberry32(seed: number): () => number {
    let a = seed;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const ASCII_WS = new Set([' ', '\t', '\n', '\r', '\f']);
  const BARE_PLACEHOLDER = /^[Pp][Ll][Aa][Cc][Ee][Hh][Oo][Ll][Dd][Ee][Rr]$/;

  /** Contract oracle: has content, and is not bare "placeholder" after ASCII trim. */
  function isAcceptable(value: string): boolean {
    const chars = [...value];
    if (!chars.some((c) => !ASCII_WS.has(c))) return false;
    let start = 0;
    let end = chars.length;
    while (start < end && ASCII_WS.has(chars[start])) start++;
    while (end > start && ASCII_WS.has(chars[end - 1])) end--;
    return !BARE_PLACEHOLDER.test(chars.slice(start, end).join(''));
  }

  it('agrees with the contract oracle on seeded adversarial fuzz input', () => {
    const alphabet = [
      ' ',
      '\t',
      '\n',
      '\r',
      '\f',
      'p',
      'P',
      'l',
      'L',
      'a',
      'A',
      'c',
      'C',
      'e',
      'E',
      'h',
      'H',
      'o',
      'O',
      'd',
      'D',
      'r',
      'R',
      'x',
      '.',
      '\u00a0',
      '🚀',
    ];
    const rand = mulberry32(0xc0ffee);
    for (let i = 0; i < 3000; i++) {
      const length = Math.floor(rand() * 16);
      let value = '';
      for (let j = 0; j < length; j++) {
        value += alphabet[Math.floor(rand() * alphabet.length)];
      }
      const expected = isAcceptable(value);
      expect(searchRe.test(value), `search ${JSON.stringify(value)}`).toBe(expected);
      expect(fullMatchRe.test(value), `full-match ${JSON.stringify(value)}`).toBe(expected);
    }
  });
});

describe('root orchestration contracts', () => {
  const root = normalize(rootAgent);

  it('treats a drafter transfer_task tool error like a malformed response, never retried', () => {
    expect(root).toContain('A `transfer_task` tool error counts as exactly this same case');
    expect(root).toContain(
      'do NOT retry the delegation and NEVER approve on the basis of an errored delegation',
    );
  });

  it('routes malformed/refused drafter partial JSON through the incomplete-review fallback', () => {
    expect(root).toContain('partial, refused, or otherwise malformed');
    expect(root).toContain(
      'treat it as the same fallback object so it follows the incomplete-review fallback below (`review_complete: false`)',
    );
  });

  it('parses every batched drafter delegation separately before aggregating', () => {
    expect(root).toContain(
      "Parse each drafter delegation's JSON response separately (console mode has one delegation; CI batched mode has one per chunk)",
    );
  });

  it('merges batched drafter responses fail-closed via an explicit aggregation rule', () => {
    expect(root).toContain(
      'Aggregation rule (REQUIRED — how per-delegation results become ONE merged result)',
    );
    expect(root).toContain(
      "Merged `findings` = the concatenation of every delegation's `findings` array.",
    );
    expect(root).toContain(
      'Merged `review_complete` = true ONLY IF every delegation returned valid JSON with `review_complete: true`.',
    );
    expect(root).toContain(
      'If ANY delegation errored, was malformed, refused, or partial (i.e. became the fallback object above), or returned `review_complete: false`, the merged `review_complete` is false.',
    );
    expect(root).toContain('Every later step reads these merged values.');
  });

  it('never approves on zero merged findings when any chunk was incomplete', () => {
    expect(root).toContain(
      'even when the merged findings list is empty — zero findings from an incomplete batch is NEVER grounds to approve',
    );
    expect(root).toContain('Check the merged `review_complete`:');
  });

  it('aggregates per-delegation summaries diagnostically, labeled by chunk', () => {
    expect(root).toContain(
      'Merged `summary` = a diagnostic aggregate with one line per delegation, labeled by its chunk',
    );
    expect(root).toContain(
      'so a crashed, refused, or truncated chunk stays visible in the posted review',
    );
    expect(root).toContain('Include the merged `summary` in the comment body');
  });

  it('stays incomplete when chunks fail but findings survive (nonzero findings)', () => {
    expect(root).toContain(
      'If `review_complete` is `false` AND findings is non-empty → the review is INCOMPLETE, and it stays INCOMPLETE no matter what later steps find.',
    );
    expect(root).toContain(
      'the posted review MUST use the incomplete-review body from Decision Rules rule 4 (the "### ⚠️ Review incomplete" heading plus the diagnostic merged `summary`) and MUST NOT carry a "🟢 APPROVE" label or any approve wording',
    );
    expect(root).toContain(
      'Verified findings — however high their confidence — never overwrite incompleteness.',
    );
  });

  it('overrides the assessment label fail-closed at any finding count', () => {
    expect(root).toContain('**Incompleteness override (fail-closed)**');
    expect(root).toContain(
      'if the merged `review_complete` from step 5 is false, the review is incomplete at ANY finding count',
    );
    expect(root).toContain(
      'Do NOT emit an "### Assessment:" line and do NOT use approve wording anywhere in the review body.',
    );
    expect(root).toContain('a would-be "🟢 APPROVE" becomes "⚠️ INCOMPLETE" instead');
    expect(root).toContain(
      'Confidence scores decide per-finding dispositions only — they never restore a complete or approving outcome.',
    );
  });

  it('forces the diagnostic merged summary into the built review body', () => {
    // Step 9 output construction: the notice is a required body block, not optional.
    expect(root).toContain(
      'the review body MUST open with the "### ⚠️ Review incomplete" heading followed by the diagnostic merged `summary` (the per-chunk status lines)',
    );
    expect(root).toContain(
      'This notice is required at ANY finding count — never omit it because findings exist, and never let high-confidence findings replace it.',
    );
    // Decision Rules mirror: the incomplete body carries the per-chunk statuses.
    expect(root).toContain(
      'Open the review body with "### ⚠️ Review incomplete" followed by the diagnostic merged `summary` (the per-chunk status lines from step 5).',
    );
  });

  it('reserves the zero-findings 🟢 APPROVE template for complete merges', () => {
    expect(root).toContain(
      'use this exact pattern ONLY when the findings list is empty AND the merged `review_complete` is true',
    );
    expect(root).toContain(
      'an incomplete review must instead post the "### ⚠️ Review incomplete" body from Decision Rules rule 4, never a 🟢 APPROVE body',
    );
  });

  it('keeps the incomplete body off the incremental-review completion marker', () => {
    // "### Assessment:" is src/incremental-review's completed-run marker; an
    // incomplete review carrying it would advance the last-reviewed SHA and
    // permanently skip the crashed chunks.
    expect(root).toContain(
      '"### Assessment:" is the completed-run marker the incremental reviewer keys on',
    );
    expect(root).toContain(
      'an incomplete run must never carry it, or the next incremental review would skip the unreviewed chunks',
    );
  });

  it('extends the console format with the incomplete outcome', () => {
    expect(root).toContain(
      'When the merged `review_complete` is false — at ANY finding count — replace the "### Assessment:" line with the incomplete-review header from Decision Rules rule 4 and never print an approve label:',
    );
    expect(root).toContain('Findings so far: [🔴 CRITICAL|🟡 NEEDS ATTENTION|⚠️ INCOMPLETE]');
  });

  it('treats a verifier transfer_task tool error like an empty/malformed response', () => {
    expect(root).toContain(
      'or the `transfer_task` call itself fails or returns a tool error, which you MUST treat exactly like an empty/malformed response',
    );
    expect(root).toContain('A `transfer_task` tool error is never grounds to approve or to retry.');
  });

  it('assigns deterministic finding_ids before delegating to the verifier', () => {
    expect(root).toContain('Assign a `finding_id` before delegating');
    expect(root).toContain(
      'sequential integers 1..N in the exact order they appear in the delegation message (first finding = 1)',
    );
    expect(root).toContain(
      'deterministic, unique within the batch, assigned by YOU and never by a sub-agent',
    );
    expect(root).toContain(
      'Two findings may legitimately share the same `file` + `line` — the `finding_id` is what keeps their verdicts unambiguous',
    );
  });

  it('requires one-to-one verdict pairing by finding_id with a file+line cross-check', () => {
    expect(root).toContain('Pairing check (REQUIRED — before scope filtering or any merge)');
    expect(root).toContain(
      'verdicts must correspond one-to-one to the findings you delegated, matched by the `finding_id` you assigned in step 5',
    );
    expect(root).toContain(
      "check the verdict's echoed `file` + `line` EXACTLY match that finding's `file` + `line`",
    );
    expect(root).toContain('no verdict carrying its `finding_id` (omission)');
    expect(root).toContain('a `finding_id` you did not assign (addition)');
    expect(root).toContain('two or more verdicts carry the same `finding_id` (duplicate)');
    expect(root).toContain(
      "echoed `file`/`line` differ from its `finding_id`'s source finding (mismatch)",
    );
    expect(root).toContain('apply the ANTI-LOOP fallback from step 5');
    expect(root).toContain('do NOT partially merge the subset of verdicts that did match');
  });
});

describe('verifier instruction contracts', () => {
  const verifier = normalize(verifierAgent);

  it('demands exactly one verdict per finding, paired by finding_id', () => {
    expect(verifier).toContain('You MUST produce exactly one verdict per finding');
    expect(verifier).toContain('never merge, split, invent, or pad verdicts');
    expect(verifier).toContain(
      'the orchestrator pairs each verdict back to its finding by the `finding_id` it assigned',
    );
    expect(verifier).toContain('cross-checking the echoed `file` + `line` against that finding');
  });

  it('requires echoing finding_id, file, and line exactly', () => {
    expect(verifier).toContain(
      'Echo the integer ID the orchestrator assigned to this finding EXACTLY',
    );
    expect(verifier).toContain("Preserve the file path from the drafter's finding EXACTLY");
    expect(verifier).toContain("Preserve the line number from the drafter's finding EXACTLY");
  });

  it('forbids placeholder text explicitly', () => {
    expect(verifier).toContain('Never fill any field with placeholder text');
  });
});
