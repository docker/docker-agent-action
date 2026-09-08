// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * review-assessment — Decision Rules policy plus the trusted runtime helpers
 * behind the PR review posting path. The assessReview() half MIRRORS the
 * rules prose in `review-pr/agents/pr-review.yaml` (same contract as
 * src/score-confidence for the Confidence Scoring section): change one,
 * change both — the unit tests pin every outcome. The rest of the module IS
 * runtime code, bundled to dist/review-assessment.js (see index.ts) and
 * invoked by review-pr/action.yml:
 *   - finalize-body validates the agent-authored review body before posting
 *     (exactly one status line, no approve/LGTM wording, no 🟢 NO FINDINGS
 *     over surviving findings or staged inline comments) and mechanically
 *     appends this run's hidden attribution marker;
 *   - classify-run classifies what a run actually posted from GitHub API
 *     state (exact run marker + selected SHA + ID above the pre-run
 *     baseline), fail-closed on anything ambiguous;
 *   - the run-marker predicates are shared with src/incremental-review
 *     (checkpoint recognition) and src/rate-limit (review counting).
 *
 * The model still applies the Decision Rules from the prompt — no code
 * recomputes the full assessment — but a body whose status line violates them
 * is refused at posting time, and a run whose posted review cannot be
 * verified is never presented as completed.
 *
 * Terminology: a finding SURVIVES when it is in scope and was not dismissed
 * or dropped — i.e. it will be surfaced anywhere in the posted review: as an
 * inline comment, in the lower-confidence summary, in the medium-severity
 * floor list, or in the unverified low-severity list. Out-of-scope, dropped
 * (negligible-band low), DISMISSED, and audit-only (dismissed security)
 * findings do not survive.
 *
 * Fail-closed invariants (regressions here caused real false approvals —
 * docker/gordon PRs #1798/#1803/#1808/#1809/#1814):
 *   - The bot NEVER approves: the GitHub event is always COMMENT and no
 *     outcome header may carry approve wording. The zero-findings label is
 *     the neutral "🟢 NO FINDINGS", never "🟢 APPROVE" or an LGTM.
 *   - An incomplete review (any drafter chunk errored, refused, or was
 *     truncated) never carries the "### Assessment:" completed-run marker,
 *     at ANY finding count.
 *   - Inconclusive verification (malformed/unpaired/refused verifier batch)
 *     likewise never carries the marker.
 *   - "🟢 NO FINDINGS" requires a complete review, conclusive verification,
 *     and exactly zero surviving findings of EVERY severity — a single
 *     surviving low finding forces a needs-attention assessment.
 */

export type Severity = 'high' | 'medium' | 'low';

/** Where a surviving finding is surfaced in the posted review. */
export type Disposition = 'inline' | 'summary';

export interface SurvivingFinding {
  severity: Severity;
  disposition: Disposition;
  /**
   * Verifier verdict for verified findings. Unverified low-severity findings
   * (verification is skipped for them) carry none — they still survive.
   */
  verdict?: 'CONFIRMED' | 'LIKELY';
}

export interface AssessmentInput {
  /** Merged review_complete across every drafter delegation (fail-closed). */
  reviewComplete: boolean;
  /**
   * False when the verifier batch was malformed, refused, or failed pairing.
   * True when verification succeeded or was not required (nothing to verify).
   */
  verificationConclusive: boolean;
  /** Findings that survive scope filtering, dismissal, and dropping. */
  survivingFindings: SurvivingFinding[];
}

/** Completed-run marker the incremental reviewer checkpoints on. */
export const ASSESSMENT_MARKER = '### Assessment:';
/** Body header for a review with unreviewed chunks — never a checkpoint. */
export const INCOMPLETE_HEADER = '### ⚠️ Review incomplete';
/** Body header for unverified surfaced findings — never a checkpoint. */
export const INCONCLUSIVE_HEADER = '### ⚠️ Verification inconclusive';

export const CRITICAL_LABEL = '🔴 CRITICAL';
export const NEEDS_ATTENTION_LABEL = '🟡 NEEDS ATTENTION';
/**
 * Neutral zero-findings completion label. Deliberately NOT an approval:
 * reviews posted before the label was neutralized carry the legacy
 * "🟢 APPROVE" — recognized as completed runs by src/incremental-review via
 * the "### Assessment:" marker, but never emitted again.
 */
export const NO_FINDINGS_LABEL = '🟢 NO FINDINGS';

/**
 * Hidden per-run attribution marker. A trusted pre-run step generates the
 * 32-hex nonce (Node crypto); the rendered posting command and every
 * fallback notice embed the full marker, so post-run classification can
 * attribute reviews to exactly one run by content — independent of the
 * posting login, which varies with the github-token input (docker-agent PAT,
 * docker-agent[bot]/github-actions[bot] app tokens, or a consumer identity).
 */
export const RUN_MARKER_PREFIX = '<!-- docker-agent-review-run:';
export const RUN_MARKER_SUFFIX = ' -->';
export const RUN_NONCE_PATTERN = /^[0-9a-f]{32}$/;
// Well-formed marker with ANY nonce — recognition across runs (incremental
// checkpoint, rate counting, notice dedup), where the per-run nonce differs.
const ANY_RUN_MARKER = /<!-- docker-agent-review-run:[0-9a-f]{32} -->/;

export function isValidRunNonce(nonce: string): boolean {
  return RUN_NONCE_PATTERN.test(nonce);
}

/** Build the exact marker for one run. Throws on a malformed nonce. */
export function runMarker(nonce: string): string {
  if (!isValidRunNonce(nonce)) {
    throw new Error('run nonce must be exactly 32 lowercase hex characters');
  }
  return `${RUN_MARKER_PREFIX}${nonce}${RUN_MARKER_SUFFIX}`;
}

/** True when the body carries a well-formed run marker (any nonce). */
export function hasRunMarker(body: string | null | undefined): boolean {
  return ANY_RUN_MARKER.test(body ?? '');
}

// GitHub presents the action's posting identity as "docker-agent" (machine
// user PAT — what setup-credentials stages) or "docker-agent[bot]" (GitHub
// App installation token).
export function matchesBotLogin(login: string | null | undefined, botLogin: string): boolean {
  return login === botLogin || login === `${botLogin}[bot]`;
}

/**
 * Whether a review is recognizable as posted by this action across runs:
 * the legacy docker-agent login variants, or a run-marker-bearing body from
 * a `[bot]`-suffixed login (default github.token posts as
 * "github-actions[bot]"; App tokens as "<app>[bot]").
 *
 * The `[bot]` requirement is deliberate: GitHub reserves that suffix for
 * installed Apps, so a human PR author cannot mint a marker-bearing review
 * that pins the incremental checkpoint past unreviewed commits or inflates
 * the rate count. Consumers posting with a plain PAT identity fall back to
 * full reviews — safe, just not incremental.
 */
export function isActionPostedReview(
  login: string | null | undefined,
  body: string | null | undefined,
  botLogin = 'docker-agent',
): boolean {
  if (matchesBotLogin(login, botLogin)) return true;
  return typeof login === 'string' && login.endsWith('[bot]') && hasRunMarker(body);
}

export type AssessmentKind =
  | 'incomplete'
  | 'inconclusive'
  | 'critical'
  | 'needs-attention'
  | 'no-findings';

export interface AssessmentOutcome {
  kind: AssessmentKind;
  /** First line of the posted review body. */
  header: string;
  /**
   * True only when the body may carry the "### Assessment:" completed-run
   * marker, i.e. the run may advance the incremental review checkpoint.
   */
  completedRun: boolean;
}

/**
 * Compute the review assessment. The GitHub review event is always COMMENT
 * regardless of the outcome — the assessment is the honest label inside the
 * body, never an APPROVE/REQUEST_CHANGES event, and no header ever presents
 * the bot as approving the PR.
 */
export function assessReview(input: AssessmentInput): AssessmentOutcome {
  if (!input.reviewComplete) {
    return { kind: 'incomplete', header: INCOMPLETE_HEADER, completedRun: false };
  }
  if (!input.verificationConclusive) {
    return { kind: 'inconclusive', header: INCONCLUSIVE_HEADER, completedRun: false };
  }
  const critical = input.survivingFindings.some(
    (finding) =>
      finding.severity === 'high' &&
      (finding.verdict === 'CONFIRMED' || finding.verdict === 'LIKELY'),
  );
  if (critical) {
    return {
      kind: 'critical',
      header: `${ASSESSMENT_MARKER} ${CRITICAL_LABEL}`,
      completedRun: true,
    };
  }
  if (input.survivingFindings.length > 0) {
    return {
      kind: 'needs-attention',
      header: `${ASSESSMENT_MARKER} ${NEEDS_ATTENTION_LABEL}`,
      completedRun: true,
    };
  }
  return {
    kind: 'no-findings',
    header: `${ASSESSMENT_MARKER} ${NO_FINDINGS_LABEL}`,
    completedRun: true,
  };
}

// ---------------------------------------------------------------------------
// Review body classification (finalize-body validation + posted-run status)
// ---------------------------------------------------------------------------

/** The only assessment lines a completed review body may carry. */
export const ALLOWED_ASSESSMENT_LINES = [
  `${ASSESSMENT_MARKER} ${NO_FINDINGS_LABEL}`,
  `${ASSESSMENT_MARKER} ${NEEDS_ATTENTION_LABEL}`,
  `${ASSESSMENT_MARKER} ${CRITICAL_LABEL}`,
] as const;

// Bold no-post fallback form (review-pr/action.yml's incomplete notice) —
// recognized alongside the agent-posted INCOMPLETE_HEADER.
const INCOMPLETE_NOTICE_PREFIX = '⚠️ **Review incomplete**';

// The bot never approves. Reviews are always COMMENT events, and no posted
// body may present the run as an approval — these exact strings are the
// wording pr-review.yaml already prohibits, matched as standalone words so
// prose like "approveTransfer" in a finding is not refused.
const FORBIDDEN_WORDING: { pattern: RegExp; label: string }[] = [
  { pattern: /🟢 APPROVE/, label: '"🟢 APPROVE"' },
  { pattern: /\bAPPROVED?\b/, label: '"APPROVE"' },
  { pattern: /\bLGTM\b/i, label: '"LGTM"' },
  { pattern: /no issues found/i, label: '"No issues found"' },
];

// Findings sections that contradict a 🟢 NO FINDINGS assessment: the label is
// reserved for zero surviving findings of every severity, so a body carrying
// it plus any findings list is refused.
const FINDINGS_SECTION_MARKERS = [
  '# Findings',
  '# Lower-confidence findings',
  '# Low-severity findings',
  '# Dismissed security findings',
  'Findings so far:',
];

export type BodyStatus =
  | { kind: 'completed'; assessment: string }
  | { kind: 'incomplete' }
  | { kind: 'inconclusive' }
  | { kind: 'invalid'; reason: string };

/**
 * Classify a review body against the posting policy. Fail-closed: anything
 * that is not exactly one recognized outcome is invalid. Prose before the
 * single status line (e.g. the incremental-review coverage note) is fine.
 */
export function classifyReviewBody(body: string | null | undefined): BodyStatus {
  const text = body ?? '';
  if (text.trim() === '') return { kind: 'invalid', reason: 'body is empty' };

  for (const { pattern, label } of FORBIDDEN_WORDING) {
    if (pattern.test(text)) {
      return { kind: 'invalid', reason: `body contains forbidden approval wording ${label}` };
    }
  }

  const assessmentMentions = text.split(ASSESSMENT_MARKER).length - 1;
  const incomplete = text.includes(INCOMPLETE_HEADER) || text.includes(INCOMPLETE_NOTICE_PREFIX);
  const inconclusive = text.includes(INCONCLUSIVE_HEADER);

  if (incomplete || inconclusive) {
    if (assessmentMentions > 0) {
      return {
        kind: 'invalid',
        reason: 'body mixes an assessment line with an incomplete/inconclusive marker',
      };
    }
    // Rule 4: incompleteness outranks inconclusive verification, so a body
    // carrying both is an incomplete review that also notes the inconclusive
    // verification — not a conflict.
    return incomplete ? { kind: 'incomplete' } : { kind: 'inconclusive' };
  }

  if (assessmentMentions === 0) {
    return { kind: 'invalid', reason: 'body carries no recognized status line' };
  }
  if (assessmentMentions > 1) {
    return { kind: 'invalid', reason: 'body carries more than one assessment line' };
  }
  const lines = text.split('\n').map((line) => line.trimEnd());
  const assessment = ALLOWED_ASSESSMENT_LINES.find((allowed) => lines.includes(allowed));
  if (!assessment) {
    return { kind: 'invalid', reason: 'assessment line is not one of the allowed labels' };
  }
  if (
    assessment === `${ASSESSMENT_MARKER} ${NO_FINDINGS_LABEL}` &&
    FINDINGS_SECTION_MARKERS.some((marker) => text.includes(marker))
  ) {
    return {
      kind: 'invalid',
      reason: '🟢 NO FINDINGS cannot be combined with findings sections in the same body',
    };
  }
  return { kind: 'completed', assessment };
}

/**
 * Validate an agent-authored body against the staged inline-comment count
 * and mechanically append this run's marker. Returns the finalized body;
 * throws with the refusal reason otherwise. The count is the trusted length
 * of /tmp/review_comments.json: 🟢 NO FINDINGS asserts zero surviving
 * findings, so it is refused over ANY staged inline comment; every other
 * recognized outcome may carry comments. Idempotent for the same nonce (a
 * retried posting command must not double-append); any OTHER run marker in
 * the body is refused — the model must never copy a stale marker from logs
 * or previous reviews.
 */
export function finalizeReviewBody(body: string, nonce: string, commentCount: number): string {
  const marker = runMarker(nonce);
  if (!Number.isInteger(commentCount) || commentCount < 0) {
    throw new Error('refusing to post review body: comment count must be a non-negative integer');
  }
  const status = classifyReviewBody(body);
  if (status.kind === 'invalid') {
    throw new Error(`refusing to post review body: ${status.reason}`);
  }
  if (
    status.kind === 'completed' &&
    status.assessment === `${ASSESSMENT_MARKER} ${NO_FINDINGS_LABEL}` &&
    commentCount > 0
  ) {
    throw new Error(
      `refusing to post review body: 🟢 NO FINDINGS cannot be posted with ${commentCount} staged inline comment(s)`,
    );
  }
  const foreign = body.replaceAll(marker, '');
  if (hasRunMarker(foreign)) {
    throw new Error('refusing to post review body: it carries a run marker from a different run');
  }
  if (body.includes(marker)) return body;
  return `${body.replace(/\s+$/, '')}\n\n${marker}\n`;
}

// ---------------------------------------------------------------------------
// Post-run classification (what did THIS run post?)
// ---------------------------------------------------------------------------

/** Review shape as GET /pulls/{n}/reviews returns it (fields we read). */
export interface PostedReviewLike {
  id?: number | null;
  user?: { login?: string | null } | null;
  body?: string | null;
  commit_id?: string | null;
  state?: string | null;
}

export type RunReviewStatus = 'completed' | 'incomplete' | 'inconclusive' | 'none' | 'unverified';

export interface RunClassification {
  status: RunReviewStatus;
  reason: string;
  /** ID of the single attributed review, when status is not none/unverified. */
  reviewId: number | null;
  /**
   * True when a prior action run already pinned an incomplete-review notice
   * to the same SHA — the caller's dedup guard for the no-post fallback.
   */
  priorIncompleteNotice: boolean;
}

const SHA40 = /^[0-9a-f]{40}$/i;

/**
 * Classify the review THIS run posted from GitHub API state. Attribution is
 * exact: the run's unguessable marker, on the selected immutable SHA, with a
 * review ID above the pre-run baseline. Fail closed (`unverified`) on
 * anything ambiguous — duplicated markers, markers off the selected SHA or
 * at/below the baseline (stale/copied), non-COMMENTED state, and fresh
 * same-SHA bot-identity reviews that lack the marker (a bypassed template
 * cannot be told apart from another integration's post).
 */
export function classifyRunReviews(
  reviews: PostedReviewLike[],
  opts: { sha: string; baselineId: number; nonce: string },
): RunClassification {
  if (!SHA40.test(opts.sha)) {
    return {
      status: 'unverified',
      reason: 'selected head SHA is not a 40-hex commit',
      reviewId: null,
      priorIncompleteNotice: false,
    };
  }
  if (!Number.isInteger(opts.baselineId) || opts.baselineId < 0) {
    return {
      status: 'unverified',
      reason: 'pre-run review baseline is not a review ID',
      reviewId: null,
      priorIncompleteNotice: false,
    };
  }
  let marker: string;
  try {
    marker = runMarker(opts.nonce);
  } catch {
    return {
      status: 'unverified',
      reason: 'run nonce is malformed',
      reviewId: null,
      priorIncompleteNotice: false,
    };
  }

  const sameSha = (review: PostedReviewLike): boolean =>
    (review.commit_id ?? '').toLowerCase() === opts.sha.toLowerCase();
  const priorIncompleteNotice = reviews.some(
    (review) =>
      sameSha(review) &&
      (review.body ?? '').startsWith(INCOMPLETE_NOTICE_PREFIX) &&
      isActionPostedReview(review.user?.login, review.body),
  );
  const result = (status: RunReviewStatus, reason: string, reviewId: number | null = null) => ({
    status,
    reason,
    reviewId,
    priorIncompleteNotice,
  });

  const marked = reviews.filter((review) => (review.body ?? '').includes(marker));
  if (marked.length === 0) {
    // No marker anywhere. A fresh same-SHA review from a bot identity is
    // unattributable (template bypassed? another integration?) — fail closed
    // instead of posting a duplicate no-post notice next to it. Fresh human
    // reviews on the same SHA are unrelated and never count.
    const unmarkedBot = reviews.some(
      (review) =>
        sameSha(review) &&
        typeof review.id === 'number' &&
        review.id > opts.baselineId &&
        (matchesBotLogin(review.user?.login, 'docker-agent') ||
          (review.user?.login ?? '').endsWith('[bot]')),
    );
    if (unmarkedBot) {
      return result(
        'unverified',
        'a fresh same-SHA bot review carries no run marker — cannot attribute it to this run',
      );
    }
    return result('none', 'no review carries this run\u2019s marker');
  }
  if (marked.length > 1) {
    return result('unverified', 'multiple reviews carry this run\u2019s marker');
  }

  const review = marked[0];
  if (typeof review.id !== 'number' || review.id <= opts.baselineId) {
    return result('unverified', 'marker-bearing review predates the pre-run baseline');
  }
  if (!sameSha(review)) {
    return result('unverified', 'marker-bearing review is not on the selected SHA');
  }
  if ((review.state ?? '') !== 'COMMENTED') {
    return result(
      'unverified',
      `marker-bearing review has state ${JSON.stringify(review.state ?? '')}, expected COMMENTED`,
      review.id,
    );
  }
  const status = classifyReviewBody(review.body);
  if (status.kind === 'invalid') {
    return result(
      'unverified',
      `marker-bearing review body is invalid: ${status.reason}`,
      review.id,
    );
  }
  return result(status.kind, `review ${review.id} classified as ${status.kind}`, review.id);
}
