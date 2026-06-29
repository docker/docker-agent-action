// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * score-confidence — per-finding confidence scoring for the PR review pipeline.
 *
 * The reviewer pipeline is drafter → verifier → orchestrator. The drafter
 * proposes bug findings; the verifier returns a verdict plus two evidence
 * signals per finding; this module converts those signals into a precise,
 * reproducible 0–100 confidence score, a band, and a posting disposition.
 *
 * This module is the **single source of truth** for the confidence model. The
 * orchestrator agent (review-pr/agents/pr-review.yaml) mirrors the exact same
 * rules as a strict lookup-table procedure so it can score findings inline
 * without depending on the (gitignored) dist bundle at agent runtime. Any change
 * to the weights, bands, threshold, or posting policy here MUST be reflected in
 * the "Confidence Scoring" section of that agent prompt, and vice-versa. The
 * unit tests pin every value so drift is caught.
 *
 * ## Criteria (multi-factor — no single signal decides a score)
 *
 *   1. verdict             — verifier agreement: CONFIRMED | LIKELY | DISMISSED
 *   2. evidence_strength   — pattern/snippet match strength: direct | circumstantial | speculative
 *   3. context_completeness— did the verifier see the code it needed: full | partial | none
 *   4. severity concordance— agreement between drafter and verifier severity (rank distance)
 *   5. scope               — in_diff (drafter) AND in_changed_code (verifier)
 *   6. category / severity — security and high-severity drive POSTING policy, never the raw score
 *
 * ## Deterministic pipeline (exact order — implement verbatim, no conditional caps)
 *
 *   STEP 0 (scope gate):     NOT(in_diff && in_changed_code) → score 0, negligible, never post.
 *   STEP 1 (dismissed gate): verdict === DISMISSED            → score 0, negligible, never post inline.
 *   STEP 2 (core subtotal):  subtotal = CORE_SUBTOTAL[verdict][evidence][context]
 *                            (a precomputed 3×3 table per scorable verdict; see below).
 *   STEP 3 (concordance):    score_raw = subtotal + concordance(drafterSeverity, verifierSeverity)
 *   STEP 4 (clamp):          score = clamp(score_raw, 0, 100)   ← the only clamp; there is no cap step.
 *   STEP 5 (band):           bandFor(score)
 *
 * The core subtotal is authored additively as `verdict base + evidence + context`:
 *
 *                    verdict base:  CONFIRMED 70   LIKELY 40
 *   evidence:  direct +18   circumstantial +8   speculative −4
 *   context:   full   +12   partial        +4   none        −10
 *
 * yielding (rows = verdict/evidence, columns = full | partial | none):
 *
 *   CONFIRMED / direct         = [100, 92, 78]
 *   CONFIRMED / circumstantial = [ 90, 82, 68]
 *   CONFIRMED / speculative    = [ 78, 70, 56]
 *   LIKELY    / direct         = [ 70, 62, 48]
 *   LIKELY    / circumstantial = [ 60, 52, 38]
 *   LIKELY    / speculative    = [ 48, 40, 26]
 *
 * Provable invariants (all unit-tested):
 *   - Strictly monotone in evidence (direct > circumstantial > speculative) at fixed verdict/context.
 *   - Monotone in context (full ≥ partial ≥ none) at fixed verdict/evidence.
 *   - Only CONFIRMED can reach the strong band (≥80): LIKELY tops out at 75 (LIKELY/direct/full + d0),
 *     a robust 5-point margin below the strong floor.
 *   - DISMISSED and out-of-scope findings always score 0.
 *   - Concordance (−8 worst case) never drives an in-scope score below 0 (min cell 26 − 8 = 18).
 *
 * Note on severity: the score deliberately incorporates drafter↔verifier severity *agreement*
 * (concordance), which peaks when they match. It is therefore intentionally NOT monotone in
 * verifier severity — a one-notch disagreement can nudge a borderline finding down a band. That
 * is a legitimate confidence signal (confidence = "is it real", a different axis from severity),
 * but it must never silently suppress a real bug, so the posting policy adds a medium-severity
 * visibility floor (rule 6). Net guarantee: increasing verifier severity never *lowers* a
 * finding's visibility tier (low → drop/summary, medium → at least summary, high → inline).
 *
 * ## Note on the verifier disjointness rule (direct + none)
 *
 * The verifier prompt (pr-review.yaml) forbids pairing `evidence_strength: direct` with
 * `context_completeness: none` — without the defining context you cannot claim direct evidence.
 * That is an honesty constraint on the verifier's *output*, NOT an invariant this scorer
 * enforces: the core table deliberately defines a value for every evidence×context cell
 * (CONFIRMED/direct/none = 78), so a verifier that violates the rule has its finding scored —
 * and scored lower for the missing context — rather than rejected. Throwing here would abort
 * the entire batch over one off-nominal finding, which is strictly worse for a review run. The
 * divergence is intentional and is pinned by a dedicated unit test.
 *
 * ## Posting policy (decided after scoring; first match wins; the cap is applied last)
 *
 *   1. Out-of-scope / DISMISSED non-security → drop (never posted inline).
 *   2. Security floor:  category === security AND verdict ∈ {CONFIRMED, LIKELY}
 *      → always inline, regardless of score/band, exempt from the cap.
 *   3. High-severity:   verifierSeverity === high AND verdict ∈ {CONFIRMED, LIKELY}
 *      → always inline, regardless of band, exempt from the cap.
 *   4. Default:         score ≥ postThreshold → inline (subject to the cap).
 *   5. Below threshold: WEAK_THRESHOLD ≤ score < postThreshold → summary list, not inline (no silent drop).
 *   6. Medium floor:    negligible band (< WEAK_THRESHOLD) but verifierSeverity === medium → summary.
 *   7. Dismissed-security audit: DISMISSED security → audit list, not inline (human-reviewable).
 *   8. Cap:             non-forced inline comments capped at COMMENT_CAP (5); overflow → summary.
 *      Ranking keeps the highest sortKey first (score, then CONFIRMED>LIKELY, then subtotal,
 *      then evidence, then context). Forced comments (rules 2,3) are never displaced.
 *
 * ## Configurable inline threshold (rule 4)
 *
 * The inline cutoff in rule 4 is `postThreshold` — the minimum confidence a non-forced
 * finding needs to be posted inline. It defaults to {@link DEFAULT_POST_THRESHOLD} (55, the
 * moderate band floor), which reproduces the original "post strong/moderate, summarize weak"
 * behavior exactly. A caller may raise it (post only higher-confidence findings) or lower it
 * toward {@link WEAK_THRESHOLD} (also post weak findings) via {@link resolvePostThreshold} and
 * the `postThreshold` option. It is clamped to [{@link WEAK_THRESHOLD}, 100] so the negligible
 * band (< 30) is never posted inline by this rule — only the security/high-severity overrides
 * (rules 2,3) can surface a negligible finding, and they ignore the threshold entirely. Band
 * labels stay anchored to the constants regardless of the cutoff (they describe confidence; the
 * threshold only decides posting). The GitHub Action (review-pr/action.yml) mirrors
 * resolvePostThreshold in bash and injects the resolved number into the agent prompt.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Verifier verdict on a finding. */
