// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the review-assessment module.
 *
 * assessReview() is a tested MIRROR of the Decision Rules prose in
 * review-pr/agents/pr-review.yaml — the model applies the rules, these tests
 * pin the policy outcomes. The rest of the module is runtime logic bundled to
 * dist/review-assessment.js and invoked by review-pr/action.yml: the
 * finalize-body posting validator, the per-run attribution marker, and the
 * fail-closed post-run classification (the shell harness in
 * src/resolve-trigger-context/__tests__/workflow-security.test.ts executes
 * the same code through the built CLI).
 *
 * The outcomes pinned are the ones that regressed in production
 * (docker/gordon PRs #1798/#1803/#1808/#1809 false LGTMs, #1814 an approving
 * zero-finding label over three surviving low findings): only completed-run
 * headers may advance the last-reviewed SHA, and no header — the zero-findings
 * one included — may ever present the bot as approving the PR.
 */
import { describe, expect, it } from 'vitest';
import { findLastReviewedSha } from '../../incremental-review/incremental-review.js';
import {
  ASSESSMENT_MARKER,
  type AssessmentInput,
  assessReview,
  classifyReviewBody,
  classifyRunReviews,
  finalizeReviewBody,
  hasRunMarker,
  INCOMPLETE_HEADER,
  INCONCLUSIVE_HEADER,
  isActionPostedReview,
  isValidRunNonce,
  NO_FINDINGS_LABEL,
  type PostedReviewLike,
  runMarker,
  type SurvivingFinding,
} from '../review-assessment.js';

const high = (disposition: SurvivingFinding['disposition'] = 'inline'): SurvivingFinding => ({
  severity: 'high',
  disposition,
  verdict: 'CONFIRMED',
});
const medium = (disposition: SurvivingFinding['disposition'] = 'inline'): SurvivingFinding => ({
  severity: 'medium',
  disposition,
  verdict: 'LIKELY',
});
/** Unverified low finding: verification is skipped, no verdict. */
const low = (): SurvivingFinding => ({ severity: 'low', disposition: 'summary' });

function complete(survivingFindings: SurvivingFinding[]): AssessmentInput {
  return { reviewComplete: true, verificationConclusive: true, survivingFindings };
}

describe('assessReview', () => {
  it('labels a complete, conclusive review with zero surviving findings 🟢 NO FINDINGS', () => {
    const outcome = assessReview(complete([]));
    expect(outcome).toEqual({
      kind: 'no-findings',
      header: '### Assessment: 🟢 NO FINDINGS',
      completedRun: true,
    });
  });

  it('never reports zero findings on a single surviving low finding (summary-only)', () => {
    const outcome = assessReview(complete([low()]));
    expect(outcome.kind).toBe('needs-attention');
    expect(outcome.header).toBe('### Assessment: 🟡 NEEDS ATTENTION');
    expect(outcome.header).not.toContain(NO_FINDINGS_LABEL);
    expect(outcome.completedRun).toBe(true);
  });

  it('never reports zero findings when only summary-disposition findings survive', () => {
    // The #1814 regression: assessment was driven by inline findings only, so
    // three surviving low findings were silently dropped into a clean label.
    const outcome = assessReview(complete([low(), low(), low()]));
    expect(outcome.kind).toBe('needs-attention');
  });

  it('labels surviving medium findings as needs-attention regardless of disposition', () => {
    expect(assessReview(complete([medium('summary')])).kind).toBe('needs-attention');
    expect(assessReview(complete([medium()])).kind).toBe('needs-attention');
  });

  it('labels any surviving verified high finding as critical', () => {
    const outcome = assessReview(complete([low(), medium(), high()]));
    expect(outcome.kind).toBe('critical');
    expect(outcome.header).toBe('### Assessment: 🔴 CRITICAL');
  });

  it('reports incomplete reviews without an assessment marker at any finding count', () => {
    for (const survivingFindings of [[], [low()], [high(), medium()]]) {
      const outcome = assessReview({
        reviewComplete: false,
        verificationConclusive: true,
        survivingFindings,
      });
      expect(outcome.kind).toBe('incomplete');
      expect(outcome.header).toBe(INCOMPLETE_HEADER);
      expect(outcome.header).not.toContain(ASSESSMENT_MARKER);
      expect(outcome.completedRun).toBe(false);
    }
  });

  it('incompleteness overrides inconclusive verification', () => {
    const outcome = assessReview({
      reviewComplete: false,
      verificationConclusive: false,
      survivingFindings: [],
    });
    expect(outcome.kind).toBe('incomplete');
  });

  it('reports inconclusive verification without an assessment marker or clean label', () => {
    for (const survivingFindings of [[], [medium()], [high()]]) {
      const outcome = assessReview({
        reviewComplete: true,
        verificationConclusive: false,
        survivingFindings,
      });
      expect(outcome.kind).toBe('inconclusive');
      expect(outcome.header).toBe(INCONCLUSIVE_HEADER);
      expect(outcome.header).not.toContain(ASSESSMENT_MARKER);
      expect(outcome.completedRun).toBe(false);
    }
  });

  it('never emits the NO FINDINGS label outside the zero-findings outcome', () => {
    const inputs: AssessmentInput[] = [
      complete([low()]),
      complete([medium()]),
      complete([high()]),
      { reviewComplete: false, verificationConclusive: true, survivingFindings: [] },
      { reviewComplete: true, verificationConclusive: false, survivingFindings: [] },
    ];
    for (const input of inputs) {
      expect(assessReview(input).header).not.toContain(NO_FINDINGS_LABEL);
    }
  });

  it('never emits approve or LGTM wording in ANY outcome, zero-findings included', () => {
    // The bot only ever posts COMMENT reviews; no body header may present it
    // as approving the PR — the legacy "🟢 APPROVE" label must never return.
    const inputs: AssessmentInput[] = [
      complete([]),
      complete([low()]),
      complete([medium()]),
      complete([high()]),
      { reviewComplete: false, verificationConclusive: true, survivingFindings: [] },
      { reviewComplete: false, verificationConclusive: true, survivingFindings: [high()] },
      { reviewComplete: true, verificationConclusive: false, survivingFindings: [] },
    ];
    for (const input of inputs) {
      const header = assessReview(input).header;
      expect(header).not.toMatch(/approve|lgtm|no issues found/i);
    }
  });
});

