// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * incremental-review — core logic for reviewing only the commits pushed since
 * the last docker-agent review, instead of re-reviewing the full PR diff on
 * every trigger.
 *
 * ## State tracking design
 *
 * The "last reviewed commit SHA" is read from the metadata GitHub records on
 * every posted review: `commit_id` on `GET /pulls/{n}/reviews` is the PR head
 * SHA at posting time. This survives across workflow runs, requires no extra
 * writes, and cannot be edited away like a marker embedded in a comment body.
 * Only reviews that represent a *completed* run count — an assessment body
 * ("### Assessment:") or the zero-findings LGTM fallback. Timeout and failure
 * fallback reviews do NOT mark commits as reviewed, so the next run re-covers
 * them.
 *
 * ## Fallbacks to a full review (see planIncrementalReview)
 *
 *   no-previous-review   no completed docker-agent review found on the PR
 *   no-new-commits       HEAD is the last reviewed commit (explicit re-request)
 *   unknown-sha          last reviewed SHA is absent from the local clone
 *   history-rewritten    last reviewed SHA is not an ancestor of HEAD
 *                        (force-push or rebase — the incremental range would
 *                        be meaningless)
 *   base-unresolved      origin/<base> could not be resolved locally
 *   base-merged-in       the base branch was merged into the PR branch after
 *                        the last review (the range would drag in base changes)
 *
 * The incremental diff (`git diff <last-sha>..HEAD`) is additionally
 * intersected at file level with the full PR diff: a file whose changes since
 * the last review cancel out against the base (net-zero) is not part of the
 * PR diff, so GitHub would reject inline comments anchored there (HTTP 422).
 */

/** Result of one git invocation. Injectable for deterministic tests. */
export interface GitResult {
  ok: boolean;
  stdout: string;
}

export type GitRunner = (args: string[]) => GitResult;

export interface ReviewLike {
  user?: { login?: string | null } | null;
  body?: string | null;
  commit_id?: string | null;
  submitted_at?: string | null;
}

export type ReviewMode = 'incremental' | 'full';

export interface IncrementalPlan {
  mode: ReviewMode;
  /** 'ok' for incremental mode; otherwise the fallback reason. */
  reason: string;
  lastReviewedSha: string | null;
  headSha: string | null;
}

// Full 40-hex only: the value is passed to git as an argument, so anything
// looser (e.g. a body that starts with "-") must never get through.
const SHA40 = /^[0-9a-f]{40}$/i;

// Bodies that mark a review run as completed. The timeout ("⏱️ **PR Review
// Timed Out**") and failure ("❌ **PR Review Failed**") fallbacks match
// neither, so unreviewed commits stay unreviewed.
const COMPLETED_BODY_MARKERS = ['### Assessment:', '🟢 **No issues found**'];

// GitHub presents the bot identity as "docker-agent" when posting with a
// machine user token, or "docker-agent[bot]" through a GitHub App installation
// token. Match both (same convention as src/rate-limit).
function matchesBotLogin(login: string | null | undefined, botLogin: string): boolean {
  return login === botLogin || login === `${botLogin}[bot]`;
}

/**
 * Find the head SHA recorded on the most recent *completed* docker-agent
 * review of the PR. Returns null when no such review exists.
 */
export function findLastReviewedSha(
  reviews: ReviewLike[],
  botLogin = 'docker-agent',
): string | null {
  let best: { sha: string; at: number } | null = null;
  for (const review of reviews) {
    if (!matchesBotLogin(review.user?.login, botLogin)) continue;
    const body = review.body ?? '';
    if (!COMPLETED_BODY_MARKERS.some((marker) => body.includes(marker))) continue;
    const sha = review.commit_id ?? '';
    if (!SHA40.test(sha)) continue;
    if (!review.submitted_at) continue;
    const at = Date.parse(review.submitted_at);
    if (!Number.isFinite(at)) continue;
    // >= so that among equal timestamps the later list entry (newest — the
    // Reviews API returns oldest-first) wins.
    if (best === null || at >= best.at) best = { sha, at };
  }
  return best?.sha ?? null;
}

/**
 * Decide whether an incremental review is safe, using only local git state.
 * Every ambiguous situation falls back to a full review — a full review is
 * always correct, an incremental one is only an optimization.
 */