export type Verdict = 'CONFIRMED' | 'LIKELY' | 'DISMISSED';

/** Verdicts that enter the additive scoring path (DISMISSED is gated out first). */
export type ScorableVerdict = Exclude<Verdict, 'DISMISSED'>;

/** Verifier signal: how strongly the cited snippet shows the bug. */
export type EvidenceStrength = 'direct' | 'circumstantial' | 'speculative';

/** Verifier signal: how complete the code context was when judging. */
export type ContextCompleteness = 'full' | 'partial' | 'none';

/** Finding severity (shared by drafter and verifier). */
export type Severity = 'high' | 'medium' | 'low';

/** Drafter/verifier finding category. */
export type Category =
  | 'security'
  | 'logic_error'
  | 'resource_leak'
  | 'concurrency'
  | 'error_handling'
  | 'data_integrity'
  | 'other';

/** Confidence band — deliberately distinct from the severity enum (independent axes). */
export type ConfidenceBand = 'strong' | 'moderate' | 'weak' | 'negligible';

/**
 * Where a finding ends up:
 *   - inline:  posted as an inline review comment
 *   - summary: listed in the review summary as a lower-confidence finding (not inline)
 *   - audit:   a DISMISSED security finding surfaced for human review (not inline)
 *   - drop:    not surfaced at all (negligible / dismissed non-security / out-of-scope)
 */
