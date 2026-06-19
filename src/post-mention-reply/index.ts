// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * post-mention-reply CLI entrypoint.
 *
 * Posts the agent reply to a @docker-agent mention in a GitHub PR comment.
 * Replaces the bash "Post reply" step in review-pr/mention-reply/action.yml.
 *
 * All inputs via environment variables:
 *   OUTPUT_FILE      — path to agent output file
 *   OWNER            — repository owner
 *   REPO             — repository name
 *   PR_NUMBER        — pull request number (string)
 *   IS_INLINE        — 'true' | 'false'
 *   IN_REPLY_TO_ID   — comment ID string (may be empty when IS_INLINE=false)
 *   GH_TOKEN / GITHUB_TOKEN — GitHub token
 *   SECRETS_DETECTED — 'true' if the security gate tripped
 */
import { existsSync, readFileSync } from 'node:fs';
import { Octokit } from '@octokit/rest';

export const MARKER = '<!-- docker-agent-review-reply -->';

export interface PostMentionReplyConfig {
  secretsDetected: string;
  outputFile: string;
  owner: string;
  repo: string;
  prNumber: string;
  isInline: boolean;
  inReplyToId: string;
  token: string;
}

function log(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

export function readConfig(): PostMentionReplyConfig {
  return {
    secretsDetected: process.env.SECRETS_DETECTED ?? '',
    outputFile: process.env.OUTPUT_FILE ?? '',
    owner: process.env.OWNER ?? '',
    repo: process.env.REPO ?? '',
    prNumber: process.env.PR_NUMBER ?? '',
    isInline: process.env.IS_INLINE === 'true',
    inReplyToId: process.env.IN_REPLY_TO_ID ?? '',
    token: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? '',
  };
}

export async function run(config: PostMentionReplyConfig): Promise<void> {
  const { secretsDetected, outputFile, owner, repo, prNumber, isInline, inReplyToId, token } =
    config;

  // Guard 1: security gate
  if (secretsDetected === 'true') {
    log('⏭️ Secrets detected — skipping post reply');
    return;
  }

  // Guard 2: output file must exist
  if (!outputFile || !existsSync(outputFile)) {
    log('⏭️ No output file — skipping post reply');
    return;
  }

  // Guard 3: output file must contain the reply marker
  const fileContent = readFileSync(outputFile, 'utf-8');
  if (!fileContent.includes(MARKER)) {
    log('⏭️ Output file does not contain <!-- docker-agent-review-reply --> marker — skipping');
    return;
  }

  // Guard 4: routing vars must be set
  if (!owner || !repo || !prNumber) {
    log('⏭️ Missing routing variables (OWNER, REPO, or PR_NUMBER) — skipping');
    return;
  }

  // Guard 5: inline reply requires IN_REPLY_TO_ID
  if (isInline && !inReplyToId) {
    log('⏭️ IS_INLINE=true but IN_REPLY_TO_ID is empty — skipping');
    return;
  }

  // Guard 6: inline reply ID must be a valid positive integer
  const inReplyToIdNum = parseInt(inReplyToId, 10);
  if (isInline && (!Number.isFinite(inReplyToIdNum) || inReplyToIdNum <= 0)) {
    log('⏭️ IN_REPLY_TO_ID is not a valid numeric ID — skipping');
    return;
  }

  // Extract body: everything up to and including the marker line
  const lines = fileContent.split('\n');
  const markerIndex = lines.findIndex((line) => line.includes(MARKER));
  const body = lines.slice(0, markerIndex + 1).join('\n');

  const octokit = new Octokit({ auth: token });
  const prNum = parseInt(prNumber, 10);

  // Guard 7: dedup check (inline only — top-level has no dedup, see C1).
  // Workflow-level concurrency lock and should-reply guards prevent double-posting
  // for top-level mentions; only inline threads need per-thread deduplication.
  if (isInline) {
    let isDuplicate = false;
    try {
      const allComments = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
        owner,
        repo,
        pull_number: prNum,
        per_page: 100,
      });
      isDuplicate = allComments.some(
        (c) => c.in_reply_to_id === inReplyToIdNum && (c.body ?? '').includes(MARKER),
      );
    } catch (err) {
      log(
        `⚠️ Dedup check failed (${err instanceof Error ? err.message : String(err)}) — posting anyway`,
      );
    }
    if (isDuplicate) {
      log('⏭️ Reply already posted — skipping');
      return;
    }
  }

  // Post the reply
  if (isInline) {
    await octokit.rest.pulls.createReplyForReviewComment({
      owner,
      repo,
      pull_number: prNum,
      comment_id: inReplyToIdNum,
      body,
    });
    log('✅ Posted inline reply');
  } else {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNum,
      body,
    });
    log('✅ Posted top-level reply');
  }
}

if (!process.env.VITEST) {
  run(readConfig()).catch((err: unknown) => {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