describe('incremental checkpoint cross-check', () => {
  const SHA = 'a'.repeat(40);

  function botReview(body: string) {
    return {
      user: { login: 'docker-agent' },
      body,
      commit_id: SHA,
      submitted_at: '2026-01-01T10:00:00Z',
    };
  }

  it.each([
    complete([]),
    complete([low()]),
    complete([high()]),
    { reviewComplete: false, verificationConclusive: true, survivingFindings: [] },
    { reviewComplete: false, verificationConclusive: true, survivingFindings: [high()] },
    { reviewComplete: true, verificationConclusive: false, survivingFindings: [medium()] },
  ] as AssessmentInput[])('advances the checkpoint iff the outcome is a completed run (%j)', (input) => {
    const outcome = assessReview(input);
    const sha = findLastReviewedSha([botReview(outcome.header)]);
    expect(sha).toBe(outcome.completedRun ? SHA : null);
  });
});

const NONCE = '0123456789abcdef0123456789abcdef';
const MARKER = `<!-- docker-agent-review-run:${NONCE} -->`;

describe('run marker primitives', () => {
  it('accepts only 32 lowercase hex nonces', () => {
    expect(isValidRunNonce(NONCE)).toBe(true);
    for (const bad of ['', 'g'.repeat(32), NONCE.slice(1), `${NONCE}0`, NONCE.toUpperCase()]) {
      expect(isValidRunNonce(bad), bad).toBe(false);
      expect(() => runMarker(bad), bad).toThrow(/32 lowercase hex/);
    }
  });

  it('builds the fixed-format marker and recognizes it with any nonce', () => {
    expect(runMarker(NONCE)).toBe(MARKER);
    expect(hasRunMarker(`### Assessment: 🟡 NEEDS ATTENTION\n\n${MARKER}`)).toBe(true);
    expect(hasRunMarker(`x <!-- docker-agent-review-run:${'f'.repeat(32)} --> y`)).toBe(true);
    // Malformed variants never match — attribution needs the exact format.
    expect(hasRunMarker('<!-- docker-agent-review-run:zzzz -->')).toBe(false);
    expect(hasRunMarker('<!-- docker-agent-review -->')).toBe(false);
    expect(hasRunMarker(null)).toBe(false);
  });
});

