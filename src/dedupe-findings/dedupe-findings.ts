// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * dedupe-findings — core logic for dropping review comments that duplicate a
 * finding already posted on the PR in a previous review cycle.
 *
 * On a full re-review (e.g. after a rebase forces the incremental path to
 * fall back), the pipeline re-analyzes the whole diff and tends to re-derive
 * the same findings. Posting them again creates duplicate threads. This module
 * compares each about-to-be-posted comment against the bot's existing inline
 * review comments — and, when provided, the PR's prior review-thread state —
 * and drops the duplicates.
 *
 * Matching against existing REST review comments (legacy behavior, all three
 * must hold):
 *   1. same file path;
 *   2. line proximity — the anchors are within `lineTolerance` lines of each
 *      other (pushes shift line numbers slightly; GitHub nulls `line` on
 *      outdated comments, in which case `original_line` is used);
 *   3. finding-signature similarity — the normalized token set of the
 *      comment's heading (the finding type + one-line summary the agent puts
 *      in the leading `**[severity] …**` block) has a Jaccard similarity of at
 *      least `similarityThreshold` with the existing comment's heading. A
 *      leading `[high]`/`[medium]`/`[low]` tag is stripped from the signature:
 *      severity is a grade the agent may re-assign between reviews, not part
 *      of the finding's identity. A leading category tag such as `[security]`
 *      IS kept so different finding classes on the same line don't collapse.
 *
 * Matching against prior review threads (GraphQL `reviewThreads` nodes passed
 * via `DedupeOptions.priorThreads`): only threads whose ROOT comment is a
 * marked bot review comment participate, and only while the thread is
 * explicitly current (`isOutdated === false` — a missing, null, or otherwise
 * malformed state fails open and never suppresses). A current thread
 * suppresses whether it is resolved or not — resolved means a human already
 * dealt with the finding, unresolved means the thread is still open;
 * re-posting either duplicates it. An outdated thread's code changed after
 * the comment was posted, so the re-derived finding is kept for
 * reassessment. A current thread matches by the heading rule above, or by a
 * conservative paraphrase matcher: same path, at least MIN_SHARED_ANCHORS
 * shared code anchors (inline code spans and identifier-shaped tokens), line
 * drift within `anchorLineTolerance`, AND at least MIN_HEADING_OVERLAP
 * meaningful heading tokens in common (stopwords and classification
 * vocabulary filtered out). Anchor evidence is what earns the wider drift
 * window; the heading-overlap requirement keeps two DIFFERENT findings about
 * the same identifiers apart. A single shared identifier never suppresses,
 * and REST comments keep the heading-only rule.
 *
 * Outdated threads additionally shield their own root comments from the
 * legacy REST layer: GitHub keeps returning an outdated thread's root among
 * the PR's review comments (with `line` nulled and the anchor kept in
 * `original_line`), where it would suppress exactly the reassessment the
 * outdated state mandates. A REST comment whose validated numeric `id`
 * equals the root `databaseId` of an explicitly outdated marked bot thread
 * is therefore excluded from the legacy candidates. The correlation is
 * conservative: a missing or malformed id on either side, an unmarked root,
 * or a thread without an explicit boolean lifecycle excludes nothing, and
 * the roots of current threads keep suppressing through both layers.
 *
 * Kept findings are additionally audited against OUTDATED threads: when a
 * kept comment re-derives an outdated thread's finding (same matching rules)
 * at a HIGHER heading severity, the pair is reported in
 * `DedupeResult.escalations`. Nothing is blocked — reassessment may
 * legitimately escalate after the code changed — but the caller can surface
 * that the escalation needs changed-code evidence; judging that evidence
 * stays with the review policy, not this module.
 *
 * Only existing comments that carry a review marker (`<!-- docker-agent-review -->`
 * or the legacy `<!-- cagent-review -->`) participate — human comments and the
 * bot's conversational replies (whose marker is `-review-reply`) never
 * suppress a finding.
 */

// The reply marker "<!-- docker-agent-review-reply -->" does not contain
// "<!-- docker-agent-review -->" as a substring (the space before "-->"
// differs), so this check cannot match reply comments.
const REVIEW_MARKERS = ['<!-- docker-agent-review -->', '<!-- cagent-review -->'];