export type Disposition = 'inline' | 'summary' | 'audit' | 'drop';

/** A finding merged from the drafter hypothesis and the verifier verdict. */
export interface FindingInput {
  /** Repo-relative file path (passed through to output). */
  file: string;
  /** 1-indexed line number (passed through to output). */
  line: number;
  /** Finding category; `security` triggers the posting floor. */
  category: Category;
  /** Verifier verdict — the primary agreement signal. */
  verdict: Verdict;
  /** Verifier signal: snippet/pattern match strength. */
  evidenceStrength: EvidenceStrength;
  /** Verifier signal: code-context completeness. */
  contextCompleteness: ContextCompleteness;
  /** Severity the drafter originally assigned (for concordance). */
  drafterSeverity: Severity;
  /** Severity the verifier settled on (drives concordance + high-severity posting). */
  verifierSeverity: Severity;
  /** Drafter scope flag: finding lands on a `+` line. */
  inDiff: boolean;
  /** Verifier scope flag: this PR's changes introduce the problem. */
  inChangedCode: boolean;
}

/** Transparent breakdown of how a score was reached (for logging / debugging). */
export interface ConfidenceBreakdown {
  /** Core table value (verdict × evidence × context); 0 when gated. */
  subtotal: number;
  /** Concordance term applied after the table: +5 | 0 | −8; 0 when gated. */
  concordance: number;
  /** Severity rank distance d = |rank(drafter) − rank(verifier)|; 0 when gated. */
  severityDistance: number;
  /** Which hard gate fired, if any. */
  gate: 'scope' | 'dismissed' | null;
}

/** The confidence verdict for a single finding (pre-cap; see {@link scoreFindings}). */
export interface ConfidenceResult {
  /** 0–100 confidence score. */
  score: number;
  /** Band derived from {@link score}. */
  band: ConfidenceBand;
  /** Provisional posting disposition (the cross-finding cap may demote inline → summary). */
  disposition: Disposition;
  /** True when posted via the security or high-severity override (exempt from the cap). */
  forced: boolean;
  /** Human-readable reason for the disposition (which policy rule decided it). */
  reason: string;
  /**
   * Descending sort key for the comment cap tie-break. Encodes, in priority order:
   * score, then verdict (CONFIRMED>LIKELY), then subtotal, then evidence, then context.
   * Higher = kept first when the cap trims non-forced inline comments.
   */
  sortKey: number;
  /** How the score was computed. */
  breakdown: ConfidenceBreakdown;
}

/** A scored finding: the original input paired with its confidence result. */
export interface ScoredFinding {
  input: FindingInput;
  result: ConfidenceResult;
}

/** Grouped output of {@link scoreFindings}, after the cross-finding cap is applied. */
export interface ConfidenceReport {
  /** Every finding, in input order, with its final (post-cap) result. */
  findings: ScoredFinding[];
  /** Findings posted as inline comments (forced first, then capped default-band), sorted by confidence. */
  inline: ScoredFinding[];
  /** Lower-confidence findings surfaced in the summary instead of inline (weak band + cap overflow). */
  summary: ScoredFinding[];
  /** DISMISSED security findings surfaced for human review. */
  audit: ScoredFinding[];
  /** Findings not surfaced at all (negligible / dismissed non-security / out-of-scope). */
  dropped: ScoredFinding[];
}

