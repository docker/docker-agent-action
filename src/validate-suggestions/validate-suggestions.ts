// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * validate-suggestions — sanitize GitHub `suggestion` blocks in PR review
 * comments before they are posted.
 *
 * GitHub is strict about the lines a suggestion can attach to: a `gh api
 * .../pulls/{pr}/reviews` call rejects the ENTIRE review (HTTP 422) if any one
 * inline comment carries a suggestion whose anchor is invalid. A single bad
 * suggestion therefore loses the whole review. This module catches those cases
 * up front and neutralizes them so the rest of the review still posts.
 *
 * A suggestion block is the fenced code block GitHub renders as one-click
 * applicable replacement code:
 *
 *   ```suggestion
 *   the exact replacement for the anchored line range
 *   ```
 *
 * The anchor is the comment's `line` (single-line) or `start_line`..`line`
 * (multi-line). For GitHub to accept a suggestion the anchor must:
 *   1. be on the RIGHT side of the diff — suggestions produce new content, so
 *      they cannot attach to a deleted (`side: "LEFT"`) line;
 *   2. cover only lines that actually exist on the right side of the diff
 *      (added `+` or context ` ` lines within a hunk);
 *   3. for a multi-line range, satisfy `start_line < line` with every line in
 *      between addressable — which also forces the range to stay inside a single
 *      hunk (line numbers are contiguous within a hunk and jump between hunks);
 *   4. use a properly closed fence.
 *
 * When a comment's suggestion(s) fail these rules the block is stripped from the
 * body (the prose finding is kept) and any suggestion-only multi-line range is
 * reverted to a single-line anchor, leaving a comment GitHub will accept.
 *
 * Validation is scoped to comments that contain a suggestion block. The line
 * correctness of a plain (suggestion-free) comment is the orchestrator's
 * existing "Verify Line Numbers" responsibility and is left untouched here.
 *
 * Pure functions — no filesystem access. See index.ts for the CLI wrapper.
 */

/** Marker appended to every bot review comment body. */
export const REVIEW_MARKER = '<!-- docker-agent-review -->';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** An inline review comment object, as built for the `comments` array. */
export interface ReviewComment {
  path: string;
  line: number;
  side?: string;
  start_line?: number;
  start_side?: string;
  body: string;
  // Preserve any other fields the orchestrator may add (round-trip safe).
  [key: string]: unknown;
}

/** A single malformed suggestion the sanitizer fixed, for logging. */
export interface SuggestionIssue {
  path: string;
  line: number;
  reason: string;
}

export interface SanitizeResult {
  /** Comments with malformed suggestion blocks stripped. Same length/order. */
  comments: ReviewComment[];
  /** One entry per comment whose suggestion(s) were removed. */
  issues: SuggestionIssue[];
  /** Count of valid suggestion blocks left in place. */
  suggestionsKept: number;
  /** Count of suggestion blocks removed. */
  suggestionsStripped: number;
}

/** A fenced suggestion block located within a body, by 0-based line index. */
interface SuggestionBlock {
  /** Index of the ```suggestion opener line. */
  start: number;
  /** Index of the closing ``` line, or the last body line when unclosed. */
  end: number;
  /** Whether a matching closing fence was found. */
  closed: boolean;
}

// ---------------------------------------------------------------------------
// Diff parsing
// ---------------------------------------------------------------------------

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Map each file path to the set of new-file (right-side) line numbers that a
 * comment or suggestion can legally anchor to: added (`+`) and context (` `)
 * lines within hunks. Deleted (`-`) lines are left-side only and excluded.
 *
 * Mirrors the awk diff walk in review-pr/action.yml (stale-thread resolution),
 * extended to also record context lines because GitHub accepts suggestions on
 * them.
 */
export function parseAddressableLines(diff: string): Map<string, Set<number>> {
  const byPath = new Map<string, Set<number>>();
  let currentPath = '';
  let lineNo = 0;

  for (const raw of diff.split('\n')) {
    // New-file header: "+++ b/<path>" identifies the right-side file. git
    // delimits paths that need it — a trailing TAB for names with a space, and
    // C-style quoting for non-ASCII/special bytes — so the path is decoded back
    // to match the clean comment.path from `gh pr view --json files`.
    if (raw.startsWith('+++ ')) {
      currentPath = parseHeaderPath(raw);
      continue;
    }
    // Old-file header — ignore (does not affect right-side numbering).
    if (raw.startsWith('--- ')) continue;

    const hunk = HUNK_HEADER.exec(raw);
    if (hunk) {
      lineNo = parseInt(hunk[1], 10);
      continue;
    }

    if (!currentPath || lineNo === 0) continue;

    if (raw.startsWith('+')) {
      // Added line (the "+++ " header was handled above).
      record(byPath, currentPath, lineNo);
      lineNo++;
    } else if (raw.startsWith(' ')) {
      // Context line — present on the right side, so addressable.
      record(byPath, currentPath, lineNo);
      lineNo++;
    } else if (raw.startsWith('-')) {
      // Deleted line — left side only; does not advance the right-side counter.
    }
    // Anything else ("\ No newline…", blank split artifacts) is skipped without
    // advancing the counter, matching the action.yml awk behavior.
  }

  return byPath;
}

