// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'tsup';

let cliPromise: Promise<string> | null = null;

/**
 * Bundle the review-assessment CLI the same way `pnpm build` does
 * (tsup/esbuild, ESM, self-contained) so shell harnesses can execute the
 * exact runtime artifact with plain `node`. Built once per test process into
 * a throwaway directory; the module has no npm dependencies, so the build is
 * fast and needs no banner/define plumbing from the main tsup config.
 */
export function builtReviewAssessmentCli(): Promise<string> {
  cliPromise ??= (async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'review-assessment-dist-'));
    await build({
      config: false,
      entry: { 'review-assessment': resolve(import.meta.dirname, '../index.ts') },
      format: ['esm'],
      platform: 'node',
      target: 'node24',
      outDir,
      outExtension: () => ({ js: '.js' }),
      sourcemap: false,
      clean: false,
      splitting: false,
      silent: true,
    });
    const cli = join(outDir, 'review-assessment.js');
    if (!existsSync(cli)) throw new Error('review-assessment CLI build produced no output');
    return cli;
  })();
  return cliPromise;
}