export interface NewComment {
  path?: unknown;
  line?: unknown;
  body?: unknown;
  [key: string]: unknown;
}

export interface ExistingComment {
  /**
   * REST review-comment id (numeric per the GitHub API; the same identifier
   * GraphQL exposes as `databaseId`). Used only to correlate the comment
   * with prior-thread roots — a missing or malformed id merely opts the
   * comment out of that correlation and it participates exactly as before.
   */
  id?: number | null;
  path?: string | null;
  line?: number | null;
  original_line?: number | null;
  body?: string | null;
}

/** One comment node of a prior review thread (GraphQL `comments.nodes` entry). */
export interface PriorThreadComment {
  /** REST id of the same comment; correlates thread roots with REST comments. */
  databaseId?: number | null;
  body?: string | null;
  author?: { login?: string | null } | null;
  /** Non-null on replies; a thread's root comment has no `replyTo`. */
  replyTo?: { databaseId?: number | null } | null;
  [key: string]: unknown;
}

/**
 * Prior review-thread state as fetched via the GraphQL `reviewThreads`
 * connection. Extra fields (id, …) are tolerated and ignored; malformed
 * entries are skipped at runtime.
 */
export interface PriorReviewThread {
  path?: string | null;
  line?: number | null;
  originalLine?: number | null;
  isResolved?: boolean | null;
  isOutdated?: boolean | null;
  comments?: { nodes?: (PriorThreadComment | null)[] | null } | null;
  [key: string]: unknown;
}

export interface DedupeOptions {
  /** Max distance between line anchors to still count as the same spot. */
  lineTolerance?: number;
  /** Minimum Jaccard similarity between finding signatures (0..1]. */
  similarityThreshold?: number;
  /**
   * Prior review-thread state of the PR. Explicitly current
   * (`isOutdated === false`) bot threads suppress re-derived findings whether
   * resolved or not; explicitly outdated (`isOutdated === true`) threads
   * never suppress — their root comments are excluded from the REST
   * candidates by id so the legacy layer cannot either — but feed the
   * severity-escalation audit. Threads with a missing or malformed
   * `isOutdated` state are ignored entirely (fail-open), and missing or
   * malformed history leaves the REST-comment behavior untouched.
   */
  priorThreads?: PriorReviewThread[] | null;
  /** Max line drift for the anchor-based (paraphrase) thread matcher. */
  anchorLineTolerance?: number;
}

export interface DroppedComment {
  path: string;
  line: number;
  matchedLine: number;
  signature: string;
  /** What suppressed the comment. */
  source: 'existing-comment' | 'prior-thread';
  /** Which rule matched: heading similarity or shared code anchors. */
  matchedBy: 'heading' | 'anchors';
}

export type Severity = 'high' | 'medium' | 'low';

/**
 * A kept comment that re-derives an OUTDATED thread's finding at a higher
 * heading severity. Reassessment may legitimately escalate, so the comment is
 * never dropped; the record exists so the escalation can be audited for
 * changed-code evidence.
 */
export interface SeverityEscalation {
  path: string;
  line: number;
  matchedLine: number;
  signature: string;
  newSeverity: Severity;
  priorSeverity: Severity;
  matchedBy: 'heading' | 'anchors';
}

export interface DedupeResult {
  kept: NewComment[];
  dropped: DroppedComment[];
  escalations: SeverityEscalation[];
}

const DEFAULT_LINE_TOLERANCE = 3;
const DEFAULT_SIMILARITY_THRESHOLD = 0.5;
// The anchor matcher may bridge a larger drift than the heading matcher
// because it demands hard evidence (multiple shared identifiers). 20 covers
// the 13-line drift seen in docker/sandboxes#4890 with headroom while still
// keeping distant same-file findings apart.
const DEFAULT_ANCHOR_LINE_TOLERANCE = 20;
// A single shared identifier is routine for two different findings about the
// same code; require at least two before calling them the same finding.
const MIN_SHARED_ANCHORS = 2;
// Shared anchors alone cannot tell one finding from another about the same
// code: `processPayment logs paymentAmount in plaintext` and `processPayment
// double-charges paymentAmount on retry` share two anchors yet only those two
// heading tokens. Three meaningful shared heading tokens keeps such pairs
// apart while both docker/sandboxes#4890 rephrasings still clear the bar (the
// credential-variable fragments; llmman + personal + repo).
const MIN_HEADING_OVERLAP = 3;

