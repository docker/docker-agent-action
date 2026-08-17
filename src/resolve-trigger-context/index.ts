// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as core from '@actions/core';
import {
  type CanonicalTriggerContext,
  resolveTriggerContext,
  triggerRoute,
} from './resolve-trigger-context.js';

export function resolverOutputs(context: CanonicalTriggerContext): Record<string, string> {
  const comment = context.comment;
  return {
    'event-name': context.event,
    'pr-number': String(context.pullRequest.number),
    'pr-head-sha': context.pullRequest.headSha,
    'pr-base-sha': context.pullRequest.baseSha,
    'trigger-route': triggerRoute(context),
    // Preserve the legacy workflow-run mention gate until its canonical route
    // replacement lands; both values derive exclusively from live context.
    'comment-has-mention': String(comment?.body.includes('@docker-agent') ?? false),
    'comment-is-review-cmd': String(comment?.body.startsWith('/review') ?? false),
    'comment-author': comment?.author ?? '',
    'comment-author-type': comment?.authorType ?? '',
    'comment-in-reply-to-id':
      comment?.inReplyToId && comment.inReplyToId > 0 ? String(comment.inReplyToId) : '',
  };
}

export function writeCanonicalContextFile(
  directory: string,
  context: CanonicalTriggerContext,
): string {
  const outputPath = join(directory, 'canonical-trigger-context.json');
  writeFileSync(outputPath, `${JSON.stringify(context)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  chmodSync(outputPath, 0o600);
  return outputPath;
}

export function writeCanonicalContext(
  context: CanonicalTriggerContext,
  runnerTemp: string,
): string {
  if (!runnerTemp) throw new Error('RUNNER_TEMP is not set');

  const directory = mkdtempSync(join(runnerTemp, 'docker-agent-trigger-context-'));
  chmodSync(directory, 0o700);
  return writeCanonicalContextFile(directory, context);
}

export async function main(): Promise<void> {
  const triggerRunId = process.env.TRIGGER_RUN_ID ?? '';
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  const repoToken = process.env.GITHUB_APP_TOKEN ?? process.env.GITHUB_TOKEN ?? '';
  const artifactDirectory = process.env.TRIGGER_ARTIFACT_DIRECTORY ?? '';
  const runnerTemp = process.env.RUNNER_TEMP ?? '';

  if (!repoToken) throw new Error('GITHUB_APP_TOKEN is not set');
  if (!artifactDirectory) throw new Error('TRIGGER_ARTIFACT_DIRECTORY is not set');
  const context = await resolveTriggerContext({
    triggerRunId,
    repository,
    repoToken,
    artifactDirectory,
  });
  const outputPath = writeCanonicalContext(context, runnerTemp);

  for (const [name, value] of Object.entries({
    ...resolverOutputs(context),
    'canonical-context-path': outputPath,
  })) {
    core.setOutput(name, value);
  }
}

if (process.argv[1]?.endsWith('resolve-trigger-context.js') && !process.env.VITEST) {
  main().catch((error: unknown) => {
    core.setFailed(
      `Failed to resolve trusted trigger context: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}
