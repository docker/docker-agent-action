// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for src/score-confidence.
 *
 * The model is pinned value-by-value: the 18-cell core subtotal table, the
 * concordance term, the clamp, the band boundaries, both hard gates (scope and
 * dismissed), the per-finding posting policy, and the cross-finding comment cap.
 *
 * The provable invariants from the design spec are asserted directly:
 *   - strict monotonicity in evidence and context,
 *   - only CONFIRMED can reach the strong band (LIKELY tops out at 75),
 *   - DISMISSED and out-of-scope always score 0.
 *
 * The 12 worked examples from the locked spec are encoded as a data-driven
 * fixture so any constant drift fails loudly.
 */
import { describe, expect, it } from 'vitest';
import {
  bandFor,
  COMMENT_CAP,
  type ContextCompleteness,
  DEFAULT_POST_THRESHOLD,
  type EvidenceStrength,
  type FindingInput,
  MODERATE_THRESHOLD,
  resolvePostThreshold,
  type ScorableVerdict,
  type Severity,
  STRONG_THRESHOLD,
  scoreFinding,
  scoreFindings,
  WEAK_THRESHOLD,
} from '../score-confidence.js';

// ── Fixture helpers ───────────────────────────────────────────────────────────

/**
 * Build an in-scope, non-forced CONFIRMED finding. Defaults score well into the
 * moderate/strong range; override any field to exercise a specific rule.
 */
function makeFinding(overrides: Partial<FindingInput> = {}): FindingInput {
  return {
    file: 'pkg/app/handler.go',
    line: 42,
    category: 'logic_error',
    verdict: 'CONFIRMED',
    evidenceStrength: 'direct',
    contextCompleteness: 'full',
    drafterSeverity: 'medium',
    verifierSeverity: 'medium',
    inDiff: true,
    inChangedCode: true,
    ...overrides,
  };
}

const EVIDENCE: EvidenceStrength[] = ['direct', 'circumstantial', 'speculative'];
const CONTEXT: ContextCompleteness[] = ['full', 'partial', 'none'];
const SCORABLE: ScorableVerdict[] = ['CONFIRMED', 'LIKELY'];
const SEVERITIES: Severity[] = ['high', 'medium', 'low'];

// ── Core subtotal table (verdict × evidence × context) ───────────────────────

describe('core subtotal table', () => {
  // The documented 3×3×3 table from the locked spec. With d0 concordance
  // (medium↔medium → +5) the score is subtotal + 5, so we assert breakdown.subtotal.
  const TABLE: Record<ScorableVerdict, Record<EvidenceStrength, [number, number, number]>> = {
    CONFIRMED: {
      direct: [100, 92, 78],
      circumstantial: [90, 82, 68],
      speculative: [78, 70, 56],
    },
    LIKELY: {
      direct: [70, 62, 48],
      circumstantial: [60, 52, 38],
      speculative: [48, 40, 26],
    },
  };

  for (const verdict of SCORABLE) {
    for (const evidence of EVIDENCE) {
      CONTEXT.forEach((context, ctxIdx) => {
        const expected = TABLE[verdict][evidence][ctxIdx];
        it(`${verdict}/${evidence}/${context} → subtotal ${expected}`, () => {
          const r = scoreFinding(
            makeFinding({ verdict, evidenceStrength: evidence, contextCompleteness: context }),
          );
          expect(r.breakdown.subtotal).toBe(expected);
        });
      });
    }
  }
});

// ── Concordance (drafter vs verifier severity) ───────────────────────────────

describe('severity concordance', () => {
  it('same severity (d0) → +5', () => {
    const r = scoreFinding(makeFinding({ drafterSeverity: 'medium', verifierSeverity: 'medium' }));
    expect(r.breakdown.severityDistance).toBe(0);
    expect(r.breakdown.concordance).toBe(5);
  });

  it('one step apart (d1) → 0', () => {
    const r = scoreFinding(makeFinding({ drafterSeverity: 'high', verifierSeverity: 'medium' }));
    expect(r.breakdown.severityDistance).toBe(1);
    expect(r.breakdown.concordance).toBe(0);
  });

  it('high vs low (d2) → −8', () => {
    const r = scoreFinding(makeFinding({ drafterSeverity: 'high', verifierSeverity: 'low' }));
    expect(r.breakdown.severityDistance).toBe(2);
    expect(r.breakdown.concordance).toBe(-8);
  });

  it('concordance is symmetric (low vs high == high vs low)', () => {
    const a = scoreFinding(makeFinding({ drafterSeverity: 'low', verifierSeverity: 'high' }));
    const b = scoreFinding(makeFinding({ drafterSeverity: 'high', verifierSeverity: 'low' }));
    expect(a.breakdown.concordance).toBe(b.breakdown.concordance);
  });
});