/** Options for {@link scoreFinding}. */
export interface ScoreFindingOptions {
  /**
   * Minimum confidence score for a non-forced finding to post inline (rule 4).
   * Clamped to [{@link WEAK_THRESHOLD}, 100]. Default {@link DEFAULT_POST_THRESHOLD}.
   */
  postThreshold?: number;
}

/** Options for {@link scoreFindings}. */
export interface ScoreFindingsOptions extends ScoreFindingOptions {
  /** Max non-forced inline comments to keep (default {@link COMMENT_CAP}). */
  commentCap?: number;
}

// ---------------------------------------------------------------------------
// Model constants (the single source of truth — mirror in pr-review.yaml)
// ---------------------------------------------------------------------------

/** Verdict base points (DISMISSED is gated out before the table). */
const VERDICT_BASE: Record<ScorableVerdict, number> = {
  CONFIRMED: 70,
  LIKELY: 40,
};

/** Evidence-strength delta added to the verdict base. */
const EVIDENCE_DELTA: Record<EvidenceStrength, number> = {
  direct: 18,
  circumstantial: 8,
  speculative: -4,
};

/** Context-completeness delta added to the verdict base. */
const CONTEXT_DELTA: Record<ContextCompleteness, number> = {
  full: 12,
  partial: 4,
  none: -10,
};

/** Severity rank used for the concordance distance. */
const SEVERITY_RANK: Record<Severity, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

/** Verdict rank used only for the cap tie-break sort key. */
const VERDICT_RANK: Record<Verdict, number> = {
  CONFIRMED: 2,
  LIKELY: 1,
  DISMISSED: 0,
};

/** Evidence rank used only for the cap tie-break sort key. */
const EVIDENCE_RANK: Record<EvidenceStrength, number> = {
  direct: 2,
  circumstantial: 1,
  speculative: 0,
};

/** Context rank used only for the cap tie-break sort key. */
const CONTEXT_RANK: Record<ContextCompleteness, number> = {
  full: 2,
  partial: 1,
  none: 0,
};

/** Score at or above which a finding is `strong`. Only CONFIRMED can reach it. */
export const STRONG_THRESHOLD = 80;

/**
 * Score at or above which a finding is at least `moderate`. This is also the
 * *default* inline-posting cutoff (see {@link DEFAULT_POST_THRESHOLD}); callers may
 * override the cutoff per run, but the band label always uses this fixed boundary,
 * so band names never drift even when the posting threshold is tuned.
 */
export const MODERATE_THRESHOLD = 55;

/**
 * Score at or above which a finding is at least `weak` (surfaced in the summary).
 * Also the lower bound the configurable posting threshold is clamped to, so the
 * negligible band stays below every possible inline cutoff.
 */
export const WEAK_THRESHOLD = 30;

/**
 * Default inline-posting threshold when a caller does not override it (alias of
 * {@link MODERATE_THRESHOLD}). Using the moderate band floor as the default keeps
 * the out-of-the-box behavior identical to the original "post strong/moderate,
 * summarize weak" policy.
 */
export const DEFAULT_POST_THRESHOLD = MODERATE_THRESHOLD;

/** Maximum non-forced inline comments kept; overflow is routed to the summary list. */
export const COMMENT_CAP = 5;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function assertEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(
      `invalid ${field}: ${JSON.stringify(value)} (expected one of ${allowed.join(', ')})`,
    );
  }
  return value as T;
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/** Core subtotal for a scorable verdict — the precomputed 3×3 table value. */
function coreSubtotal(
  verdict: ScorableVerdict,
  evidence: EvidenceStrength,
  context: ContextCompleteness,
): number {
  return VERDICT_BASE[verdict] + EVIDENCE_DELTA[evidence] + CONTEXT_DELTA[context];
}

