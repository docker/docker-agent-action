// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for src/main/artifact.ts
 *
 * Tests makeArtifactName (pure) and uploadVerboseLog (mocked DefaultArtifactClient).
 * Uses real temp files to avoid mocking node:fs.
 */

import * as fsSync from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@actions/core');

// ── Mock @actions/artifact ────────────────────────────────────────────────────

const { mockUploadArtifact, MockDefaultArtifactClient } = vi.hoisted(() => {
  const mockUploadArtifact = vi.fn().mockResolvedValue({ id: 42 });
  class MockDefaultArtifactClient {
    uploadArtifact = mockUploadArtifact;
  }
  return { mockUploadArtifact, MockDefaultArtifactClient };
});

vi.mock('@actions/artifact', () => ({
  DefaultArtifactClient: MockDefaultArtifactClient,
}));

import { makeArtifactName, uploadVerboseLog } from '../artifact.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'artifact-test-'));
  vi.clearAllMocks();
  mockUploadArtifact.mockResolvedValue({ id: 42 });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── makeArtifactName ─────────────────────────────────────────────────────────

describe('makeArtifactName', () => {
  it('builds the expected name from all components', () => {
    const name = makeArtifactName('12345', '2', 'build', '/tmp/verbose-abc.log');
    expect(name).toBe('docker-agent-verbose-log-12345-2-build-verbose-abc.log');
  });

  it('uses only the basename of the log file path', () => {
    const name = makeArtifactName('1', '1', 'test', '/some/deep/path/to/logfile.txt');
    expect(name).toBe('docker-agent-verbose-log-1-1-test-logfile.txt');
  });

  it('handles job names with hyphens', () => {
    const name = makeArtifactName('99', '3', 'pr-review', '/tmp/verbose.log');
    expect(name).toBe('docker-agent-verbose-log-99-3-pr-review-verbose.log');
  });
});

// ── uploadVerboseLog ─────────────────────────────────────────────────────────

describe('uploadVerboseLog', () => {
  it('uploads a real file successfully', async () => {
    const filePath = join(tmpDir, 'verbose.log');
    await writeFile(filePath, 'Agent output content', 'utf-8');

    await uploadVerboseLog({ name: 'test-artifact', filePath, retentionDays: 7 });

    expect(mockUploadArtifact).toHaveBeenCalledOnce();
    expect(mockUploadArtifact).toHaveBeenCalledWith(
      'test-artifact',
      [filePath],
      tmpDir, // rootDir = dirname(filePath)
      { retentionDays: 7 },
    );
  });

  it('uses default retentionDays=14 when not specified', async () => {
    const filePath = join(tmpDir, 'verbose.log');
    await writeFile(filePath, 'content', 'utf-8');

    await uploadVerboseLog({ name: 'test-artifact', filePath });

    expect(mockUploadArtifact).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.any(String),
      { retentionDays: 14 },
    );
  });

  it('warns and skips when file does not exist', async () => {
    const { warning } = await import('@actions/core');
    const filePath = join(tmpDir, 'nonexistent.log');

    await uploadVerboseLog({ name: 'test-artifact', filePath });

    expect(mockUploadArtifact).not.toHaveBeenCalled();
    expect(vi.mocked(warning)).toHaveBeenCalledWith(expect.stringContaining('not found'));
  });

  it('warns and skips when path is a directory', async () => {
    const { warning } = await import('@actions/core');
    const dirPath = join(tmpDir, 'subdir');
    fsSync.mkdirSync(dirPath);

    await uploadVerboseLog({ name: 'test-artifact', filePath: dirPath });

    expect(mockUploadArtifact).not.toHaveBeenCalled();
    expect(vi.mocked(warning)).toHaveBeenCalledWith(expect.stringContaining('not a file'));
  });

  it('warns but does not throw when upload fails', async () => {
    const { warning } = await import('@actions/core');
    const filePath = join(tmpDir, 'verbose.log');
    await writeFile(filePath, 'content', 'utf-8');

    mockUploadArtifact.mockRejectedValue(new Error('Network timeout'));

    await expect(uploadVerboseLog({ name: 'test-artifact', filePath })).resolves.toBeUndefined();
    expect(vi.mocked(warning)).toHaveBeenCalledWith(expect.stringContaining('Network timeout'));
  });
});