describe('isActionPostedReview', () => {
  it('accepts the legacy docker-agent login variants without a marker', () => {
    expect(isActionPostedReview('docker-agent', 'any body')).toBe(true);
    expect(isActionPostedReview('docker-agent[bot]', 'any body')).toBe(true);
  });

  it('accepts marker-bearing reviews from [bot]-suffixed logins (default token)', () => {
    expect(isActionPostedReview('github-actions[bot]', `body\n${MARKER}`)).toBe(true);
    expect(isActionPostedReview('consumer-app[bot]', `body\n${MARKER}`)).toBe(true);
  });

  it('rejects marker-bearing reviews from human logins (forgeable marker)', () => {
    // GitHub reserves the [bot] suffix for installed Apps; a PR author could
    // paste a well-formed marker into their own review, so plain user logins
    // must never qualify — a forged checkpoint would skip unreviewed commits.
    expect(isActionPostedReview('mallory', `body\n${MARKER}`)).toBe(false);
    expect(isActionPostedReview('github-actions[bot]', 'no marker')).toBe(false);
    expect(isActionPostedReview(null, `body\n${MARKER}`)).toBe(false);
  });
});

describe('classifyReviewBody', () => {
  it.each([
    '### Assessment: 🟢 NO FINDINGS',
    '### Assessment: 🟡 NEEDS ATTENTION',
    '### Assessment: 🔴 CRITICAL',
  ])('classifies %s as completed', (line) => {
    expect(classifyReviewBody(line)).toEqual({ kind: 'completed', assessment: line });
  });

  it('keeps legitimate note text before the single status line supported', () => {
    const body = [
      'This review covers only the commits since `abc123def456`.',
      '',
      '### Assessment: 🟡 NEEDS ATTENTION',
      '',
      '#### Lower-confidence findings (not posted inline)',
      '- [medium] file.go:42 — issue (confidence: weak 48/100)',
    ].join('\n');
    expect(classifyReviewBody(body).kind).toBe('completed');
  });

  it('maps the incomplete and inconclusive headers to their statuses', () => {
    expect(classifyReviewBody(`${INCOMPLETE_HEADER}\nchunk 2: Drafter did not complete`)).toEqual({
      kind: 'incomplete',
    });
    expect(classifyReviewBody('⚠️ **Review incomplete** — no review was posted.')).toEqual({
      kind: 'incomplete',
    });
    expect(classifyReviewBody(`${INCONCLUSIVE_HEADER}\nUnverified findings below.`)).toEqual({
      kind: 'inconclusive',
    });
  });

  it('lets incompleteness outrank inconclusive verification (rule 4 combination)', () => {
    expect(
      classifyReviewBody(`${INCOMPLETE_HEADER}\n\n${INCONCLUSIVE_HEADER} for chunk 2.`),
    ).toEqual({ kind: 'incomplete' });
  });

  it.each([
    ['bodyless', ''],
    ['whitespace-only', '  \n\t '],
    ['unknown body', 'Some prose that never states an outcome.'],
    ['unknown assessment label', '### Assessment: 🟣 MYSTERY'],
    ['legacy approve label', '### Assessment: 🟢 APPROVE'],
    ['assessment not on its own line', 'note ### Assessment: 🟡 NEEDS ATTENTION trailing'],
    ['conflicting assessment + incomplete', `${INCOMPLETE_HEADER}\n### Assessment: 🟢 NO FINDINGS`],
    [
      'conflicting assessment + inconclusive',
      `${INCONCLUSIVE_HEADER}\n### Assessment: 🔴 CRITICAL`,
    ],
    [
      'multiple assessment lines',
      '### Assessment: 🟡 NEEDS ATTENTION\n### Assessment: 🔴 CRITICAL',
    ],
    ['LGTM wording', '### Assessment: 🟢 NO FINDINGS\n\nLGTM!'],
    ['lowercase lgtm wording', '### Assessment: 🟢 NO FINDINGS\n\nlgtm 🚀'],
    ['APPROVE wording', '### Assessment: 🟡 NEEDS ATTENTION\n\nI APPROVE this change.'],
    ['APPROVED wording', 'APPROVED\n### Assessment: 🟢 NO FINDINGS'],
    ['no-issues wording', '🟢 **No issues found** — all good.'],
    [
      'NO FINDINGS over a findings section',
      '### Assessment: 🟢 NO FINDINGS\n\n#### Low-severity findings (not verified, not posted inline)\n- [low] a.go:1 — x',
    ],
    [
      'NO FINDINGS over a lower-confidence section',
      '### Assessment: 🟢 NO FINDINGS\n\n#### Lower-confidence findings (not posted inline)\n- [medium] a.go:1 — x',
    ],
    [
      'NO FINDINGS over an inline findings section',
      '### Assessment: 🟢 NO FINDINGS\n\n### Findings\n**[high] a.go:1 — x**',
    ],
  ])('fails closed on %s', (_name, body) => {
    expect(classifyReviewBody(body).kind).toBe('invalid');
  });

  it('does not refuse prose words that merely contain approve', () => {
    const body =
      '### Assessment: 🟡 NEEDS ATTENTION\n\nThe approveTransfer() call skips validation.';
    expect(classifyReviewBody(body).kind).toBe('completed');
  });
});