// ── score = subtotal + concordance, clamped to [0,100] ───────────────────────

describe('score composition and clamp', () => {
  it('score = subtotal + concordance', () => {
    // LIKELY/circumstantial/partial subtotal 52, d0 +5 → 57.
    const r = scoreFinding(
      makeFinding({
        verdict: 'LIKELY',
        evidenceStrength: 'circumstantial',
        contextCompleteness: 'partial',
      }),
    );
    expect(r.score).toBe(57);
  });

  it('clamps the high end at 100 (CONFIRMED/direct/full + d0 = 105 → 100)', () => {
    const r = scoreFinding(makeFinding({ drafterSeverity: 'high', verifierSeverity: 'high' }));
    expect(r.breakdown.subtotal).toBe(100);
    expect(r.breakdown.concordance).toBe(5);
    expect(r.score).toBe(100);
  });

  it('never produces a negative in-scope score (min cell 26 − 8 = 18)', () => {
    const r = scoreFinding(
      makeFinding({
        verdict: 'LIKELY',
        evidenceStrength: 'speculative',
        contextCompleteness: 'none',
        drafterSeverity: 'low',
        verifierSeverity: 'high',
      }),
    );
    expect(r.score).toBe(18);
  });
});

// ── Invariants ───────────────────────────────────────────────────────────────

describe('invariant: strict monotonicity in evidence', () => {
  for (const verdict of SCORABLE) {
    for (const context of CONTEXT) {
      it(`${verdict}/*/${context}: direct > circumstantial > speculative`, () => {
        const sub = (evidence: EvidenceStrength) =>
          scoreFinding(
            makeFinding({ verdict, evidenceStrength: evidence, contextCompleteness: context }),
          ).breakdown.subtotal;
        expect(sub('direct')).toBeGreaterThan(sub('circumstantial'));
        expect(sub('circumstantial')).toBeGreaterThan(sub('speculative'));
      });
    }
  }
});

describe('invariant: monotonicity in context', () => {
  for (const verdict of SCORABLE) {
    for (const evidence of EVIDENCE) {
      it(`${verdict}/${evidence}/*: full > partial > none`, () => {
        const sub = (context: ContextCompleteness) =>
          scoreFinding(
            makeFinding({ verdict, evidenceStrength: evidence, contextCompleteness: context }),
          ).breakdown.subtotal;
        expect(sub('full')).toBeGreaterThan(sub('partial'));
        expect(sub('partial')).toBeGreaterThan(sub('none'));
      });
    }
  }
});

describe('invariant: only CONFIRMED can reach the strong band', () => {
  it('LIKELY tops out at 75 (5 below the strong floor of 80)', () => {
    let maxLikely = 0;
    for (const evidence of EVIDENCE) {
      for (const context of CONTEXT) {
        for (const drafterSeverity of SEVERITIES) {
          for (const verifierSeverity of SEVERITIES) {
            const { score } = scoreFinding(
              makeFinding({
                verdict: 'LIKELY',
                evidenceStrength: evidence,
                contextCompleteness: context,
                drafterSeverity,
                verifierSeverity,
              }),
            );
            maxLikely = Math.max(maxLikely, score);
          }
        }
      }
    }
    expect(maxLikely).toBe(75);
    expect(maxLikely).toBeLessThan(STRONG_THRESHOLD);
  });

  it('no LIKELY combination lands in the strong band', () => {
    for (const evidence of EVIDENCE) {
      for (const context of CONTEXT) {
        const r = scoreFinding(
          makeFinding({
            verdict: 'LIKELY',
            evidenceStrength: evidence,
            contextCompleteness: context,
            drafterSeverity: 'high',
            verifierSeverity: 'high',
          }),
        );
        expect(r.band).not.toBe('strong');
      }
    }
  });

  it('CONFIRMED/direct/full reaches the strong band', () => {
    const r = scoreFinding(makeFinding({ drafterSeverity: 'high', verifierSeverity: 'high' }));
    expect(r.band).toBe('strong');
  });
});

// ── Band boundaries ──────────────────────────────────────────────────────────

describe('bandFor — boundaries are contiguous with no gaps', () => {
  it.each([
    [100, 'strong'],
    [80, 'strong'],
    [79, 'moderate'],
    [55, 'moderate'],
    [54, 'weak'],
    [30, 'weak'],
    [29, 'negligible'],
    [0, 'negligible'],
  ] as const)('score %i → %s', (score, band) => {
    expect(bandFor(score)).toBe(band);
  });

  it('threshold constants line up with the band edges', () => {
    expect(STRONG_THRESHOLD).toBe(80);
    expect(MODERATE_THRESHOLD).toBe(55);
    expect(WEAK_THRESHOLD).toBe(30);
  });
});