function record(byPath: Map<string, Set<number>>, path: string, line: number): void {
  let set = byPath.get(path);
  if (!set) {
    set = new Set<number>();
    byPath.set(path, set);
  }
  set.add(line);
}

/**
 * Extract the right-side path from a unified-diff "+++ " header line, undoing
 * git's path delimiting so the key matches the clean comment.path.
 *
 * git delimits paths that need it in two ways:
 *   - a TRAILING TAB after the name for paths with a space: `+++ b/my file.ts\t`
 *   - C-style quoting for non-ASCII/special bytes:          `+++ "b/caf\303\251.ts"`
 * Both `gh pr diff` and the `git diff` fallback emit these, while the comment's
 * path (from `gh pr view --json files`) is the decoded UTF-8 string. Returns ''
 * for a header that names no right-side file (e.g. `+++ /dev/null`).
 */
function parseHeaderPath(raw: string): string {
  let rest = raw.slice('+++ '.length);
  if (rest.startsWith('"')) {
    rest = decodeCQuotedPath(rest);
  } else {
    // Unquoted: git appends a TAB separator only when the name contains a space.
    const tab = rest.indexOf('\t');
    if (tab !== -1) rest = rest.slice(0, tab);
  }
  return rest.startsWith('b/') ? rest.slice('b/'.length) : '';
}

const C_ESCAPES: Record<string, number> = {
  a: 0x07,
  b: 0x08,
  t: 0x09,
  n: 0x0a,
  v: 0x0b,
  f: 0x0c,
  r: 0x0d,
  '"': 0x22,
  '\\': 0x5c,
};

/**
 * Decode a git C-quoted header value (starting at the opening quote) into a
 * UTF-8 string. git escapes each byte of a multi-byte UTF-8 sequence as its own
 * `\NNN` octal escape, so bytes are collected and decoded together.
 */
