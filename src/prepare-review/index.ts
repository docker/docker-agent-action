// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

import * as core from '@actions/core';
import { prepareReview } from './prepare-review.js';

export async function main(): Promise<void> {
  const prepared = await prepareReview({
    repository: process.env.GITHUB_REPOSITORY ?? '',
    pullNumber: process.env.PR_NUMBER ?? '',
    githubToken: process.env.GITHUB_TOKEN ?? '',
    workspace: process.env.GITHUB_WORKSPACE ?? process.cwd(),
    headSha: process.env.PR_HEAD_SHA || undefined,
    baseSha: process.env.PR_BASE_SHA || undefined,
  });
  for (const [name, value] of Object.entries({
    'head-sha': prepared.headSha,
    'base-sha': prepared.baseSha,
    'changed-files': String(prepared.changedFiles),
  }))
    core.setOutput(name, value);
}

if (process.argv[1]?.endsWith('prepare-review.js') && !process.env.VITEST) {
  main().catch((error: unknown) =>
    core.setFailed(error instanceof Error ? error.message : String(error)),
  );
}