// ── Hard gate: scope ─────────────────────────────────────────────────────────

describe('scope hard gate', () => {
  it('in_diff false → score 0, negligible, dropped', () => {
    const r = scoreFinding(makeFinding({ inDiff: false }));
    expect(r.score).toBe(0);
    expect(r.band).toBe('negligible');
    expect(r.disposition).toBe('drop');
    expect(r.breakdown.gate).toBe('scope');
  });

  it('in_changed_code false → score 0, dropped (even for a would-be perfect score)', () => {
    const r = scoreFinding(
      makeFinding({ drafterSeverity: 'high', verifierSeverity: 'high', inChangedCode: false }),
    );
    expect(r.score).toBe(0);
    expect(r.disposition).toBe('drop');
    expect(r.breakdown.gate).toBe('scope');
  });

  it('scope gate fires before the security floor (out-of-scope security is dropped)', () => {
    const r = scoreFinding(makeFinding({ category: 'security', inChangedCode: false }));
    expect(r.disposition).toBe('drop');
    expect(r.forced).toBe(false);
  });
});

// ── Hard gate: dismissed ─────────────────────────────────────────────────────

describe('dismissed hard gate', () => {
  it('DISMISSED non-security → score 0, dropped', () => {
    const r = scoreFinding(makeFinding({ verdict: 'DISMISSED' }));
    expect(r.score).toBe(0);
    expect(r.band).toBe('negligible');
    expect(r.disposition).toBe('drop');
    expect(r.breakdown.gate).toBe('dismissed');
  });

  it('DISMISSED security → score 0 but routed to the audit list', () => {
    const r = scoreFinding(makeFinding({ verdict: 'DISMISSED', category: 'security' }));
    expect(r.score).toBe(0);
    expect(r.disposition).toBe('audit');
    expect(r.forced).toBe(false);
  });
});

// ── Per-finding posting policy ───────────────────────────────────────────────

describe('posting policy (per finding)', () => {
  it('security finding posts inline even in the weak band (security floor)', () => {
    // CONFIRMED/speculative/none, d2 → 56 − 8 = 48 (weak), but security forces inline.
    const r = scoreFinding(
      makeFinding({
        category: 'security',
        evidenceStrength: 'speculative',
        contextCompleteness: 'none',
        drafterSeverity: 'high',
        verifierSeverity: 'low',
      }),
    );
    expect(r.band).toBe('weak');
    expect(r.disposition).toBe('inline');
    expect(r.forced).toBe(true);
    expect(r.reason).toContain('security');
  });

  it('security finding posts inline even at a negligible score', () => {
    const r = scoreFinding(
      makeFinding({
        category: 'security',
        verdict: 'LIKELY',
        evidenceStrength: 'speculative',
        contextCompleteness: 'none',
        drafterSeverity: 'low',
        verifierSeverity: 'high',
      }),
    );
    expect(r.score).toBe(18);
    expect(r.band).toBe('negligible');
    expect(r.disposition).toBe('inline');
    expect(r.forced).toBe(true);
  });

  it('high-severity finding posts inline even in the weak band', () => {
    const r = scoreFinding(
      makeFinding({
        verdict: 'LIKELY',
        evidenceStrength: 'speculative',
        contextCompleteness: 'none',
        drafterSeverity: 'high',
        verifierSeverity: 'high',
      }),
    );
    // LIKELY/spec/none subtotal 26, d0 +5 = 31 → weak.
    expect(r.band).toBe('weak');
    expect(r.disposition).toBe('inline');
    expect(r.forced).toBe(true);
    expect(r.reason).toContain('high-severity');
  });

  it('non-forced moderate finding posts inline (not forced)', () => {
    const r = scoreFinding(
      makeFinding({ verdict: 'LIKELY', evidenceStrength: 'direct', contextCompleteness: 'full' }),
    );
    expect(r.score).toBe(75);
    expect(r.disposition).toBe('inline');
    expect(r.forced).toBe(false);
  });

  it('non-forced weak finding → summary (not inline, not dropped)', () => {
    // CONFIRMED/speculative/none, d2 → 48 (weak), medium severity, non-security.
    const r = scoreFinding(
      makeFinding({
        evidenceStrength: 'speculative',
        contextCompleteness: 'none',
        drafterSeverity: 'high',
        verifierSeverity: 'low',
      }),
    );
    expect(r.band).toBe('weak');
    expect(r.disposition).toBe('summary');
    expect(r.forced).toBe(false);
  });

  it('non-forced negligible LOW-severity finding → dropped', () => {
    // Verifier severity is low (no medium floor) and one step from the drafter
    // (d1 → +0), so neither the high-severity nor the security override fires
    // and the medium-severity visibility floor does not apply: a true drop.
    const r = scoreFinding(
      makeFinding({
        verdict: 'LIKELY',
        evidenceStrength: 'speculative',
        contextCompleteness: 'none',
        drafterSeverity: 'medium',
        verifierSeverity: 'low',
      }),
    );
    expect(r.score).toBe(26);
    expect(r.band).toBe('negligible');
    expect(r.disposition).toBe('drop');
  });

  it('negligible MEDIUM-severity finding → summary (medium-severity visibility floor)', () => {
    // Same negligible score, but verifier severity medium keeps it visible: a
    // medium finding the verifier still believes in is never silently dropped.
    const r = scoreFinding(
      makeFinding({
        verdict: 'LIKELY',
        evidenceStrength: 'speculative',
        contextCompleteness: 'none',
        drafterSeverity: 'low',
        verifierSeverity: 'medium',
      }),
    );
    expect(r.score).toBe(26);
    expect(r.band).toBe('negligible');
    expect(r.disposition).toBe('summary');
    expect(r.forced).toBe(false);
  });

  it('visibility never inverts when the verifier raises severity (low → medium)', () => {
    // Regression guard for the concordance non-monotonicity: at fixed
    // verdict/evidence/context, escalating verifier severity must not move a
    // finding to a less-visible tier. low → summary (weak 31); medium → summary
    // (negligible 26, floored). Neither is 'drop'.
    const base = {
      verdict: 'LIKELY',
      evidenceStrength: 'speculative',
      contextCompleteness: 'none',
      drafterSeverity: 'low',
    } as const;
    const low = scoreFinding(makeFinding({ ...base, verifierSeverity: 'low' }));
    const medium = scoreFinding(makeFinding({ ...base, verifierSeverity: 'medium' }));
    expect(low.disposition).toBe('summary');
    expect(medium.disposition).toBe('summary');
    // Raising severity dropped the score (lost the +5 agreement bonus) but did
    // NOT push the finding off the visible channels.
    expect(medium.score).toBeLessThan(low.score);
    expect(medium.disposition).not.toBe('drop');
  });
});