/**
 * Concordance term: agreement between the drafter's and verifier's severity.
 * d = |rank(drafter) − rank(verifier)|; same → +5, one step → 0, opposite → −8.
 */
function concordance(drafter: Severity, verifier: Severity): { distance: number; points: number } {
  const distance = Math.abs(SEVERITY_RANK[drafter] - SEVERITY_RANK[verifier]);
  const points = distance === 0 ? 5 : distance === 1 ? 0 : -8;
  return { distance, points };
}

/** Map a 0–100 score to its band. Boundaries: 80 / 55 / 30 (contiguous, no gaps). */
export function bandFor(score: number): ConfidenceBand {
  if (score >= STRONG_THRESHOLD) return 'strong';
  if (score >= MODERATE_THRESHOLD) return 'moderate';
  if (score >= WEAK_THRESHOLD) return 'weak';
  return 'negligible';
}

/**
 * Build the descending cap tie-break sort key. The decimal slots never overlap
 * given the value ranges (score 0–100, ranks 0–2, subtotal 0–100), so a plain
 * numeric sort reproduces the spec's tie-break chain exactly.
 */
function buildSortKey(
  score: number,
  verdict: Verdict,
  subtotal: number,
  evidence: EvidenceStrength,
  context: ContextCompleteness,
): number {
  return (
    score * 10 ** 7 +
    VERDICT_RANK[verdict] * 10 ** 6 +
    subtotal * 10 ** 3 +
    EVIDENCE_RANK[evidence] * 10 ** 2 +
    CONTEXT_RANK[context] * 10
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a user-supplied confidence-threshold setting to a numeric inline-posting
 * cutoff in [{@link WEAK_THRESHOLD}, 100].
 *
 * Accepts either a band name or a number:
 *   - `strong` → 80, `moderate`/`medium` → 55, `weak` → 30 (case- and whitespace-
 *     insensitive; `medium` is an alias for `moderate`).
 *   - a number / numeric string → used as-is, clamped to [{@link WEAK_THRESHOLD}, 100].
 *
 * An empty/undefined/null value yields {@link DEFAULT_POST_THRESHOLD}. An unrecognized
 * value (typo, garbage) also falls back to the default rather than throwing, so a
 * misconfigured input never aborts a review run — the GitHub Action additionally logs a
 * warning when it falls back. This is mirrored by the bash resolver in review-pr/action.yml;
 * keep the two in sync.
 */
export function resolvePostThreshold(value?: string | number | null): number {
  if (value === undefined || value === null) return DEFAULT_POST_THRESHOLD;
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? clamp(Math.round(value), WEAK_THRESHOLD, 100)
      : DEFAULT_POST_THRESHOLD;
  }
  const norm = value.trim().toLowerCase();
  if (norm === '') return DEFAULT_POST_THRESHOLD;
  if (norm === 'strong') return STRONG_THRESHOLD;
  if (norm === 'moderate' || norm === 'medium') return MODERATE_THRESHOLD;
  if (norm === 'weak') return WEAK_THRESHOLD;
  if (/^\d+$/.test(norm)) return clamp(Number.parseInt(norm, 10), WEAK_THRESHOLD, 100);
  return DEFAULT_POST_THRESHOLD;
}

/**
 * Score a single finding and decide its provisional posting disposition.
 *
 * The disposition is provisional because the comment cap is a cross-finding
 * decision: a non-forced `inline` finding may be demoted to `summary` by
 * {@link scoreFindings}. Use {@link scoreFindings} for the final disposition.
 *
 * @throws if any enum field is missing or invalid.
 */
export function scoreFinding(
  raw: FindingInput,
  options: ScoreFindingOptions = {},
): ConfidenceResult {
  const verdict = assertEnum(raw.verdict, ['CONFIRMED', 'LIKELY', 'DISMISSED'] as const, 'verdict');
  const evidence = assertEnum(
    raw.evidenceStrength,
    ['direct', 'circumstantial', 'speculative'] as const,
    'evidenceStrength',
  );
  const context = assertEnum(
    raw.contextCompleteness,
    ['full', 'partial', 'none'] as const,
    'contextCompleteness',
  );
  const drafterSeverity = assertEnum(
    raw.drafterSeverity,
    ['high', 'medium', 'low'] as const,
    'drafterSeverity',
  );
  const verifierSeverity = assertEnum(
    raw.verifierSeverity,
    ['high', 'medium', 'low'] as const,
    'verifierSeverity',
  );
  // Validate category too: it gates the security floor and the dismissed-security
  // audit, so a misspelled value must throw like every other enum rather than
  // silently downgrade `isSecurity` to false.
  const category = assertEnum(
    raw.category,
    [
      'security',
      'logic_error',
      'resource_leak',
      'concurrency',
      'error_handling',
      'data_integrity',
      'other',
    ] as const,
    'category',
  );
  const isSecurity = category === 'security';
  const inScope = raw.inDiff === true && raw.inChangedCode === true;
  const sortKeyFor = (score: number, subtotal: number): number =>
    buildSortKey(score, verdict, subtotal, evidence, context);

  // STEP 0 — scope hard gate. Out-of-scope findings never post inline.
  if (!inScope) {
    return {
      score: 0,
      band: 'negligible',
      disposition: 'drop',
      forced: false,
      reason: 'out-of-scope: requires both in_diff and in_changed_code',
      sortKey: sortKeyFor(0, 0),
      breakdown: { subtotal: 0, concordance: 0, severityDistance: 0, gate: 'scope' },
    };
  }

  // STEP 1 — dismissed hard gate. Score is 0, but a dismissed SECURITY finding is
  // routed to the audit list (human-reviewable) rather than silently dropped.
  if (verdict === 'DISMISSED') {
    return {
      score: 0,
      band: 'negligible',
      disposition: isSecurity ? 'audit' : 'drop',
      forced: false,
      reason: isSecurity ? 'dismissed security finding (audit)' : 'dismissed',
      sortKey: sortKeyFor(0, 0),
      breakdown: { subtotal: 0, concordance: 0, severityDistance: 0, gate: 'dismissed' },
    };
  }

  // STEP 2–4 — core subtotal + concordance, then clamp.
  const subtotal = coreSubtotal(verdict, evidence, context);
  const { distance, points } = concordance(drafterSeverity, verifierSeverity);
  const score = clamp(subtotal + points, 0, 100);
  const band = bandFor(score);
  const sortKey = sortKeyFor(score, subtotal);
  const breakdown: ConfidenceBreakdown = {
    subtotal,
    concordance: points,
    severityDistance: distance,
    gate: null,
  };

  // Posting policy (per-finding part; the cap is applied in scoreFindings).
  if (isSecurity) {
    return {
      score,
      band,
      disposition: 'inline',
      forced: true,
      reason: 'security floor (never auto-suppressed)',
      sortKey,
      breakdown,
    };
  }
  if (verifierSeverity === 'high') {
    return {
      score,
      band,
      disposition: 'inline',
      forced: true,
      reason: 'high-severity always-post',
      sortKey,
      breakdown,
    };
  }
  // Non-forced findings: the configurable inline threshold (rule 4) decides inline vs
  // summary. It is clamped to [WEAK_THRESHOLD, 100] so the negligible band can never be
  // posted inline by this default rule — only the security/high-severity overrides above
  // (which ignore the threshold) can surface a negligible finding.
  const postThreshold = clamp(options.postThreshold ?? DEFAULT_POST_THRESHOLD, WEAK_THRESHOLD, 100);
  if (score >= postThreshold) {
    return {
      score,
      band,
      disposition: 'inline',
      forced: false,
      reason: `at or above the inline confidence threshold (score ${score} >= ${postThreshold})`,
      sortKey,
      breakdown,
    };
  }
  if (score >= WEAK_THRESHOLD) {
    return {
      score,
      band,
      disposition: 'summary',
      forced: false,
      reason: `below the inline confidence threshold (score ${score} < ${postThreshold}); lower-confidence summary, not inline`,
      sortKey,
      breakdown,
    };
  }
  // Negligible band (< WEAK_THRESHOLD). Confidence incorporates drafter↔verifier severity agreement, so
  // it is intentionally NOT monotone in verifier severity — a one-notch disagreement can
  // nudge a borderline finding down a band. To prevent that from ever *silently dropping*
  // a finding the verifier still rates medium-or-worse, a medium-severity negligible
  // finding is kept visible in the lower-confidence summary. (High is already force-posted
  // above; only low-severity negligible findings are dropped as noise.)
  if (verifierSeverity === 'medium') {
    return {
      score,
      band,
      disposition: 'summary',
      forced: false,
      reason: 'medium-severity visibility floor (kept in summary despite negligible confidence)',
      sortKey,
      breakdown,
    };
  }
  return {
    score,
    band,
    disposition: 'drop',
    forced: false,
    reason: 'negligible band (low severity)',
    sortKey,
    breakdown,
  };
}

/**
 * Score a batch of findings and produce the final grouped report, applying the
 * cross-finding comment cap: non-forced inline comments are limited to
 * `commentCap`, keeping the highest-confidence ones; the overflow is demoted to
 * the summary list. Forced comments (security / high-severity) are exempt and
 * never displaced.
 *
 * `options.postThreshold` sets the per-finding inline cutoff (rule 4); it is
 * forwarded to {@link scoreFinding} unchanged (which clamps it) and defaults to
 * {@link DEFAULT_POST_THRESHOLD} there.
 */
export function scoreFindings(
  findings: FindingInput[],
  options: ScoreFindingsOptions = {},
): ConfidenceReport {
  const commentCap = options.commentCap ?? COMMENT_CAP;
  const postThreshold = options.postThreshold;
  const scored: ScoredFinding[] = findings.map((input) => ({
    input,
    result: scoreFinding(input, { postThreshold }),
  }));

  // Identify non-forced inline candidates and demote everything past the cap.
  const nonForcedInline = scored
    .filter((s) => s.result.disposition === 'inline' && !s.result.forced)
    .sort((a, b) => b.result.sortKey - a.result.sortKey);

  const demoted = new Set(nonForcedInline.slice(commentCap));
  for (const s of demoted) {
    s.result = {
      ...s.result,
      disposition: 'summary',
      reason: `over comment cap (${commentCap}); moved to lower-confidence summary`,
    };
  }

  const bySortKeyDesc = (a: ScoredFinding, b: ScoredFinding): number =>
    b.result.sortKey - a.result.sortKey;
  // Within the inline bucket, list forced findings (security / high-severity) first
  // so they can never be visually buried beneath higher-scoring non-forced findings;
  // each partition is then ranked by descending sortKey. This matches the documented
  // ordering of ConfidenceReport.inline ("forced first, then capped default-band").
  const byDisposition = (d: Disposition): ScoredFinding[] => {
    const matches = scored.filter((s) => s.result.disposition === d);
    if (d !== 'inline') return matches.sort(bySortKeyDesc);
    const forced = matches.filter((s) => s.result.forced).sort(bySortKeyDesc);
    const nonForced = matches.filter((s) => !s.result.forced).sort(bySortKeyDesc);
    return [...forced, ...nonForced];
  };

  return {
    findings: scored,
    inline: byDisposition('inline'),
    summary: byDisposition('summary'),
    audit: byDisposition('audit'),
    dropped: byDisposition('drop'),
  };
}