function decodeCQuotedPath(quoted: string): string {
  const close = quoted.lastIndexOf('"');
  const s = close > 0 ? quoted.slice(1, close) : quoted.slice(1);
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\') {
      bytes.push(s.charCodeAt(i) & 0xff);
      continue;
    }
    const next = s[i + 1];
    if (next >= '0' && next <= '7') {
      let oct = '';
      while (i + 1 < s.length && oct.length < 3 && s[i + 1] >= '0' && s[i + 1] <= '7') {
        oct += s[++i];
      }
      bytes.push(parseInt(oct, 8) & 0xff);
    } else if (next !== undefined) {
      bytes.push(C_ESCAPES[next] ?? next.charCodeAt(0) & 0xff);
      i++;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

// ---------------------------------------------------------------------------
// Suggestion block parsing
// ---------------------------------------------------------------------------

// Opening fence: three or more backticks immediately followed by the
// `suggestion` info string (optional surrounding whitespace), matching what
// GitHub recognizes as an applicable suggestion. The backtick run is captured
// so the closer can be required to be at least as long.
const SUGGESTION_OPEN = /^\s*(`{3,})\s*suggestion\s*$/i;
// Any closing code fence: three or more backticks alone on the line. The
// backtick run is captured to compare its length against the opener.
const FENCE_CLOSE = /^\s*(`{3,})\s*$/;

/**
 * Locate every suggestion block in `body` (split into `lines`). An opener with
 * no matching closing fence is reported as `closed: false` spanning to the end
 * of the body.
 */
export function findSuggestionBlocks(lines: string[]): SuggestionBlock[] {
  const blocks: SuggestionBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = SUGGESTION_OPEN.exec(lines[i]);
    if (!open) continue;
    const openLen = open[1].length;
    let close = -1;
    for (let j = i + 1; j < lines.length; j++) {
      // A second opener before any closer means this block was never closed; an
      // unclosed fence runs to the end, so stop here rather than mistaking the
      // later block's closer for this one's.
      if (SUGGESTION_OPEN.test(lines[j])) break;
      const fence = FENCE_CLOSE.exec(lines[j]);
      // CommonMark/GitHub require the closing fence to be at least as long as
      // the opener, so a shorter inner fence does not close a longer block.
      if (fence && fence[1].length >= openLen) {
        close = j;
        break;
      }
    }
    if (close === -1) {
      blocks.push({ start: i, end: lines.length - 1, closed: false });
      break; // unclosed fence swallows the remainder; nothing left to scan
    }
    blocks.push({ start: i, end: close, closed: true });
    i = close; // continue scanning after the closing fence
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Anchor validation
// ---------------------------------------------------------------------------

interface AnchorVerdict {
  valid: boolean;
  reason?: string;
}

/**
 * Decide whether `comment`'s anchor is a place GitHub will accept a suggestion.
 */
export function validateAnchor(
  comment: ReviewComment,
  addressable: Map<string, Set<number>>,
): AnchorVerdict {
  const side = comment.side ?? 'RIGHT';
  if (side === 'LEFT') {
    return {
      valid: false,
      reason: 'suggestion on a deleted (LEFT) line; suggestions apply to the right side only',
    };
  }

  const lines = addressable.get(comment.path);
  if (!lines || lines.size === 0) {
    return { valid: false, reason: `no addressable diff lines for ${comment.path}` };
  }

  const end = comment.line;
  const start = comment.start_line ?? comment.line;

  // Fail closed on a missing/non-numeric anchor: otherwise an undefined `line`
  // makes the membership loop below a no-op and the suggestion is wrongly kept,
  // 422-ing the whole review.
  if (!Number.isInteger(end)) {
    return {
      valid: false,
      reason: `comment line anchor is not a valid integer (got ${String(end)})`,
    };
  }

  if (comment.start_line !== undefined) {
    if (!Number.isInteger(start)) {
      return {
        valid: false,
        reason: `comment start_line is not a valid integer (got ${String(start)})`,
      };
    }
    if ((comment.start_side ?? 'RIGHT') === 'LEFT') {
      return { valid: false, reason: 'multi-line suggestion with start_side LEFT' };
    }
    if (!(start < end)) {
      return {
        valid: false,
        reason: `invalid multi-line range: start_line (${start}) must be < line (${end})`,
      };
    }
  }

  for (let n = start; n <= end; n++) {
    if (!lines.has(n)) {
      return {
        valid: false,
        reason: `line ${n} is not an added/context line in the diff for ${comment.path} (range ${start}-${end})`,
      };
    }
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Body rewriting
// ---------------------------------------------------------------------------

/**
 * Remove the given block line-ranges from `lines`, then tidy whitespace and
 * guarantee the review marker survives (an unclosed block can swallow it).
 */
function stripBlocks(lines: string[], blocks: SuggestionBlock[]): string {
  const drop = new Array(lines.length).fill(false);
  for (const b of blocks) {
    for (let i = b.start; i <= b.end; i++) drop[i] = true;
  }
  const kept = lines.filter((_, i) => !drop[i]);

  // Collapse runs of blank lines and trim leading/trailing blanks.
  const tidy: string[] = [];
  for (const line of kept) {
    const blank = line.trim() === '';
    if (blank && (tidy.length === 0 || tidy[tidy.length - 1].trim() === '')) continue;
    tidy.push(line);
  }
  while (tidy.length > 0 && tidy[tidy.length - 1].trim() === '') tidy.pop();

  const hadMarker = lines.some((l) => l.includes(REVIEW_MARKER));
  const stillHasMarker = tidy.some((l) => l.includes(REVIEW_MARKER));
  if (hadMarker && !stillHasMarker) {
    tidy.push('', REVIEW_MARKER);
  }

  return tidy.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate and sanitize the suggestion blocks across a list of review comments.
 *
 * Comments without a suggestion block are returned unchanged. For a comment
 * that does carry suggestions:
 *   - if the anchor is invalid (wrong side / out-of-range / bad multi-line
 *     range), every suggestion block is stripped and any suggestion-only
 *     multi-line range is reverted to a single-line anchor;
 *   - otherwise, well-formed closed blocks are kept and only unclosed blocks
 *     are stripped.
 */
export function sanitizeComments(comments: ReviewComment[], diff: string): SanitizeResult {
  const addressable = parseAddressableLines(diff);
  const issues: SuggestionIssue[] = [];
  let suggestionsKept = 0;
  let suggestionsStripped = 0;

  const out = comments.map((comment) => {
    const bodyLines = (comment.body ?? '').split('\n');
    const blocks = findSuggestionBlocks(bodyLines);
    if (blocks.length === 0) return comment;

    const anchor = validateAnchor(comment, addressable);

    if (!anchor.valid) {
      // Every block shares this comment's anchor — drop them all.
      suggestionsStripped += blocks.length;
      issues.push({
        path: comment.path,
        line: comment.line,
        reason: anchor.reason ?? 'invalid anchor',
      });
      const sanitized: ReviewComment = { ...comment, body: stripBlocks(bodyLines, blocks) };
      // A multi-line range only existed to carry the suggestion; revert it so the
      // leftover prose comment is a valid single-line comment.
      delete sanitized.start_line;
      delete sanitized.start_side;
      return sanitized;
    }

    // Anchor is valid: keep closed blocks, strip only unclosed (malformed) ones.
    const unclosed = blocks.filter((b) => !b.closed);
    suggestionsKept += blocks.length - unclosed.length;
    if (unclosed.length === 0) return comment;

    suggestionsStripped += unclosed.length;
    issues.push({ path: comment.path, line: comment.line, reason: 'unclosed ```suggestion fence' });
    return { ...comment, body: stripBlocks(bodyLines, unclosed) };
  });

  return { comments: out, issues, suggestionsKept, suggestionsStripped };
}