describe('finalizeReviewBody', () => {
  it('appends the run marker exactly once (idempotent for the same nonce)', () => {
    const once = finalizeReviewBody('### Assessment: 🟢 NO FINDINGS\n', NONCE, 0);
    expect(once).toBe(`### Assessment: 🟢 NO FINDINGS\n\n${MARKER}\n`);
    expect(finalizeReviewBody(once, NONCE, 0)).toBe(once);
  });

  it('refuses invalid bodies with the classification reason', () => {
    expect(() => finalizeReviewBody('LGTM!', NONCE, 0)).toThrow(/refusing to post review body/);
    expect(() => finalizeReviewBody('no status here', NONCE, 0)).toThrow(
      /no recognized status line/,
    );
  });

  it('refuses a body carrying a marker from a different run', () => {
    const stale = `### Assessment: 🟢 NO FINDINGS\n\n<!-- docker-agent-review-run:${'f'.repeat(32)} -->`;
    expect(() => finalizeReviewBody(stale, NONCE, 0)).toThrow(/different run/);
  });

  it('refuses 🟢 NO FINDINGS over staged inline comments', () => {
    // The zero-findings label asserts zero surviving findings of every
    // severity — a staged inline comment contradicts it at posting time.
    expect(() => finalizeReviewBody('### Assessment: 🟢 NO FINDINGS\n', NONCE, 1)).toThrow(
      /🟢 NO FINDINGS cannot be posted with 1 staged inline comment/,
    );
    expect(() => finalizeReviewBody('### Assessment: 🟢 NO FINDINGS\n', NONCE, 3)).toThrow(
      /3 staged inline comment/,
    );
  });

  it('refuses malformed comment counts instead of guessing', () => {
    for (const count of [-1, 0.5, Number.NaN]) {
      expect(() =>
        finalizeReviewBody('### Assessment: 🟡 NEEDS ATTENTION\n', NONCE, count),
      ).toThrow(/non-negative integer/);
    }
  });

  it('accepts staged inline comments for every other recognized outcome', () => {
    for (const body of [
      '### Assessment: 🟡 NEEDS ATTENTION\n',
      '### Assessment: 🔴 CRITICAL\n',
      '### ⚠️ Review incomplete\nchunk 2: Drafter did not complete\n',
      '### ⚠️ Verification inconclusive\nUnverified findings below.\n',
    ]) {
      expect(finalizeReviewBody(body, NONCE, 2), body).toContain(MARKER);
    }
  });
});