// ── Cross-finding comment cap ────────────────────────────────────────────────

describe('scoreFindings — comment cap and grouping', () => {
  // Seven distinct-score non-forced CONFIRMED findings (medium severity, logic_error):
  // direct/full=100, direct/partial=97, circ/full=95, circ/partial=87,
  // spec/full=83, spec/partial=75, circ/none=73 (all + d0 concordance). The
  // spec/full=83 cell avoids the verifier disjointness rule (direct + none) so
  // this cap fixture exercises only combinations the verifier may legitimately emit.
  const NON_FORCED: Array<[EvidenceStrength, ContextCompleteness, number]> = [
    ['direct', 'full', 100],
    ['direct', 'partial', 97],
    ['circumstantial', 'full', 95],
    ['circumstantial', 'partial', 87],
    ['speculative', 'full', 83],
    ['speculative', 'partial', 75],
    ['circumstantial', 'none', 73],
  ];

  function nonForcedBatch(): FindingInput[] {
    return NON_FORCED.map(([evidence, context], i) =>
      makeFinding({
        file: `pkg/f${i}.go`,
        evidenceStrength: evidence,
        contextCompleteness: context,
      }),
    );
  }

  it('caps non-forced inline comments at COMMENT_CAP, demoting the rest to summary', () => {
    const report = scoreFindings(nonForcedBatch());
    expect(report.inline).toHaveLength(COMMENT_CAP);
    expect(report.summary).toHaveLength(NON_FORCED.length - COMMENT_CAP);
    // The five highest scores survive; the two lowest are demoted.
    expect(report.inline.map((s) => s.result.score)).toEqual([100, 97, 95, 87, 83]);
    expect(report.summary.map((s) => s.result.score)).toEqual([75, 73]);
  });

  it('inline comments are ordered by descending confidence', () => {
    const report = scoreFindings(nonForcedBatch());
    const keys = report.inline.map((s) => s.result.sortKey);
    expect(keys).toEqual([...keys].sort((a, b) => b - a));
  });

  it('forced comments are exempt from the cap and never displaced', () => {
    const forced: FindingInput[] = [
      makeFinding({
        file: 'pkg/sec.go',
        category: 'security',
        evidenceStrength: 'speculative',
        contextCompleteness: 'none',
        drafterSeverity: 'high',
        verifierSeverity: 'low',
      }),
      makeFinding({
        file: 'pkg/high.go',
        verdict: 'LIKELY',
        evidenceStrength: 'speculative',
        contextCompleteness: 'none',
        drafterSeverity: 'high',
        verifierSeverity: 'high',
      }),
    ];
    const report = scoreFindings([...nonForcedBatch(), ...forced]);
    // 5 capped non-forced + 2 forced = 7 inline; the 2 forced are present despite low scores.
    expect(report.inline).toHaveLength(COMMENT_CAP + forced.length);
    const inlineFiles = report.inline.map((s) => s.input.file);
    expect(inlineFiles).toContain('pkg/sec.go');
    expect(inlineFiles).toContain('pkg/high.go');
    // Cap still applied to the non-forced set only.
    expect(report.summary).toHaveLength(NON_FORCED.length - COMMENT_CAP);
  });

  it('lists forced comments first, ahead of higher-scoring non-forced ones', () => {
    const forced: FindingInput[] = [
      makeFinding({
        file: 'pkg/sec.go',
        category: 'security',
        evidenceStrength: 'speculative',
        contextCompleteness: 'none',
        drafterSeverity: 'high',
        verifierSeverity: 'low',
      }),
      makeFinding({
        file: 'pkg/high.go',
        verdict: 'LIKELY',
        evidenceStrength: 'speculative',
        contextCompleteness: 'none',
        drafterSeverity: 'high',
        verifierSeverity: 'high',
      }),
    ];
    const report = scoreFindings([...nonForcedBatch(), ...forced]);
    // The forced findings (security score 48, high-severity score 31) lead the
    // inline list even though every non-forced finding outscores them.
    const leadFiles = report.inline.slice(0, forced.length).map((s) => s.input.file);
    expect(leadFiles).toEqual(['pkg/sec.go', 'pkg/high.go']);
    const forcedFlags = report.inline.map((s) => s.result.forced);
    expect(forcedFlags).toEqual([true, true, false, false, false, false, false]);
  });

  it('respects a custom comment cap', () => {
    const report = scoreFindings(nonForcedBatch(), { commentCap: 2 });
    expect(report.inline).toHaveLength(2);
    expect(report.summary).toHaveLength(NON_FORCED.length - 2);
  });

  it('groups gated findings into audit and dropped', () => {
    const report = scoreFindings([
      makeFinding({ file: 'a.go', verdict: 'DISMISSED', category: 'security' }),
      makeFinding({ file: 'b.go', verdict: 'DISMISSED' }),
      makeFinding({ file: 'c.go', inChangedCode: false }),
    ]);
    expect(report.audit.map((s) => s.input.file)).toEqual(['a.go']);
    expect(report.dropped.map((s) => s.input.file).sort()).toEqual(['b.go', 'c.go']);
    expect(report.inline).toHaveLength(0);
  });
});

