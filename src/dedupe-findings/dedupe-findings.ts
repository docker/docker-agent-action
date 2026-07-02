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
 * review comments and drops the duplicates.
 *
 * Matching model (all three must hold):
 *   1. same file path;
 *   2. line proximity — the anchors are within `lineTolerance` lines of each
 *      other (pushes shift line numbers slightly; GitHub nulls `line` on
 *      outdated comments, in which case `original_line` is used);
 *   3. finding-signature similarity — the normalized token set of the
 *      comment's heading (the finding type + one-line summary the agent puts
 *      in the leading `**[severity] …**` block) has a Jaccard similarity of at
 *      least `similarityThreshold` with the existing comment's heading.
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
  path?: string | null;
  line?: number | null;
  original_line?: number | null;
  body?: string | null;
}

export interface DedupeOptions {
  /** Max distance between line anchors to still count as the same spot. */
  lineTolerance?: number;
  /** Minimum Jaccard similarity between finding signatures (0..1]. */
  similarityThreshold?: number;
}

export interface DroppedComment {
  path: string;
  line: number;
  matchedLine: number;
  signature: string;
}

export interface DedupeResult {
  kept: NewComment[];
  dropped: DroppedComment[];
}

const DEFAULT_LINE_TOLERANCE = 3;
const DEFAULT_SIMILARITY_THRESHOLD = 0.5;

/**
 * Extract the normalized token set identifying a finding from a comment body.
 *
 * Prefers the first bold block (`**[severity] summary**` per the posting
 * format); falls back to the first non-empty line. A leading `[severity]` /
 * `[category]` tag is kept as tokens — it participates in the similarity so a
 * "security" and a "logic_error" finding on the same line don't collapse.
 * Returns null when no usable text exists.
 */
export function findingSignature(body: string): string[] | null {
  const bold = body.match(/\*\*([^*]+)\*\*/);
  const heading = bold?.[1] ?? body.split('\n').find((line) => line.trim().length > 0) ?? '';
  const tokens = heading
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
  return tokens.length > 0 ? [...new Set(tokens)] : null;
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

function isBotReviewComment(comment: ExistingComment): boolean {
  const body = comment.body ?? '';
  return REVIEW_MARKERS.some((marker) => body.includes(marker));
}

function anchorLine(comment: ExistingComment): number | null {
  // GitHub nulls `line` when a push outdates the comment position but keeps
  // the original anchor in `original_line`.
  const line = comment.line ?? comment.original_line;
  return typeof line === 'number' && Number.isInteger(line) && line > 0 ? line : null;
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

  const candidates = existingComments
    .filter((comment) => isBotReviewComment(comment))
    .map((comment) => ({
      path: comment.path ?? '',
      line: anchorLine(comment),
      signature: findingSignature(comment.body ?? ''),
    }))
    .filter(
      (comment): comment is { path: string; line: number; signature: string[] } =>
        comment.path !== '' && comment.line !== null && comment.signature !== null,
    );

  if (candidates.length === 0) {
    return { kept: [...newComments], dropped: [] };
  }

  const kept: NewComment[] = [];
  const dropped: DroppedComment[] = [];

  for (const comment of newComments) {
    const path = typeof comment.path === 'string' ? comment.path : '';
    const line =
      typeof comment.line === 'number' && Number.isInteger(comment.line) ? comment.line : null;
    const signature = typeof comment.body === 'string' ? findingSignature(comment.body) : null;

    if (path === '' || line === null || signature === null) {
      kept.push(comment);
      continue;
    }

    const match = candidates.find(
      (candidate) =>
        candidate.path === path &&
        Math.abs(candidate.line - line) <= lineTolerance &&
        signatureSimilarity(signature, candidate.signature) >= similarityThreshold,
    );

    if (match) {
      dropped.push({ path, line, matchedLine: match.line, signature: signature.join(' ') });
    } else {
      kept.push(comment);
    }
  }

  return { kept, dropped };
}