export function planIncrementalReview(opts: {
  lastReviewedSha: string | null;
  baseRef: string;
  git: GitRunner;
}): IncrementalPlan {
  const { lastReviewedSha: sha, baseRef, git } = opts;

  if (!sha) {
    return { mode: 'full', reason: 'no-previous-review', lastReviewedSha: null, headSha: null };
  }

  const head = git(['rev-parse', 'HEAD']);
  const headSha = head.ok ? head.stdout.trim() : '';
  if (!SHA40.test(headSha)) {
    return { mode: 'full', reason: 'error', lastReviewedSha: sha, headSha: null };
  }

  if (headSha.toLowerCase() === sha.toLowerCase()) {
    return { mode: 'full', reason: 'no-new-commits', lastReviewedSha: sha, headSha };
  }

  if (!git(['cat-file', '-e', `${sha}^{commit}`]).ok) {
    return { mode: 'full', reason: 'unknown-sha', lastReviewedSha: sha, headSha };
  }

  if (!git(['merge-base', '--is-ancestor', sha, 'HEAD']).ok) {
    return { mode: 'full', reason: 'history-rewritten', lastReviewedSha: sha, headSha };
  }

  // Refnames cannot start with "-", so this also keeps the value safe as a
  // git argument.
  if (!baseRef || baseRef.startsWith('-')) {
    return { mode: 'full', reason: 'base-unresolved', lastReviewedSha: sha, headSha };
  }

  const mergeBaseAtLastReview = git(['merge-base', `origin/${baseRef}`, sha]);
  const mergeBaseNow = git(['merge-base', `origin/${baseRef}`, 'HEAD']);
  if (!mergeBaseAtLastReview.ok || !mergeBaseNow.ok) {
    return { mode: 'full', reason: 'base-unresolved', lastReviewedSha: sha, headSha };
  }
  if (mergeBaseAtLastReview.stdout.trim() !== mergeBaseNow.stdout.trim()) {
    return { mode: 'full', reason: 'base-merged-in', lastReviewedSha: sha, headSha };
  }

  return { mode: 'incremental', reason: 'ok', lastReviewedSha: sha, headSha };
}

/**
 * Collect every file path referenced by a unified diff. Paths are read from
 * the same path-bearing line types filter-diff handles: `--- a/`, `+++ b/`,
 * and rename lines (renames also record the old name so either side matches).
 */
export function listDiffFiles(diffContent: string): Set<string> {
  const files = new Set<string>();
  for (const line of diffContent.split('\n')) {
    if (line.startsWith('--- a/')) files.add(line.slice(6));
    else if (line.startsWith('+++ b/')) files.add(line.slice(6));
    else if (line.startsWith('rename from ')) files.add(line.slice(12));
    else if (line.startsWith('rename to ')) files.add(line.slice(10));
  }
  return files;
}

export interface RestrictResult {
  restricted: string;
  keptFiles: number;
  droppedFiles: string[];
}

/**
 * Keep only the diff sections whose file path appears in `allowed` (the full
 * PR diff's file set). Sections for net-zero files are dropped so inline
 * comments are never anchored outside the PR diff.
 */
export function restrictDiffToFiles(diffContent: string, allowed: Set<string>): RestrictResult {
  if (diffContent === '') {
    return { restricted: '', keptFiles: 0, droppedFiles: [] };
  }

  const lines = diffContent.split('\n');
  const outputLines: string[] = [];
  let sectionLines: string[] = [];
  let sectionFiles: string[] = [];
  let keptFiles = 0;
  const droppedFiles: string[] = [];

  const flushSection = (): void => {
    if (sectionLines.length === 0) return;
    if (sectionFiles.some((file) => allowed.has(file))) {
      for (const line of sectionLines) outputLines.push(line);
      keptFiles++;
    } else {
      droppedFiles.push(sectionFiles[0] ?? '(unknown)');
    }
    sectionLines = [];
    sectionFiles = [];
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flushSection();
      sectionLines.push(line);
    } else if (sectionLines.length > 0) {
      if (line.startsWith('--- a/')) sectionFiles.push(line.slice(6));
      else if (line.startsWith('+++ b/')) sectionFiles.push(line.slice(6));
      else if (line.startsWith('rename to ')) sectionFiles.push(line.slice(10));
      sectionLines.push(line);
    } else {
      // Content before the first diff section (e.g. preamble) — preserve.
      outputLines.push(line);
    }
  }
  flushSection();

  return { restricted: outputLines.join('\n'), keptFiles, droppedFiles };
}