// ── sortKey tie-break ────────────────────────────────────────────────────────

describe('sortKey tie-break', () => {
  it('breaks an equal-score tie in favour of CONFIRMED over LIKELY', () => {
    // CONFIRMED/speculative/partial + d0 = 75; LIKELY/direct/full + d0 = 75.
    const confirmed = scoreFinding(
      makeFinding({ evidenceStrength: 'speculative', contextCompleteness: 'partial' }),
    );
    const likely = scoreFinding(
      makeFinding({ verdict: 'LIKELY', evidenceStrength: 'direct', contextCompleteness: 'full' }),
    );
    expect(confirmed.score).toBe(75);
    expect(likely.score).toBe(75);
    expect(confirmed.sortKey).toBeGreaterThan(likely.sortKey);
  });
});

// ── Input validation ─────────────────────────────────────────────────────────

describe('input validation', () => {
  it('throws on an invalid verdict', () => {
    expect(() => scoreFinding(makeFinding({ verdict: 'MAYBE' as never }))).toThrow(
      /invalid verdict/,
    );
  });

  it('throws on an invalid evidence_strength', () => {
    expect(() => scoreFinding(makeFinding({ evidenceStrength: 'weak' as never }))).toThrow(
      /invalid evidenceStrength/,
    );
  });

  it('throws on an invalid context_completeness', () => {
    expect(() => scoreFinding(makeFinding({ contextCompleteness: 'some' as never }))).toThrow(
      /invalid contextCompleteness/,
    );
  });

  it('throws on an invalid category (a misspelled "Security" must not silently disable the floor)', () => {
    expect(() => scoreFinding(makeFinding({ category: 'Security' as never }))).toThrow(
      /invalid category/,
    );
  });
});

// ── Verifier disjointness rule (direct + none) ───────────────────────────────