// Severity is a grade the agent may legitimately re-assign between review
// cycles, so it never contributes to a finding's identity.
const SEVERITY_TOKENS = new Set(['high', 'medium', 'low']);

const SEVERITY_RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1 };

// Review-pipeline classification vocabulary: these words describe a finding
// rather than the code it points at, so they never count as code anchors
// (category tokens DO stay in the heading signature).
const NON_ANCHOR_TOKENS = new Set([
  ...SEVERITY_TOKENS,
  'security',
  'logic_error',
  'resource_leak',
  'concurrency',
  'error_handling',
  'data_integrity',
  'other',
]);

// Words that say nothing about which defect a heading describes: grammatical
// glue plus the classification vocabulary as it tokenizes inside headings
// (`[security]`, `error_handling` → error/handling, …). Filtered out of the
// anchor matcher's heading-overlap count so two findings never look related
// through them alone.
const HEADING_NOISE_TOKENS = new Set([
  ...SEVERITY_TOKENS,
  ...['security', 'logic', 'error', 'resource', 'leak', 'concurrency', 'handling'],
  ...['data', 'integrity', 'other'],
  ...['a', 'an', 'the', 'and', 'or', 'nor', 'not', 'no'],
  ...['of', 'in', 'on', 'at', 'to', 'from', 'for', 'with', 'without', 'via', 'by', 'as'],
  ...['into', 'onto', 'over', 'under', 'between', 'within', 'across', 'per'],
  ...['is', 'are', 'was', 'were', 'be', 'been', 'being', 'has', 'have', 'had'],
  ...['do', 'does', 'did', 'done', 'can', 'could', 'may', 'might', 'must', 'should'],
  ...['would', 'will', 'it', 'its', 'this', 'that', 'these', 'those', 'their'],
  ...['there', 'then', 'than', 'when', 'while', 'where', 'which', 'who', 'whose'],
  ...['what', 'how', 'why', 'if', 'but', 'so', 'after', 'before', 'during'],
  ...['still', 'also', 'only', 'never', 'always', 'same', 'each', 'every', 'all'],
  ...['any', 'some'],
]);

