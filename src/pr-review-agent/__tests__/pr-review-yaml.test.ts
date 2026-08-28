// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression tests for the anti-refusal contracts of review-pr/agents/pr-review.yaml.
 *
 * A sub-agent that refuses (or whose `transfer_task` delegation errors) must never
 * be able to steer the review toward approval. Two layers enforce this:
 *
 *   1. Schema hardening (provider-minimal) — the drafter and verifier
 *      structured-output schemas constrain every human-meaningful string field
 *      with `minLength: 1` (rejecting the empty string and nothing more) and
 *      require line numbers >= 1. No `pattern` keyword may appear anywhere in
 *      the schemas: provider-side constrained decoding rejects any schema
 *      carrying one ("Schema is too complex" from the Docker models gateway)
 *      before a sub-agent ever runs — even a plain non-blank regex fails.
 *      Whitespace-only and bare-"placeholder" values are therefore
 *      schema-VALID refusal output; rejecting them is semantic, not syntactic.
 *   2. Orchestration contracts — the semantic layer the minimal schema cannot
 *      provide. The root instructions run a refusal content check on every
 *      parsed sub-agent response: any free-text field (drafter: each finding's
 *      `file`/`issue`/`details` plus the top-level `summary`; verifier: each
 *      verdict's `file`/`issue`/`details`) that trims — ASCII whitespace
 *      `[ \t\n\r\f]` only — to empty or to the bare literal "placeholder"
 *      (case-insensitive) voids the ENTIRE drafter response (the fallback
 *      object, `review_complete: false`, no salvage) or the WHOLE verifier
 *      batch (inconclusive COMMENT fallback before pairing — no approve, no
 *      retry, no partial merge). The root must also treat a `transfer_task`
 *      tool error exactly like empty/malformed output (never approve; never
 *      retried except under the bounded runtime-delegation retry, which is
 *      recognized-failure-only, sequential, and once per chunk), aggregate
 *      batched CI drafter responses fail-closed (merged
 *      review_complete is true only when EVERY delegation returned valid JSON
 *      with review_complete true; an incomplete merge never approves at ANY
 *      finding count and must post an explicit incomplete heading carrying the
 *      diagnostic merged summary instead of an assessment/approve label), and
 *      assign each verifier-delegated finding a deterministic `finding_id`,
 *      pairing verdicts one-to-one by that ID with an exact file+line
 *      cross-check (omission/addition/duplicate/mismatch => inconclusive
 *      COMMENT fallback, no partial merge — JSON Schema cannot express this
 *      cardinality, so it lives in the instructions).
 *
 * Honest limitation: layer 2 — the bounded retry included — is a PROMPT-LEVEL
 * contract. No runtime code intercepts `transfer_task` failures, counts retry
 * attempts, or recomputes the merged outcome; these tests pin the instruction
 * text, not an enforcement mechanism. A model that violates the contract is
 * caught by the fail-closed backstops instead: the aggregation rule keeps the
 * merged result incomplete (never approving), and review-pr/action.yml's
 * API-verified no-post detection (workflow-security tests) surfaces a run
 * that finished without posting.
 *
 * Like src/caller-permissions, this reads the YAML as text with a focused,
 * dependency-free extractor instead of pulling in a YAML parser.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const YAML_PATH = resolve(import.meta.dirname, '../../../review-pr/agents/pr-review.yaml');
const source = readFileSync(YAML_PATH, 'utf-8');

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

/**
 * Executable mirror of the semantic refusal rule the YAML documents (root
 * steps 5 and 6, drafter Output section, verifier instruction): trim ONLY
 * ASCII whitespace `[ \t\n\r\f]`, then refuse when the result is empty or is
 * exactly the literal "placeholder" compared case-insensitively. Non-ASCII
 * whitespace (e.g. NBSP) is content by contract, so an NBSP-padded
 * "placeholder" is not bare.
 */
function isRefusalContent(value: string): boolean {
  const trimmed = value.replace(/^[ \t\n\r\f]+|[ \t\n\r\f]+$/g, '');
  return trimmed === '' || trimmed.toLowerCase() === 'placeholder';
}

/**
 * The contract statement every free-text property description must carry:
 * the schema rejects only the empty string; whitespace-only and
 * bare-"placeholder" values are refusal output rejected semantically by the
 * orchestrator's instructions, never by the schema.
 */
const DESCRIPTION_CONTRACT =
  "the schema only rejects empty (minLength); whitespace-only or the bare literal 'placeholder' is refusal output rejected by instruction";

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

  it.each(
    drafterTextFields,
  )('drafter %s is minLength-only with an accurate description', (name, indent) => {
    const block = propertySubschema(drafterSchema, name, indent);
    expect(block).toContain('minLength: 1');
    expect(block).not.toContain('pattern');
    expect(block).toContain(DESCRIPTION_CONTRACT);
  });

  it.each(
    verifierTextFields,
  )('verifier %s is minLength-only with an accurate description', (name, indent) => {
    const block = propertySubschema(verifierSchema, name, indent);
    expect(block).toContain('minLength: 1');
    expect(block).not.toContain('pattern');
    expect(block).toContain(DESCRIPTION_CONTRACT);
  });

  it('keeps both schemas — and the whole file — free of the pattern keyword', () => {
    // Provider-side constrained decoding rejects any schema carrying a
    // `pattern` keyword ("Schema is too complex"), so none may reappear.
    expect(drafterSchema).not.toContain('pattern:');
    expect(verifierSchema).not.toContain('pattern:');
    expect(source).not.toContain('pattern:');
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

describe('semantic refusal rule (executable mirror)', () => {
  const refused = [
    '',
    ' ',
    '\t',
    '\f',
    '\r\n',
    '   ',
    ' \t\n ',
    ' \f \r ',
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
    'placeholdex',
    'a placeholder value reaches production',
    'place holder',
    'p',
    'N/A',
    'a b',
    'fix the bug',
    'Err — “quoted”, 100% Unicode: héllo 🚀',
    '檔案路徑/main.go',
    // NBSP is not ASCII whitespace: the rule trims `[ \t\n\r\f]` ONLY, so
    // NBSP counts as content and NBSP-padded "placeholder" is not bare.
    '\u00a0',
    'foo\u00a0bar',
    'placeholder\u00a0',
    '\u00a0placeholder\u00a0',
    'nil deref on line 12.\nTriggered when x == nil; fix: guard before use.',
    'ERROR: Diff file not found at the specified path. The orchestrator must write the diff to disk before delegating.',
  ];

  it.each(refused)('treats %j as refusal output (trimmed empty or bare placeholder)', (value) => {
    expect(isRefusalContent(value)).toBe(true);
  });

  it.each(accepted)('treats %j as real content', (value) => {
    expect(isRefusalContent(value)).toBe(false);
  });
});

describe('root orchestration contracts', () => {
  const root = normalize(rootAgent);

  it('treats a drafter transfer_task tool error as the fallback object, never approving', () => {
    expect(root).toContain('A `transfer_task` tool error counts as exactly this same case');
    expect(root).toContain(
      "treat that delegation's response as the fallback object above and NEVER approve on the basis of an errored delegation",
    );
    expect(root).toContain(
      'Do NOT retry it, with ONE narrow exception — the bounded runtime-delegation retry defined below',
    );
  });

  it('bounds the drafter retry to recognized runtime delegation failures', () => {
    // Prompt-level contract: the bound is instruction text the model follows,
    // not runtime-enforced — nothing counts retries. These assertions pin the
    // wording; the fail-closed backstops (aggregation rule, API-verified
    // no-post detection) cover a model that ignores it.
    expect(root).toContain(
      'Bounded retry for runtime delegation failures (REQUIRED — runs after the whole batch settles, BEFORE the aggregation rule below)',
    );
    // Recognition is narrow: only the runtime rejecting the delegation itself
    // (the batched-transfer misrouting seen in production) qualifies.
    expect(root).toContain(
      'a delegation error is a RUNTIME DELEGATION FAILURE only when the `transfer_task` tool call itself failed',
    );
    expect(root).toContain('"cannot transfer task"');
    expect(root).toContain('"target agent not in sub-agents list"');
    // Malformed/refusal output stays fail-closed and is never retried.
    expect(root).toContain(
      'Drafter OUTPUT that is empty, malformed, refused, partial, or schema-rejected is NEVER a runtime delegation failure and is NEVER retried',
    );
    // Sequential and bounded; successful chunks are retained.
    expect(root).toContain(
      're-delegate each such chunk exactly ONCE, one at a time (sequential single `transfer_task` calls — never re-batch retries)',
    );
    expect(root).toContain(
      "keeping every successful delegation's response from the original batch",
    );
    expect(root).toContain(
      'HARD BOUNDS: at most one retry per chunk, at most TWO retried chunks per review (when more than two chunks failed this way, retry the first two in chunk order and leave the rest as fallback objects), and one retry pass per review',
    );
    // Posting reserve: retrying never eats the budget needed to post — an
    // incomplete posted review always beats a timed-out silent one.
    expect(root).toContain('SKIP the retry pass entirely when posting time is at risk');
    expect(root).toContain('a posted incomplete review beats a timeout');
    expect(root).toContain(
      'A retry never turns a failed or incomplete chunk into a success by itself — only a valid, complete JSON response does',
    );
    // Retry attempts stay visible in the diagnostic merged summary.
    expect(root).toContain('(retried after runtime delegation failure)');
    expect(root).toContain('(runtime delegation failure; sequential retry failed)');
  });

  it('routes malformed/refused drafter partial JSON through the incomplete-review fallback', () => {
    expect(root).toContain('partial, refused, or otherwise malformed');
    expect(root).toContain(
      'placeholder/refusal text instead of real content) must not be salvaged',
    );
    expect(root).toContain(
      'treat it as the same fallback object so it follows the incomplete-review fallback below (`review_complete: false`)',
    );
  });

  it('voids an entire drafter response on refusal content (step 5)', () => {
    expect(root).toContain(
      'Refusal content check (REQUIRED — applies to every parsed drafter response)',
    );
    // The schema layer stops at the empty string; this semantic check is what
    // covers whitespace-only and bare-placeholder values.
    expect(root).toContain(
      'the schema only rejects empty strings (`minLength: 1`) — it cannot see whitespace-only or placeholder text',
    );
    expect(root).toContain(
      "Inspect every human-meaningful string in the response: each finding's `file`, `issue`, and `details`, plus the top-level `summary`.",
    );
    expect(root).toContain(
      'If ANY of these, after trimming leading and trailing ASCII whitespace `[ \\t\\n\\r\\f]`, is empty OR equals the literal `placeholder` case-insensitively, that delegation refused or emitted malformed output',
    );
    expect(root).toContain(
      'treat its ENTIRE response as the fallback object above (`review_complete: false`)',
    );
    expect(root).toContain('Do NOT salvage its other fields or findings.');
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
      'Merged `review_complete` = true ONLY IF every delegation returned valid JSON with `review_complete: true` (a chunk retried under the bounded runtime-delegation retry counts by its final result).',
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
      'the posted review MUST use the incomplete-review body from Decision Rules rule 4 (the "### ⚠️ Review incomplete" heading plus the diagnostic merged `summary`) and MUST NOT carry a "🟢 NO FINDINGS" label or any approve wording',
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
    expect(root).toContain('a would-be "🟢 NO FINDINGS" becomes "⚠️ INCOMPLETE" instead');
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

  it('reserves the zero-findings 🟢 NO FINDINGS template for complete, conclusive, zero-surviving merges', () => {
    expect(root).toContain(
      'use only when ZERO findings of ANY severity survive — none inline AND none in any summary list, low included — AND the merged `review_complete` is true AND verification, where required, was conclusive.',
    );
    expect(root).toContain(
      'Incomplete reviews must instead post the "### ⚠️ Review incomplete" body from Decision Rules rule 4, and inconclusive verification the "### ⚠️ Verification inconclusive" body — never a 🟢 NO FINDINGS body',
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
    expect(root).toContain('A `transfer_task` tool error is never grounds to approve.');
  });

  it('bounds the verifier retry to recognized runtime delegation failures', () => {
    expect(root).toContain(
      'Do NOT retry the delegation for empty, malformed, refused, or partial verifier OUTPUT.',
    );
    expect(root).toContain(
      'ONE bounded exception, mirroring step 5: a runtime delegation failure (the `transfer_task` call itself fails with e.g. "cannot transfer task" or "target agent not in sub-agents list") may be retried exactly once, sequentially',
    );
    expect(root).toContain(
      'if the retry fails for any reason, apply this fallback — never a second retry',
    );
  });

  it('keeps the inconclusive-verification fallback off the completion marker', () => {
    expect(root).toContain(
      'The inconclusive-verification body MUST open with "### ⚠️ Verification inconclusive"',
    );
    expect(root).toContain('never an "### Assessment:" line and never approve wording');
    expect(root).toContain('an unverified review must never carry it');
  });

  it('surfaces surviving low findings instead of dropping them', () => {
    // The #1814 regression: low findings skipped verification AND silently
    // vanished from the review, which then claimed a clean result.
    expect(root).toContain(
      'Skip verification for "low" findings — but NEVER drop them: every surviving "low" finding stays in the review as a summary-only entry',
    );
    expect(root).toContain('Low-severity findings (not verified, not posted inline)');
    expect(root).toContain(
      'blocks the 🟢 NO FINDINGS label like any other surviving finding (Decision Rules rules 1–3)',
    );
    // Step 9 builds the dedicated review-body section.
    expect(root).toContain('**Low-severity summary** — surviving low-severity findings');
    expect(root).toContain(
      'Never silently drop these: each one blocks the 🟢 NO FINDINGS label (Decision Rules rule 3).',
    );
  });

  it('drives the assessment from every surviving finding, approving only on zero', () => {
    // The TS module is an executable spec/mirror of these rules, honestly
    // labeled as such — the prompt must never claim a runtime enforcer exists.
    expect(root).toContain(
      'YOU apply these rules — nothing else recomputes the assessment at runtime.',
    );
    expect(root).toContain(
      '`src/review-assessment/review-assessment.ts` is their executable spec: an outcome-for-outcome mirror pinned by unit tests, not a runtime enforcer.',
    );
    expect(root).not.toContain('authoritative implementation of rules 1–4');
    expect(root).toContain('**Collect the SURVIVING findings**');
    expect(root).toContain(
      'inline comments, the lower-confidence summary, the medium-severity floor list, and the unverified low-severity list',
    );
    expect(root).toContain(
      'ANY other surviving finding (NOTABLE or MINOR — any severity, any surfaced disposition) → label as "🟡 NEEDS ATTENTION"',
    );
    expect(root).toContain('EXACTLY ZERO surviving findings → label as "🟢 NO FINDINGS"');
    expect(root).toContain(
      '"🟢 NO FINDINGS" is emitted ONLY for a complete review (merged `review_complete` true) with conclusive verification and zero surviving findings of EVERY severity.',
    );
    expect(root).toContain(
      'A review that surfaces ANY finding — inline or summary-only, including a single unverified low — must NOT carry the NO FINDINGS label.',
    );
    expect(root).toContain(
      'The label is a neutral completion marker, NEVER an approval: the bot never approves a PR, so no body may say "APPROVE", "LGTM", or "No issues found".',
    );
  });

  it('lists low-severity findings in the console format', () => {
    expect(root).toContain('### Low-severity findings (not verified, not posted inline)');
    expect(root).toContain(
      'Omit the "Lower-confidence", "Low-severity", and "Dismissed security" sections when they have no entries.',
    );
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

  it('fails the whole verifier batch closed on refusal content (step 6)', () => {
    const refusalCheck = root.indexOf(
      'Refusal content check (REQUIRED — first, before the pairing check, scope filtering, or any merge)',
    );
    expect(refusalCheck).toBeGreaterThan(-1);
    // The refusal check runs before pairing, so refusal text never reaches
    // the pairing/scope/merge machinery.
    expect(refusalCheck).toBeLessThan(root.indexOf('Pairing check (REQUIRED'));
    expect(root).toContain("inspect every verdict's free-text fields (`file`, `issue`, `details`)");
    expect(root).toContain(
      'If ANY of these, after trimming leading and trailing ASCII whitespace `[ \\t\\n\\r\\f]`, is empty OR equals the literal `placeholder` case-insensitively, the verifier refused',
    );
    expect(root).toContain(
      'so this semantic check is what rejects whitespace-only and placeholder output',
    );
    expect(root).toContain(
      'Treat the WHOLE batch as malformed/inconclusive and apply the ANTI-LOOP fallback from step 5',
    );
    expect(root).toContain(
      "post a COMMENT review with the drafter's unverified findings and a note that verification was inconclusive",
    );
    expect(root).toContain(
      'Do NOT approve, do NOT retry the delegation, and do NOT partially merge the verdicts that look clean.',
    );
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

  it('forbids blank/placeholder text semantically (the schema only rejects empty)', () => {
    expect(verifier).toContain('Never fill any field with blank or placeholder text');
    expect(verifier).toContain(
      'the schema only rejects empty strings (`minLength: 1`), and the orchestrator treats any free-text field that trims (ASCII whitespace) to empty or to the bare literal "placeholder" as refusal output',
    );
    expect(verifier).toContain('marking the response malformed and the whole batch inconclusive');
    expect(verifier).not.toContain('the schema rejects it');
  });
});

describe('posting template hazards', () => {
  const template = readFileSync(
    resolve(import.meta.dirname, '../../../review-pr/agents/refs/posting-format.md'),
    'utf-8',
  );

  it('has no REVIEW_BODY assignment at all — posting is guarded on the computed outcome', () => {
    // The old template pre-assigned an assessment badge to a REVIEW_BODY shell
    // variable; every run that copied it verbatim posted a label it never
    // computed (template bleed). Now no shell variable exists at all: the body
    // is a quoted-heredoc file, and the chained posting command reaches
    // `gh api` only after `test -s` and the trusted finalize-body validator
    // accept it (exactly one computed status line, staged comments file parsed
    // and 🟢 NO FINDINGS refused over any staged comment, marker appended
    // mechanically). The workflow-security harness executes this chain.
    expect(template).not.toMatch(/^REVIEW_BODY=/m);
    expect(template).not.toMatch(/\$REVIEW_BODY|\$\{REVIEW_BODY/);
    expect(template).toContain("cat > /tmp/review_body.md << 'REVIEW_BODY_EOF'");
    expect(template).toContain('test -s /tmp/review_body.md \\');
    expect(template).toContain(
      '&& node /tmp/review-assessment.js finalize-body /tmp/review_body.md __REVIEW_RUN_NONCE__ /tmp/review_comments.json \\',
    );
    expect(template).toContain('--rawfile body /tmp/review_body.md');
    expect(template).toContain('(the ONLY zero-findings outcome');
    // The payload is staged to a trusted temp file and validated so `gh api`
    // is never invoked when jq fails to construct it (no `jq | gh` pipe).
    expect(template).toContain('> /tmp/review_payload.json \\');
    expect(template).toContain(
      `&& jq -e 'type == "object"' /tmp/review_payload.json > /dev/null \\`,
    );
    expect(template).not.toMatch(/\|\s*gh api/);
  });

  it('routes through action-staged placeholders, not literal {owner}/{repo}/{pr}', () => {
    // Every recent successful run first 404ed on the literal route before the
    // model hand-corrected it; trusted routing data is staged by the action.
    expect(template).not.toMatch(/\{owner\}|\{repo\}|\{pr\}/);
    expect(template).toContain(
      '&& gh api "repos/__REPOSITORY__/pulls/__PR_NUMBER__/reviews" --input - < /tmp/review_payload.json',
    );
    expect(template).toContain('--arg commit_id "__PR_HEAD_SHA__"');
    expect(template).toContain('Run the chained command exactly as rendered');
  });

  it('documents the non-approving body outcomes, including the low-severity list', () => {
    expect(template).toContain('"### ⚠️ Review incomplete" (never an "### Assessment:" line)');
    expect(template).toContain('"### ⚠️ Verification inconclusive"');
    expect(template).toContain('#### Low-severity findings (not verified, not posted inline)');
    expect(template).toContain(
      'complete review, conclusive verification, ZERO surviving findings of every',
    );
  });
});

describe('COMMENT-event and neutral zero-findings label invariants', () => {
  const template = readFileSync(
    resolve(import.meta.dirname, '../../../review-pr/agents/refs/posting-format.md'),
    'utf-8',
  );

  // Matches an event being SET to an approving value (jq --arg, JSON, YAML, or
  // shell assignment) while skipping prose prohibitions like "never `APPROVE`",
  // where words separate "event" from the value.
  const approvingEventAssignment = /event\W{0,4}(?:APPROVE|REQUEST_CHANGES)/;

  it('pins the COMMENT event and prohibits the approving events in the instructions', () => {
    const root = normalize(rootAgent);
    expect(root).toContain(
      'ALWAYS use the `COMMENT` event — never `APPROVE` or `REQUEST_CHANGES`.',
    );
    expect(root).toContain(
      'The GitHub review event is ALWAYS `COMMENT`, regardless of the assessment label. Never use `APPROVE` or `REQUEST_CHANGES`.',
    );
  });

  it('never sets an APPROVE or REQUEST_CHANGES event in the yaml or the posting template', () => {
    expect(source).not.toMatch(approvingEventAssignment);
    expect(template).not.toMatch(approvingEventAssignment);
    // The posting command hardcodes the COMMENT event, and no other event
    // value is ever passed to jq.
    expect(template).toContain('--arg event "COMMENT"');
    expect(template.match(/--arg event "/g)).toEqual(['--arg event "']);
  });

  it('keeps the retired 🟢 APPROVE label and legacy LGTM wording out of the active policy', () => {
    // The zero-findings outcome is the neutral 🟢 NO FINDINGS label; only
    // historical reviews may carry "### Assessment: 🟢 APPROVE", and only
    // src/incremental-review's marker matching still recognizes them.
    for (const text of [source, template]) {
      expect(text).not.toContain('🟢 APPROVE');
      expect(text).not.toContain('LGTM!');
      expect(text).not.toContain('🟢 **No issues found**');
    }
    expect(source).toContain('label as "🟢 NO FINDINGS"');
    expect(template).toContain('"### Assessment: 🟢 NO FINDINGS"');
  });
});