describe('disjointness rule (direct + none) is scored, not rejected', () => {
  // pr-review.yaml forbids the verifier from pairing `direct` evidence with `none`
  // context, but the scorer is intentionally total over every evidence×context cell:
  // a rule violation must degrade gracefully (lower score via the missing-context
  // penalty), never throw and abort the whole batch. This pins that divergence so
  // the TS model and the YAML rule cannot silently contradict each other.
  it('scores CONFIRMED/direct/none from the table instead of throwing', () => {
    const r = scoreFinding(
      makeFinding({ evidenceStrength: 'direct', contextCompleteness: 'none' }),
    );
    expect(r.breakdown.subtotal).toBe(78); // CONFIRMED 70 + direct 18 + none −10
    expect(r.score).toBe(83); // + d0 concordance (medium↔medium, +5)
    expect(r.band).toBe('strong');
  });

  it('scores it strictly below the same finding with full context', () => {
    const none = scoreFinding(
      makeFinding({ evidenceStrength: 'direct', contextCompleteness: 'none' }),
    );
    const full = scoreFinding(
      makeFinding({ evidenceStrength: 'direct', contextCompleteness: 'full' }),
    );
    expect(none.score).toBeLessThan(full.score);
  });
});

// ── Locked-spec worked examples (data-driven) ────────────────────────────────

describe('locked-spec worked examples', () => {
  // band names here use the confidence vocabulary (strong/moderate/weak/negligible);
  // the spec's worked_examples field encoded them as high/medium/low/negligible.
  const CASES: Array<{
    name: string;
    input: Partial<FindingInput>;
    score: number;
    band: string;
    inline: boolean;
  }> = [
    {
      name: 'CONFIRMED/direct/full, high/high → 100, strong, inline (high-severity)',
      input: { drafterSeverity: 'high', verifierSeverity: 'high' },
      score: 100,
      band: 'strong',
      inline: true,
    },
    {
      name: 'CONFIRMED/circumstantial/none, medium/medium → 73, moderate, inline',
      input: { evidenceStrength: 'circumstantial', contextCompleteness: 'none' },
      score: 73,
      band: 'moderate',
      inline: true,
    },
    {
      name: 'CONFIRMED/speculative/none, high/low → 48, weak, summary',
      input: {
        evidenceStrength: 'speculative',
        contextCompleteness: 'none',
        drafterSeverity: 'high',
        verifierSeverity: 'low',
      },
      score: 48,
      band: 'weak',
      inline: false,
    },
    {
      name: 'LIKELY/direct/full, medium/medium → 75, moderate, inline',
      input: { verdict: 'LIKELY', evidenceStrength: 'direct', contextCompleteness: 'full' },
      score: 75,
      band: 'moderate',
      inline: true,
    },
    {
      name: 'LIKELY/circumstantial/partial, medium/medium → 57, moderate, inline',
      input: {
        verdict: 'LIKELY',
        evidenceStrength: 'circumstantial',
        contextCompleteness: 'partial',
      },
      score: 57,
      band: 'moderate',
      inline: true,
    },
    {
      // Spec worked-example #6 listed verifierSev=high yet "dropped entirely",
      // which contradicts the high-severity always-post rule. The score (26) and
      // band (negligible) are correct; to demonstrate the intended non-forced
      // drop we use a low verifier severity one step from the drafter (d1 → +0)
      // — low severity is below the medium visibility floor, so it truly drops.
      name: 'LIKELY/speculative/none, medium/low → 26, negligible, dropped (non-forced, low severity)',
      input: {
        verdict: 'LIKELY',
        evidenceStrength: 'speculative',
        contextCompleteness: 'none',
        drafterSeverity: 'medium',
        verifierSeverity: 'low',
      },
      score: 26,
      band: 'negligible',
      inline: false,
    },
    {
      name: 'CONFIRMED/circumstantial/none, high/medium, security → 68, moderate, inline',
      input: {
        category: 'security',
        evidenceStrength: 'circumstantial',
        contextCompleteness: 'none',
        drafterSeverity: 'high',
        verifierSeverity: 'medium',
      },
      score: 68,
      band: 'moderate',
      inline: true,
    },
    {
      name: 'LIKELY/speculative/none, low/high, security → 18, negligible, inline (security floor)',
      input: {
        category: 'security',
        verdict: 'LIKELY',
        evidenceStrength: 'speculative',
        contextCompleteness: 'none',
        drafterSeverity: 'low',
        verifierSeverity: 'high',
      },
      score: 18,
      band: 'negligible',
      inline: true,
    },
    {
      name: 'DISMISSED → 0, negligible, not inline',
      input: { verdict: 'DISMISSED', drafterSeverity: 'high', verifierSeverity: 'high' },
      score: 0,
      band: 'negligible',
      inline: false,
    },
    {
      name: 'LIKELY/circumstantial/full, high/high → 65, moderate, inline (high-severity)',
      input: {
        verdict: 'LIKELY',
        evidenceStrength: 'circumstantial',
        contextCompleteness: 'full',
        drafterSeverity: 'high',
        verifierSeverity: 'high',
      },
      score: 65,
      band: 'moderate',
      inline: true,
    },
    {
      name: 'CONFIRMED/direct/full, high/high, OUT OF SCOPE → 0, negligible, not inline',
      input: { drafterSeverity: 'high', verifierSeverity: 'high', inChangedCode: false },
      score: 0,
      band: 'negligible',
      inline: false,
    },
    {
      name: 'CONFIRMED/speculative/full, medium/medium → 83, strong, inline',
      input: { evidenceStrength: 'speculative', contextCompleteness: 'full' },
      score: 83,
      band: 'strong',
      inline: true,
    },
  ];

  for (const c of CASES) {
    it(c.name, () => {
      const r = scoreFinding(makeFinding(c.input));
      expect(r.score).toBe(c.score);
      expect(r.band).toBe(c.band);
      expect(r.disposition === 'inline').toBe(c.inline);
    });
  }
});