describe('classifyRunReviews', () => {
  const SHA = 'a'.repeat(40);
  const OTHER_SHA = 'b'.repeat(40);
  const BASELINE = 100;
  const opts = { sha: SHA, baselineId: BASELINE, nonce: NONCE };

  function posted(overrides: Partial<PostedReviewLike> = {}): PostedReviewLike {
    return {
      id: 101,
      user: { login: 'github-actions[bot]' },
      body: `### Assessment: 🟡 NEEDS ATTENTION\n\n${MARKER}\n`,
      commit_id: SHA,
      state: 'COMMENTED',
      ...overrides,
    };
  }

  it('classifies exactly one valid COMMENTED marker-bearing review as completed', () => {
    const result = classifyRunReviews([posted()], opts);
    expect(result.status).toBe('completed');
    expect(result.reviewId).toBe(101);
  });

  it('attributes by exact marker regardless of the posting login', () => {
    for (const login of ['docker-agent', 'docker-agent[bot]', 'consumer-machine-user', null]) {
      expect(classifyRunReviews([posted({ user: { login } })], opts).status, String(login)).toBe(
        'completed',
      );
    }
  });

  it('maps agent-posted incomplete and inconclusive bodies to their statuses', () => {
    const incomplete = posted({
      body: `${INCOMPLETE_HEADER}\nchunk 2: Drafter did not complete\n\n${MARKER}\n`,
    });
    expect(classifyRunReviews([incomplete], opts).status).toBe('incomplete');
    const inconclusive = posted({
      body: `${INCONCLUSIVE_HEADER}\nUnverified findings below.\n\n${MARKER}\n`,
    });
    expect(classifyRunReviews([inconclusive], opts).status).toBe('inconclusive');
  });

  it('reports none when nothing carries the marker (unrelated same-SHA human reviews ignored)', () => {
    const result = classifyRunReviews(
      [
        { id: 90, user: { login: 'docker-agent' }, body: 'old review', commit_id: SHA },
        { id: 105, user: { login: 'human-reviewer' }, body: 'nice', commit_id: SHA },
      ],
      opts,
    );
    expect(result.status).toBe('none');
  });

  it.each([
    ['stale marker at/below the baseline', [posted({ id: BASELINE })]],
    ['marker on a different SHA', [posted({ commit_id: OTHER_SHA })]],
    ['duplicate exact-marker reviews', [posted(), posted({ id: 102 })]],
    ['non-numeric review ID', [posted({ id: null })]],
    ['PENDING state', [posted({ state: 'PENDING' })]],
    ['APPROVED state', [posted({ state: 'APPROVED' })]],
    ['CHANGES_REQUESTED state', [posted({ state: 'CHANGES_REQUESTED' })]],
    ['missing state', [posted({ state: undefined })]],
    [
      'conflicting body',
      [posted({ body: `${INCOMPLETE_HEADER}\n### Assessment: 🟢 NO FINDINGS\n${MARKER}` })],
    ],
    ['unknown body', [posted({ body: `mystery\n${MARKER}` })]],
    ['LGTM body', [posted({ body: `### Assessment: 🟢 NO FINDINGS\nLGTM!\n${MARKER}` })]],
    ['legacy approve label', [posted({ body: `### Assessment: 🟢 APPROVE\n${MARKER}` })]],
    [
      'fresh same-SHA bot review without a marker',
      [
        {
          id: 101,
          user: { login: 'github-actions[bot]' },
          body: 'no marker',
          commit_id: SHA,
          state: 'COMMENTED',
        },
      ],
    ],
    [
      'fresh same-SHA docker-agent review without a marker',
      [
        {
          id: 101,
          user: { login: 'docker-agent' },
          body: '### Assessment: 🟢 NO FINDINGS',
          commit_id: SHA,
          state: 'COMMENTED',
        },
      ],
    ],
  ] as [string, PostedReviewLike[]][])('fails closed as unverified on %s', (_name, reviews) => {
    expect(classifyRunReviews(reviews, opts).status).toBe('unverified');
  });

  it('fails closed on malformed inputs instead of guessing', () => {
    expect(classifyRunReviews([posted()], { ...opts, sha: 'nope' }).status).toBe('unverified');
    expect(classifyRunReviews([posted()], { ...opts, baselineId: -1 }).status).toBe('unverified');
    expect(classifyRunReviews([posted()], { ...opts, baselineId: 0.5 }).status).toBe('unverified');
    expect(classifyRunReviews([posted()], { ...opts, nonce: 'short' }).status).toBe('unverified');
  });

  it('reports a prior incomplete notice pinned to the same SHA by an action identity', () => {
    const notice = (login: string, body: string, commitId = SHA): PostedReviewLike => ({
      id: 60,
      user: { login },
      body,
      commit_id: commitId,
      state: 'COMMENTED',
    });
    const plain = '⚠️ **Review incomplete** — The review agent finished without posting a review.';
    const marked = `${plain}\n\n<!-- docker-agent-review-run:${'f'.repeat(32)} -->`;
    expect(classifyRunReviews([notice('docker-agent', plain)], opts).priorIncompleteNotice).toBe(
      true,
    );
    expect(
      classifyRunReviews([notice('docker-agent[bot]', plain)], opts).priorIncompleteNotice,
    ).toBe(true);
    // Custom-token notices are recognized by their (older) run marker.
    expect(
      classifyRunReviews([notice('github-actions[bot]', marked)], opts).priorIncompleteNotice,
    ).toBe(true);
    // Human same-worded reviews and other-SHA notices never dedup.
    expect(classifyRunReviews([notice('human', plain)], opts).priorIncompleteNotice).toBe(false);
    expect(
      classifyRunReviews([notice('docker-agent', plain, OTHER_SHA)], opts).priorIncompleteNotice,
    ).toBe(false);
  });
});
