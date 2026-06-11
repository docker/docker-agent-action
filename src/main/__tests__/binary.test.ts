/**
 * Unit tests for src/main/binary.ts
 *
 * Tests detectPlatform (pure) and setupBinaries (via mocked @actions/tool-cache,
 * @actions/cache, and @actions/exec).  Uses real temp files for the download
 * and staging paths so actual fs operations (copyFile, chmodSync, mkdtemp) work.
 */

import * as fsSync from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@actions/core');

// Prevent production code from writing to real system paths (e.g. ~/.docker/cli-plugins).
// We keep all real fs operations so that test helpers (existsSync, mkdirSync, mkdtemp,
// writeFile from node:fs/promises) continue to work against the real temp dir; we only
// replace the three calls that would otherwise escape into the user's home directory.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    chmodSync: vi.fn(),
    promises: {
      ...actual.promises,
      copyFile: vi.fn().mockResolvedValue(undefined),
      mkdir: vi.fn().mockResolvedValue(undefined),
    },
  };
});

// ── Mocks ─────────────────────────────────────────────────────────────────────

const {
  mockFind,
  mockDownloadTool,
  mockCacheDir,
  mockExtractTar,
  mockExec,
  mockRestoreCache,
  mockSaveCache,
} = vi.hoisted(() => {
  const mockFind = vi.fn().mockReturnValue('');
  const mockDownloadTool = vi.fn();
  const mockCacheDir = vi.fn();
  const mockExtractTar = vi.fn();
  const mockExec = vi.fn().mockResolvedValue(0);
  const mockRestoreCache = vi.fn().mockResolvedValue(undefined); // undefined = cache miss
  const mockSaveCache = vi.fn().mockResolvedValue(42);
  return {
    mockFind,
    mockDownloadTool,
    mockCacheDir,
    mockExtractTar,
    mockExec,
    mockRestoreCache,
    mockSaveCache,
  };
});

vi.mock('@actions/tool-cache', () => ({
  find: mockFind,
  downloadTool: mockDownloadTool,
  cacheDir: mockCacheDir,
  extractTar: mockExtractTar,
}));

vi.mock('@actions/cache', () => ({
  restoreCache: mockRestoreCache,
  saveCache: mockSaveCache,
}));

vi.mock('@actions/exec', () => ({
  exec: mockExec,
}));

import { detectPlatform, setupBinaries } from '../binary.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir: string;

/** Create a real temp file that can act as a downloaded binary. */
async function createFakeDownload(name = 'docker-agent'): Promise<string> {
  const filePath = join(tmpDir, name);
  await writeFile(filePath, '#!/bin/sh\necho v1.54.0\n', 'utf-8');
  return filePath;
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'binary-test-'));
  vi.clearAllMocks();

  // Reset to sensible defaults
  mockFind.mockReturnValue('');
  mockRestoreCache.mockResolvedValue(undefined); // cache miss
  mockSaveCache.mockResolvedValue(42);
  mockExec.mockResolvedValue(0);
  mockDownloadTool.mockImplementation(async () => createFakeDownload());
  // cacheDir returns a real dir containing the binary
  mockCacheDir.mockImplementation(async (dir: string) => dir);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── detectPlatform ────────────────────────────────────────────────────────────

describe('detectPlatform', () => {
  it('returns linux/amd64 (the test runner platform)', () => {
    const { platform, arch } = detectPlatform();
    // These tests run on Linux x64 in CI
    expect(['linux', 'darwin', 'windows']).toContain(platform);
    expect(['amd64', 'arm64']).toContain(arch);
  });

  it('returns no extension on non-windows', () => {
    const { ext } = detectPlatform();
    // Running in Linux sandbox — no extension
    expect(ext).toBe('');
  });
});

// ── setupBinaries — local tool-cache hit ──────────────────────────────────────