// ── resolvePostThreshold ─────────────────────────────────────────────────────

describe('resolvePostThreshold', () => {
  it('maps band names to their score floors', () => {
    expect(resolvePostThreshold('strong')).toBe(STRONG_THRESHOLD);
    expect(resolvePostThreshold('moderate')).toBe(MODERATE_THRESHOLD);
    expect(resolvePostThreshold('weak')).toBe(WEAK_THRESHOLD);
  });

  it('accepts "medium" as an alias for "moderate"', () => {
    expect(resolvePostThreshold('medium')).toBe(MODERATE_THRESHOLD);
  });

  it('is case- and whitespace-insensitive for band names', () => {
    expect(resolvePostThreshold('  STRONG ')).toBe(STRONG_THRESHOLD);
    expect(resolvePostThreshold('Medium')).toBe(MODERATE_THRESHOLD);
  });

  it('accepts numbers and numeric strings as the cutoff', () => {
    expect(resolvePostThreshold(70)).toBe(70);
    expect(resolvePostThreshold('70')).toBe(70);
  });

  it('clamps numbers to [WEAK_THRESHOLD, 100]', () => {
    expect(resolvePostThreshold(5)).toBe(WEAK_THRESHOLD);
    expect(resolvePostThreshold('5')).toBe(WEAK_THRESHOLD);
    expect(resolvePostThreshold(150)).toBe(100);
    expect(resolvePostThreshold('150')).toBe(100);
    expect(resolvePostThreshold(-5)).toBe(WEAK_THRESHOLD);
  });

  it('rounds fractional numbers before clamping', () => {
    expect(resolvePostThreshold(72.4)).toBe(72);
    expect(resolvePostThreshold(3.7)).toBe(WEAK_THRESHOLD); // rounds to 4, clamps to 30
  });

  it('defaults to DEFAULT_POST_THRESHOLD for empty/undefined/null', () => {
    expect(resolvePostThreshold(undefined)).toBe(DEFAULT_POST_THRESHOLD);
    expect(resolvePostThreshold(null)).toBe(DEFAULT_POST_THRESHOLD);
    expect(resolvePostThreshold('')).toBe(DEFAULT_POST_THRESHOLD);
    expect(resolvePostThreshold('   ')).toBe(DEFAULT_POST_THRESHOLD);
  });

  it('falls back to the default for unrecognized or malformed values (never throws)', () => {
    expect(resolvePostThreshold('banana')).toBe(DEFAULT_POST_THRESHOLD);
    expect(resolvePostThreshold('7x')).toBe(DEFAULT_POST_THRESHOLD);
    expect(resolvePostThreshold(Number.NaN)).toBe(DEFAULT_POST_THRESHOLD);
  });
});

// ── Configurable inline threshold (postThreshold) ────────────────────────────

