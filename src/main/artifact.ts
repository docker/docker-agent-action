// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * artifact.ts — upload verbose agent log as a GitHub Actions artifact.
 *
 * Ports the `Upload verbose agent log` step from the original composite action.yml.
 * Uses @actions/artifact (v6+) DefaultArtifactClient API.
 */

import * as path from 'node:path';
import { DefaultArtifactClient } from '@actions/artifact';
import * as core from '@actions/core';

export interface UploadArtifactOptions {
  /** Artifact name (e.g. "docker-agent-verbose-log-..."). */
  name: string;
  /** Absolute path to the file to upload. */
  filePath: string;
  /** Retention in days (default: 14). */
  retentionDays?: number;
}

/**
 * Compute the verbose log artifact name using the same template as the original
 * composite action:
 *   docker-agent-verbose-log-{runId}-{runAttempt}-{job}-{basename}
 */
export function makeArtifactName(
  runId: string,
  runAttempt: string,
  job: string,
  verboseLogFile: string,
): string {
  const basename = path.basename(verboseLogFile);
  return `docker-agent-verbose-log-${runId}-${runAttempt}-${job}-${basename}`;
}

/**
 * Upload the verbose log file as an artifact.
 * Safe to call even if the file doesn't exist — will warn and skip.
 *
 * Note: @actions/artifact v6 uploads files relative to a rootDirectory.
 * We use the file's parent directory as rootDir so the artifact contains
 * just the file (no extra path prefix).
 */
export async function uploadVerboseLog(opts: UploadArtifactOptions): Promise<void> {
  const { name, filePath, retentionDays = 14 } = opts;

  // Check file existence — mirrors `if-no-files-found: ignore`
  try {
    const stat = await import('node:fs').then((m) => m.promises.stat(filePath));
    if (!stat.isFile()) {
      core.warning(`Verbose log path is not a file, skipping artifact upload: ${filePath}`);
      return;
    }
  } catch {
    core.warning(`Verbose log file not found, skipping artifact upload: ${filePath}`);
    return;
  }

  const rootDir = path.dirname(filePath);
  const client = new DefaultArtifactClient();

  try {
    core.info(`Uploading verbose log artifact: ${name}`);
    const result = await client.uploadArtifact(name, [filePath], rootDir, {
      retentionDays,
    });
    core.info(`✅ Artifact uploaded: ${result.id}`);
  } catch (err: unknown) {
    // Non-fatal — don't fail the run if artifact upload fails
    core.warning(`Failed to upload verbose log artifact: ${(err as Error).message}`);
  }
}
