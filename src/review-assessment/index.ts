// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * review-assessment CLI entrypoint (bundled to dist/review-assessment.js and
 * staged at /tmp/review-assessment.js for the agent's posting command).
 *
 * Usage:
 *   node dist/review-assessment.js new-run-nonce
 *       Print a cryptographically random 32-hex per-run attribution nonce.
 *       Generated in a trusted action step, never from user input.
 *
 *   node dist/review-assessment.js finalize-body <bodyFile> <nonce> <commentsFile>
 *       Validate the agent-authored review body in <bodyFile> against the
 *       posting policy (exactly one recognized status line, no APPROVE/LGTM/
 *       "No issues found" wording, no 🟢 NO FINDINGS over findings sections)
 *       plus the staged inline comments in <commentsFile> — which must parse
 *       as a JSON array, empty for a 🟢 NO FINDINGS body — and mechanically
 *       append this run's hidden attribution marker. Writes the finalized
 *       body back to <bodyFile>. Nonzero exit refuses posting.
 *
 *   node dist/review-assessment.js classify-run <sha> <baselineId> <nonce>
 *       Read the PR's reviews JSON (array) from stdin and print the status of
 *       the review THIS run posted: completed | incomplete | inconclusive |
 *       none | unverified, one `status=<value>` line plus a
 *       `prior-incomplete-notice=<bool>` line for the fallback dedup guard.
 *       The reason is logged to stderr. Nonzero exit means the classification
 *       itself could not run (bad arguments or unparseable input) — callers
 *       must treat that as unverified.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  classifyRunReviews,
  finalizeReviewBody,
  isValidRunNonce,
  type PostedReviewLike,
} from './review-assessment.js';

export function newRunNonce(): string {
  return randomBytes(16).toString('hex');
}

function fail(message: string): never {
  console.error(`review-assessment: ${message}`);
  process.exit(1);
}

function requireNonce(nonce: string | undefined): string {
  if (!nonce || !isValidRunNonce(nonce)) {
    fail('nonce must be exactly 32 lowercase hex characters');
  }
  return nonce;
}

export function main(argv: string[]): void {
  const [command, ...args] = argv;

  if (command === 'new-run-nonce') {
    process.stdout.write(`${newRunNonce()}\n`);
    return;
  }

  if (command === 'finalize-body') {
    const [bodyFile, nonce, commentsFile] = args;
    if (!bodyFile) fail('finalize-body requires a body file path');
    const validNonce = requireNonce(nonce);
    if (!commentsFile) fail('finalize-body requires the staged review comments file path');
    let body: string;
    try {
      body = readFileSync(bodyFile, 'utf8');
    } catch {
      fail(`review body file ${bodyFile} is missing or unreadable`);
    }
    if (body.trim() === '') {
      fail(`review body file ${bodyFile} is empty — write the computed outcome first`);
    }
    let commentsRaw: string;
    try {
      commentsRaw = readFileSync(commentsFile, 'utf8');
    } catch {
      fail(`review comments file ${commentsFile} is missing or unreadable`);
    }
    let comments: unknown;
    try {
      comments = JSON.parse(commentsRaw);
    } catch {
      fail(`review comments file ${commentsFile} is not valid JSON`);
    }
    if (!Array.isArray(comments)) {
      fail(`review comments file ${commentsFile} must be a JSON array of inline comments`);
    }
    let finalized: string;
    try {
      finalized = finalizeReviewBody(body, validNonce, comments.length);
    } catch (error: unknown) {
      fail(error instanceof Error ? error.message : String(error));
    }
    writeFileSync(bodyFile, finalized);
    console.error(
      `review-assessment: body validated against ${comments.length} staged inline comment(s), run marker appended to ${bodyFile}`,
    );
    return;
  }

  if (command === 'classify-run') {
    const [sha, baseline, nonce] = args;
    if (!sha || !/^[0-9a-f]{40}$/i.test(sha)) fail('classify-run requires a 40-hex SHA');
    if (!baseline || !/^[0-9]+$/.test(baseline)) fail('classify-run requires a numeric baseline');
    const validNonce = requireNonce(nonce);
    let reviews: unknown;
    try {
      reviews = JSON.parse(readFileSync(0, 'utf8'));
    } catch {
      fail('stdin is not valid JSON');
    }
    if (!Array.isArray(reviews)) fail('stdin must be a JSON array of reviews');
    const classification = classifyRunReviews(reviews as PostedReviewLike[], {
      sha,
      baselineId: Number.parseInt(baseline, 10),
      nonce: validNonce,
    });
    console.error(`review-assessment: ${classification.reason}`);
    process.stdout.write(`status=${classification.status}\n`);
    process.stdout.write(`prior-incomplete-notice=${classification.priorIncompleteNotice}\n`);
    return;
  }

  fail(`unknown command ${JSON.stringify(command ?? '')}`);
}

if (process.argv[1]?.endsWith('review-assessment.js') && !process.env.VITEST) {
  main(process.argv.slice(2));
}