// Leading `[…]` tag of a heading; tolerates markdown emphasis characters in
// front so the fallback first line of a wrapped `**…` heading is handled too.
const LEADING_TAG = /^[\s*_]*\[([^\]\n]*)\]/;
const FENCED_CODE_BLOCK = /```[\s\S]*?```/g;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const INLINE_CODE_SPAN = /`([^`\n]+)`/g;
const IDENTIFIER_WORD = /[A-Za-z_][A-Za-z0-9_]*/g;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/**
 * The heading line of a comment body: the first single-line bold block
 * (`**[severity] summary**` per the posting format), falling back to the
 * first non-empty line. Bold spans that wrap across lines are skipped so they
 * cannot inflate the token set.
 */
function headingOf(body: string): string {
  const bold = body.match(/\*\*([^*\n]+)\*\*/);
  return bold?.[1] ?? body.split('\n').find((line) => line.trim().length > 0) ?? '';
}

/**
 * Extract the normalized token set identifying a finding from a comment body.
 *
 * Reads the heading (see `headingOf`). Leading bracket tags are parsed
 * separately: `high`/`medium`/`low` severity words are dropped (a re-graded
 * duplicate must still match) while any other tag token — e.g. the `security`
 * category — is kept. Severity words inside the summary itself are ordinary
 * tokens. Returns null when no usable text exists.
 */
export function findingSignature(body: string): string[] | null {
  let heading = headingOf(body);
  const tokens: string[] = [];
  let tag = heading.match(LEADING_TAG);
  while (tag !== null) {
    tokens.push(...tokenize(tag[1]).filter((token) => !SEVERITY_TOKENS.has(token)));
    heading = heading.slice(tag[0].length);
    tag = heading.match(LEADING_TAG);
  }
  tokens.push(...tokenize(heading));
  return tokens.length > 0 ? [...new Set(tokens)] : null;
}

function isSeverity(token: string): token is Severity {
  return SEVERITY_TOKENS.has(token);
}

/**
 * The severity grade in the heading's leading `[…]` tags, or null when no
 * leading tag carries one. Severity words inside the summary itself do not
 * count, mirroring `findingSignature`.
 */
export function headingSeverity(body: string): Severity | null {
  let heading = headingOf(body);
  let tag = heading.match(LEADING_TAG);
  while (tag !== null) {
    const severity = tokenize(tag[1]).find(isSeverity);
    if (severity !== undefined) return severity;
    heading = heading.slice(tag[0].length);
    tag = heading.match(LEADING_TAG);
  }
  return null;
}

export function signatureSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  let intersection = 0;
  for (const token of a) {
    if (setB.has(token)) intersection++;
  }
  const union = a.length + b.length - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Count the heading-signature tokens two findings share once stopwords and
 * classification vocabulary are filtered out. This is the semantic
 * corroboration the anchor matcher demands on top of shared identifiers:
 * fragments of a shared multi-word identifier and genuinely descriptive words
 * both count, glue words and category tags never do.
 */
export function meaningfulHeadingOverlap(a: string[], b: string[]): number {
  const setB = new Set(b);
  let shared = 0;
  for (const token of a) {
    if (!HEADING_NOISE_TOKENS.has(token) && setB.has(token)) shared++;
  }
  return shared;
}

/**
 * Extract the code anchors of a comment body: inline code spans plus
 * identifier-shaped words (snake_case, camelCase, or letter+digit mixes).
 * Fenced code blocks are ignored (a suggestion block would leak whole hunks
 * shared by unrelated findings), as are HTML comments (markers). Plain prose
 * words and lone lowercase spans like `err` are not distinctive enough to
 * count. Anchors are lowercased; the paraphrase matcher treats them as
 * identity evidence.
 */
export function codeAnchors(body: string): string[] {
  const prose = body.replace(FENCED_CODE_BLOCK, ' ').replace(HTML_COMMENT, ' ');
  const anchors = new Set<string>();
  for (const match of prose.matchAll(INLINE_CODE_SPAN)) {
    const span = match[1].trim();
    if (span.length >= 3 && !/\s/.test(span) && /[A-Z0-9_./*-]/.test(span)) {
      addAnchor(anchors, span);
    }
  }
  for (const match of prose.matchAll(IDENTIFIER_WORD)) {
    const word = match[0];
    if (
      word.length >= 3 &&
      (word.includes('_') || /[a-z][A-Z]/.test(word) || /[A-Za-z][0-9]/.test(word))
    ) {
      addAnchor(anchors, word);
    }
  }
  return [...anchors];
}

function addAnchor(anchors: Set<string>, raw: string): void {
  const anchor = raw.toLowerCase();
  if (!NON_ANCHOR_TOKENS.has(anchor)) anchors.add(anchor);
}

function hasReviewMarker(body: string): boolean {
  return REVIEW_MARKERS.some((marker) => body.includes(marker));
}

function isBotReviewComment(comment: ExistingComment): boolean {
  return hasReviewMarker(comment.body ?? '');
}

function anchorLine(comment: ExistingComment): number | null {
  // GitHub nulls `line` when a push outdates the comment position but keeps
  // the original anchor in `original_line`.
  const line = comment.line ?? comment.original_line;
  return typeof line === 'number' && Number.isInteger(line) && line > 0 ? line : null;
}

/**
 * Validated GitHub comment id. REST review comments (`id`) and GraphQL
 * thread comments (`databaseId`) name the same positive-integer identifier,
 * which is what allows the two layers to be correlated. Anything else cannot
 * be correlated safely and yields null.
 */
function commentId(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function threadAnchorLine(thread: PriorReviewThread): number | null {
  // Same nulling as REST comments: GraphQL keeps the original anchor in
  // `originalLine` when `line` is no longer valid.
  const line = thread.line ?? thread.originalLine;
  return typeof line === 'number' && Number.isInteger(line) && line > 0 ? line : null;
}

/**
 * The thread's root comment — the finding itself. Replies never carry a
 * finding's identity, so a thread whose first visible comment is a reply (or
 * that has no comment nodes at all) yields null.
 */
function threadRootComment(thread: PriorReviewThread): PriorThreadComment | null {
  const nodes = thread.comments?.nodes;
  if (!Array.isArray(nodes)) return null;
  const first = nodes.find((node) => typeof node === 'object' && node !== null);
  return first == null || first.replyTo ? null : first;
}

interface ThreadCandidate {
  path: string;
  line: number;
  signature: string[];
  anchors: Set<string>;
  severity: Severity | null;
}

interface ThreadCandidates {
  /** Explicitly current threads (`isOutdated === false`): these suppress. */
  current: ThreadCandidate[];
  /** Explicitly outdated threads: reassessment plus the escalation audit. */
  outdated: ThreadCandidate[];
  /**
   * Root-comment ids of the explicitly outdated marked bot threads. The same
   * comments come back from the REST list, where they would suppress the
   * reassessment the outdated thread mandates — these ids exclude them from
   * the legacy candidates.
   */
  outdatedRootIds: Set<number>;
}

function buildThreadCandidates(threads: PriorReviewThread[] | null | undefined): ThreadCandidates {
  const candidates: ThreadCandidates = { current: [], outdated: [], outdatedRootIds: new Set() };
  if (!Array.isArray(threads)) return candidates;
  for (const thread of threads) {
    if (typeof thread !== 'object' || thread === null) continue;
    // Fail-open on malformed history: only an explicit boolean states the
    // thread's lifecycle. false = current (may suppress); true = outdated (the
    // finding is reassessed, never suppressed, and audited for severity
    // escalation); anything else is unknown state and never participates.
    if (thread.isOutdated !== false && thread.isOutdated !== true) continue;
    const root = threadRootComment(thread);
    const body = typeof root?.body === 'string' ? root.body : '';
    if (!hasReviewMarker(body)) continue;
    // The root id is collected before the anchor/signature gates: lifecycle
    // alone decides the REST exclusion, even when the thread cannot become a
    // matching candidate itself.
    const rootId = commentId(root?.databaseId);
    if (thread.isOutdated === true && rootId !== null) candidates.outdatedRootIds.add(rootId);
    const path = typeof thread.path === 'string' ? thread.path : '';
    const line = threadAnchorLine(thread);
    if (path === '' || line === null) continue;
    const signature = findingSignature(body);
    if (signature === null) continue;
    const candidate: ThreadCandidate = {
      path,
      line,
      signature,
      anchors: new Set(codeAnchors(body)),
      severity: headingSeverity(body),
    };
    (thread.isOutdated === false ? candidates.current : candidates.outdated).push(candidate);
  }
  return candidates;
}

function sharedAnchorCount(anchors: string[], candidateAnchors: ReadonlySet<string>): number {
  let shared = 0;
  for (const anchor of anchors) {
    if (candidateAnchors.has(anchor)) shared++;
  }
  return shared;
}

/**
 * Partition `newComments` into comments to post and duplicates of existing
 * bot findings. Malformed new comments (no path/line/body) are always kept —
 * downstream validation owns rejecting them.
 */
export function dedupeComments(
  newComments: NewComment[],
  existingComments: ExistingComment[],
  opts: DedupeOptions = {},
): DedupeResult {
  const lineTolerance = opts.lineTolerance ?? DEFAULT_LINE_TOLERANCE;
  const similarityThreshold = opts.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const anchorLineTolerance = opts.anchorLineTolerance ?? DEFAULT_ANCHOR_LINE_TOLERANCE;

  const threadCandidates = buildThreadCandidates(opts.priorThreads);
  const hasThreadCandidates =
    threadCandidates.current.length > 0 || threadCandidates.outdated.length > 0;

  const commentCandidates = existingComments
    .filter((comment) => isBotReviewComment(comment))
    // Cross-layer exclusion: the root of an explicitly outdated bot thread
    // also appears in the REST list, where it would suppress (via
    // `original_line`) the very reassessment the outdated thread mandates.
    // Only a validated id match excludes — an uncorrelatable id keeps the
    // comment as a candidate, and current-thread roots keep suppressing.
    .filter((comment) => {
      const id = commentId(comment.id);
      return id === null || !threadCandidates.outdatedRootIds.has(id);
    })
    .map((comment) => ({
      path: comment.path ?? '',
      line: anchorLine(comment),
      signature: findingSignature(comment.body ?? ''),
    }))
    .filter(
      (comment): comment is { path: string; line: number; signature: string[] } =>
        comment.path !== '' && comment.line !== null && comment.signature !== null,
    );

  if (commentCandidates.length === 0 && !hasThreadCandidates) {
    return { kept: [...newComments], dropped: [], escalations: [] };
  }

  const matchesByHeading = (
    candidate: { path: string; line: number; signature: string[] },
    path: string,
    line: number,
    signature: string[],
  ): boolean =>
    candidate.path === path &&
    Math.abs(candidate.line - line) <= lineTolerance &&
    signatureSimilarity(signature, candidate.signature) >= similarityThreshold;

  // Thread rule: heading similarity, or — with harder evidence and a wider
  // drift window — shared code anchors corroborated by meaningful heading
  // overlap (shared identifiers alone never identify the same finding).
  const matchThread = (
    candidate: ThreadCandidate,
    path: string,
    line: number,
    signature: string[],
    anchors: string[],
  ): DroppedComment['matchedBy'] | null => {
    if (candidate.path !== path) return null;
    if (matchesByHeading(candidate, path, line, signature)) return 'heading';
    if (
      Math.abs(candidate.line - line) <= anchorLineTolerance &&
      sharedAnchorCount(anchors, candidate.anchors) >= MIN_SHARED_ANCHORS &&
      meaningfulHeadingOverlap(signature, candidate.signature) >= MIN_HEADING_OVERLAP
    ) {
      return 'anchors';
    }
    return null;
  };

  const kept: NewComment[] = [];
  const dropped: DroppedComment[] = [];
  const escalations: SeverityEscalation[] = [];

  for (const comment of newComments) {
    const path = typeof comment.path === 'string' ? comment.path : '';
    const line =
      typeof comment.line === 'number' && Number.isInteger(comment.line) ? comment.line : null;
    const body = typeof comment.body === 'string' ? comment.body : '';
    const signature = findingSignature(body);

    if (path === '' || line === null || signature === null) {
      kept.push(comment);
      continue;
    }

    // Legacy layer: the PR's existing REST review comments, heading-only.
    const commentMatch = commentCandidates.find((candidate) =>
      matchesByHeading(candidate, path, line, signature),
    );
    if (commentMatch) {
      dropped.push({
        path,
        line,
        matchedLine: commentMatch.line,
        signature: signature.join(' '),
        source: 'existing-comment',
        matchedBy: 'heading',
      });
      continue;
    }

    const anchors = hasThreadCandidates ? codeAnchors(body) : [];

    // History layer: explicitly current bot threads suppress.
    let threadDrop: DroppedComment | null = null;
    for (const candidate of threadCandidates.current) {
      const matchedBy = matchThread(candidate, path, line, signature, anchors);
      if (matchedBy === null) continue;
      threadDrop = {
        path,
        line,
        matchedLine: candidate.line,
        signature: signature.join(' '),
        source: 'prior-thread',
        matchedBy,
      };
      break;
    }
    if (threadDrop) {
      dropped.push(threadDrop);
      continue;
    }

    kept.push(comment);

    // Reassessment audit: a kept finding matching an OUTDATED thread may
    // legitimately return at a higher severity only with changed-code
    // evidence; record the escalation so the caller can surface it.
    const newSeverity = headingSeverity(body);
    if (newSeverity === null) continue;
    for (const candidate of threadCandidates.outdated) {
      if (candidate.severity === null) continue;
      if (SEVERITY_RANK[newSeverity] <= SEVERITY_RANK[candidate.severity]) continue;
      const matchedBy = matchThread(candidate, path, line, signature, anchors);
      if (matchedBy === null) continue;
      escalations.push({
        path,
        line,
        matchedLine: candidate.line,
        signature: signature.join(' '),
        newSeverity,
        priorSeverity: candidate.severity,
        matchedBy,
      });
      break;
    }
  }

  return { kept, dropped, escalations };
}