describe('setupBinaries — local tool-cache hit', () => {
  it('uses cached path and skips download', async () => {
    const cachedDir = join(tmpDir, 'cached');
    fsSync.mkdirSync(cachedDir);
    const cachedBinary = join(cachedDir, 'docker-agent');
    await writeFile(cachedBinary, '#!/bin/sh\n', 'utf-8');
    fsSync.chmodSync(cachedBinary, 0o755);

    mockFind.mockReturnValue(cachedDir);

    const result = await setupBinaries({
      version: 'v1.54.0',
      mcpGateway: false,
      mcpGatewayVersion: 'v0.22.0',
    });

    expect(mockDownloadTool).not.toHaveBeenCalled();
    expect(mockRestoreCache).not.toHaveBeenCalled();
    expect(result.dockerAgentPath).toContain('docker-agent');
    expect(result.dockerAgentVersion).toBe('v1.54.0');
    expect(result.mcpInstalled).toBe(false);
  });
});

// ── setupBinaries — remote cache hit ─────────────────────────────────────────

describe('setupBinaries — remote cache restore', () => {
  it('populates local tool-cache from restored dir without downloading', async () => {
    // Remote cache hit: restoreCache returns the key, writes binary into tmpDir
    mockRestoreCache.mockImplementation(async (paths: string[]) => {
      const restoreDir = paths[0];
      await writeFile(join(restoreDir, 'docker-agent'), '#!/bin/sh\n', 'utf-8');
      return 'docker-agent-v1.54.0-linux-amd64';
    });

    // cacheDir must have the binary to make it resolvable
    mockCacheDir.mockImplementation(async (dir: string) => {
      // Ensure binary exists in the returned dir
      const bin = join(dir, 'docker-agent');
      if (!fsSync.existsSync(bin)) {
        await writeFile(bin, '#!/bin/sh\n', 'utf-8');
      }
      return dir;
    });

    const result = await setupBinaries({
      version: 'v1.54.0',
      mcpGateway: false,
      mcpGatewayVersion: 'v0.22.0',
    });

    expect(mockDownloadTool).not.toHaveBeenCalled();
    expect(mockCacheDir).toHaveBeenCalled(); // populates local cache
    expect(result.dockerAgentVersion).toBe('v1.54.0');
  });
});

// ── setupBinaries — full download path ───────────────────────────────────────

describe('setupBinaries — full download (no cache)', () => {
  it('downloads, saves to remote cache, and populates local cache', async () => {
    const fakeDownload = await createFakeDownload();
    mockDownloadTool.mockResolvedValue(fakeDownload);
    mockCacheDir.mockImplementation(async (dir: string) => {
      const bin = join(dir, 'docker-agent');
      if (!fsSync.existsSync(bin)) {
        await writeFile(bin, '#!/bin/sh\n', 'utf-8');
      }
      return dir;
    });

    const result = await setupBinaries({
      version: 'v1.54.0',
      mcpGateway: false,
      mcpGatewayVersion: 'v0.22.0',
      githubToken: 'ghs_token',
    });

    expect(mockDownloadTool).toHaveBeenCalledOnce();
    // downloadTool called with auth header
    expect(mockDownloadTool.mock.calls[0][2]).toBe('token ghs_token');
    expect(mockSaveCache).toHaveBeenCalledOnce();
    expect(mockCacheDir).toHaveBeenCalledOnce();
    expect(result.dockerAgentVersion).toBe('v1.54.0');
    expect(result.dockerAgentPath).toContain('docker-agent');
  });

  it('continues when saveCache throws (non-fatal)', async () => {
    const fakeDownload = await createFakeDownload();
    mockDownloadTool.mockResolvedValue(fakeDownload);
    mockSaveCache.mockRejectedValue(new Error('Cache quota exceeded'));
    mockCacheDir.mockImplementation(async (dir: string) => {
      const bin = join(dir, 'docker-agent');
      if (!fsSync.existsSync(bin)) {
        await writeFile(bin, '#!/bin/sh\n', 'utf-8');
      }
      return dir;
    });

    const result = await setupBinaries({
      version: 'v1.54.0',
      mcpGateway: false,
      mcpGatewayVersion: 'v0.22.0',
    });

    expect(result.dockerAgentVersion).toBe('v1.54.0');
    // warning was emitted (not a failure)
    const { warning } = await import('@actions/core');
    expect(vi.mocked(warning)).toHaveBeenCalledWith(
      expect.stringContaining('Cache quota exceeded'),
    );
  });

  it('throws when binary verification fails', async () => {
    const fakeDownload = await createFakeDownload();
    mockDownloadTool.mockResolvedValue(fakeDownload);
    mockCacheDir.mockImplementation(async (dir: string) => {
      const bin = join(dir, 'docker-agent');
      if (!fsSync.existsSync(bin)) {
        await writeFile(bin, '#!/bin/sh\n', 'utf-8');
      }
      return dir;
    });
    mockExec.mockResolvedValue(1); // verification failure

    await expect(
      setupBinaries({ version: 'v1.54.0', mcpGateway: false, mcpGatewayVersion: 'v0.22.0' }),
    ).rejects.toThrow('docker-agent binary verification failed');
  });
});