describe('configurable inline threshold', () => {
  it('omitting postThreshold reproduces the default (55) behavior', () => {
    // CONFIRMED/circumstantial/none, medium/medium → 73 (moderate), non-forced.
    const input = makeFinding({ evidenceStrength: 'circumstantial', contextCompleteness: 'none' });
    const dflt = scoreFinding(input);
    const explicit = scoreFinding(input, { postThreshold: DEFAULT_POST_THRESHOLD });
    expect(dflt.disposition).toBe('inline');
    expect(explicit.disposition).toBe(dflt.disposition);
  });

  it('raising the threshold demotes a previously-inline moderate finding to summary', () => {
    // Score 73 (moderate), verifier medium → inline at 55, summary at 80.
    const input = makeFinding({ evidenceStrength: 'circumstantial', contextCompleteness: 'none' });
    expect(scoreFinding(input).score).toBe(73);
    expect(scoreFinding(input, { postThreshold: STRONG_THRESHOLD }).disposition).toBe('summary');
  });

  it('lowering the threshold promotes a previously-summary weak finding to inline', () => {
    // LIKELY/circumstantial/none, medium/medium → 43 (weak), non-forced.
    const input = makeFinding({
      verdict: 'LIKELY',
      evidenceStrength: 'circumstantial',
      contextCompleteness: 'none',
    });
    expect(scoreFinding(input).score).toBe(43);
    expect(scoreFinding(input).disposition).toBe('summary'); // default 55
    expect(scoreFinding(input, { postThreshold: WEAK_THRESHOLD }).disposition).toBe('inline');
  });

  it('keeps the band label anchored to the score regardless of the threshold', () => {
    // The band describes confidence on fixed boundaries; the threshold only moves the
    // inline cutoff. A score-73 finding is 'moderate' whether it posts inline (T=55) or
    // is demoted to the summary (T=80). Guards the documented "band labels never drift" claim.
    const input = makeFinding({ evidenceStrength: 'circumstantial', contextCompleteness: 'none' });
    expect(scoreFinding(input).score).toBe(73);
    expect(scoreFinding(input, { postThreshold: WEAK_THRESHOLD }).band).toBe('moderate');
    expect(scoreFinding(input, { postThreshold: MODERATE_THRESHOLD }).band).toBe('moderate');
    expect(scoreFinding(input, { postThreshold: STRONG_THRESHOLD }).band).toBe('moderate');
    // disposition flips, band does not.
    expect(scoreFinding(input, { postThreshold: WEAK_THRESHOLD }).disposition).toBe('inline');
    expect(scoreFinding(input, { postThreshold: STRONG_THRESHOLD }).disposition).toBe('summary');
  });

  it('a high threshold still posts security findings inline (forced; ignores the threshold)', () => {
    // Security finding scoring 48 (weak) — forced inline even at threshold 80.
    const input = makeFinding({
      category: 'security',
      evidenceStrength: 'speculative',
      contextCompleteness: 'none',
      drafterSeverity: 'high',
      verifierSeverity: 'low',
    });
    const r = scoreFinding(input, { postThreshold: STRONG_THRESHOLD });
    expect(r.score).toBe(48);
    expect(r.disposition).toBe('inline');
    expect(r.forced).toBe(true);
  });

  it('a high threshold still posts high-severity findings inline (forced)', () => {
    // LIKELY/speculative/none, high/high → 31 (weak), high-severity → forced inline.
    const input = makeFinding({
      verdict: 'LIKELY',
      evidenceStrength: 'speculative',
      contextCompleteness: 'none',
      drafterSeverity: 'high',
      verifierSeverity: 'high',
    });
    const r = scoreFinding(input, { postThreshold: 100 });
    expect(r.score).toBe(31);
    expect(r.disposition).toBe('inline');
    expect(r.forced).toBe(true);
  });

  it('clamps postThreshold to [WEAK_THRESHOLD, 100] so negligible findings never post inline', () => {
    // Negligible LOW-severity finding (score 26): even with an absurdly low threshold it
    // is clamped to 30, so 26 < 30 keeps it out of inline (drops as low-severity noise).
    const negligible = makeFinding({
      verdict: 'LIKELY',
      evidenceStrength: 'speculative',
      contextCompleteness: 'none',
      drafterSeverity: 'medium',
      verifierSeverity: 'low',
    });
    expect(scoreFinding(negligible, { postThreshold: 0 }).disposition).toBe('drop');
    expect(scoreFinding(negligible, { postThreshold: 10 }).disposition).toBe('drop');

    // Upper clamp: a threshold above 100 collapses to 100, so only a perfect score posts inline.
    const perfect = makeFinding({ drafterSeverity: 'high', verifierSeverity: 'high' }); // score 100
    const moderate = makeFinding({
      evidenceStrength: 'circumstantial',
      contextCompleteness: 'none',
    }); // score 73
    expect(scoreFinding(perfect, { postThreshold: 200 }).disposition).toBe('inline');
    expect(scoreFinding(moderate, { postThreshold: 200 }).disposition).toBe('summary');
  });

  it('scoreFindings forwards postThreshold to every finding', () => {
    const batch: FindingInput[] = [
      // strong (95), non-forced
      makeFinding({
        file: 'a.go',
        evidenceStrength: 'circumstantial',
        contextCompleteness: 'full',
      }),
      // moderate (73), non-forced
      makeFinding({
        file: 'b.go',
        evidenceStrength: 'circumstantial',
        contextCompleteness: 'none',
      }),
    ];
    const report = scoreFindings(batch, { postThreshold: STRONG_THRESHOLD });
    expect(report.inline.map((s) => s.input.file)).toEqual(['a.go']);
    expect(report.summary.map((s) => s.input.file)).toEqual(['b.go']);
  });
});