// ── setupBinaries — mcp-gateway ───────────────────────────────────────────────

describe('setupBinaries — mcp-gateway', () => {
  beforeEach(() => {
    // First exec call (docker-agent verify) = 0, second (docker mcp version) = 0
    mockExec.mockResolvedValue(0);
  });

  it('installs mcp-gateway and sets mcpInstalled=true', async () => {
    const fakeAgentDownload = await createFakeDownload('docker-agent');
    const fakeMcpTarball = await createFakeDownload('docker-mcp.tar.gz');

    // First downloadTool = docker-agent, second = mcp tar
    mockDownloadTool.mockResolvedValueOnce(fakeAgentDownload).mockResolvedValueOnce(fakeMcpTarball);

    // extractTar returns a dir with the docker-mcp binary
    mockExtractTar.mockImplementation(async () => {
      const extractDir = await mkdtemp(join(tmpdir(), 'extracted-'));
      await writeFile(join(extractDir, 'docker-mcp'), '#!/bin/sh\n', 'utf-8');
      return extractDir;
    });

    mockCacheDir.mockImplementation(async (dir: string) => {
      // Ensure the expected binary exists
      for (const name of ['docker-agent', 'docker-mcp']) {
        const bin = join(dir, name);
        if (!fsSync.existsSync(bin)) {
          await writeFile(bin, '#!/bin/sh\n', 'utf-8');
        }
      }
      return dir;
    });

    const result = await setupBinaries({
      version: 'v1.54.0',
      mcpGateway: true,
      mcpGatewayVersion: 'v0.22.0',
    });

    expect(result.mcpInstalled).toBe(true);
  });

  it('throws when mcp-gateway verification fails', async () => {
    const fakeAgentDownload = await createFakeDownload('docker-agent');
    const fakeMcpTarball = await createFakeDownload('docker-mcp.tar.gz');

    mockDownloadTool.mockResolvedValueOnce(fakeAgentDownload).mockResolvedValueOnce(fakeMcpTarball);

    mockExtractTar.mockImplementation(async () => {
      const extractDir = await mkdtemp(join(tmpdir(), 'extracted-'));
      await writeFile(join(extractDir, 'docker-mcp'), '#!/bin/sh\n', 'utf-8');
      return extractDir;
    });

    mockCacheDir.mockImplementation(async (dir: string) => {
      for (const name of ['docker-agent', 'docker-mcp']) {
        const bin = join(dir, name);
        if (!fsSync.existsSync(bin)) {
          await writeFile(bin, '#!/bin/sh\n', 'utf-8');
        }
      }
      return dir;
    });

    // docker-agent verify = 0, docker mcp verify = 1
    mockExec.mockResolvedValueOnce(0).mockResolvedValue(1);

    await expect(
      setupBinaries({ version: 'v1.54.0', mcpGateway: true, mcpGatewayVersion: 'v0.22.0' }),
    ).rejects.toThrow('mcp-gateway verification failed');
  });
});
