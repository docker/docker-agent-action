// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * binary.ts — download and cache the docker-agent (and optionally mcp-gateway) binary.
 *
 * Ports the `Setup binaries` step of the original composite action.yml.
 *
 * Two-level caching strategy:
 *   1. `@actions/cache` (remote)  — restores/saves the tool directory across workflow runs,
 *      equivalent to what the original `actions/cache@v4` step provided.
 *   2. `@actions/tool-cache` (local RUNNER_TOOL_CACHE) — in-process resolution once the
 *      remote cache has been restored into the runner's tool directory.
 *
 * Binary download URLs:
 *   docker-agent:  https://github.com/docker/docker-agent/releases/download/<version>/<binary>
 *   mcp-gateway:   https://github.com/docker/mcp-gateway/releases/download/<version>/<tarball>
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as actionsCache from '@actions/cache';
import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as tc from '@actions/tool-cache';

export interface BinarySetupResult {
  /** Version string of docker-agent that was installed/found. */
  cagentVersion: string;
  /** Whether mcp-gateway was successfully installed. */
  mcpInstalled: boolean;
  /** Absolute path to the docker-agent binary. */
  dockerAgentPath: string;
}

/** Detect {platform, arch} strings used in release asset names. */
export function detectPlatform(): { platform: string; arch: string; ext: string } {
  const rawPlatform = os.platform();
  const rawArch = os.arch();

  let platform: string;
  let ext = '';

  switch (rawPlatform) {
    case 'linux':
      platform = 'linux';
      break;
    case 'darwin':
      platform = 'darwin';
      break;
    case 'win32':
      platform = 'windows';
      ext = '.exe';
      break;
    default:
      throw new Error(`Unsupported operating system: ${rawPlatform}`);
  }

  let arch: string;
  switch (rawArch) {
    case 'x64':
    case 'amd64':
      arch = 'amd64';
      break;
    case 'arm64':
    case 'aarch64':
      arch = 'arm64';
      break;
    default:
      throw new Error(`Unsupported architecture: ${rawArch}`);
  }

  return { platform, arch, ext };
}

/**
 * Ensure the docker-agent binary is available on disk (remote cache → local cache → download).
 *
 * @param version      The version string (e.g. "v1.54.0") from DOCKER_AGENT_VERSION.
 * @param githubToken  Optional GitHub PAT for authenticated download (avoids rate-limits).
 * @returns Absolute path to the docker-agent binary.
 */
async function ensureDockerAgent(version: string, githubToken?: string): Promise<string> {
  const { platform, arch, ext } = detectPlatform();
  const binaryName = `docker-agent${ext}`;
  const toolName = 'docker-agent';

  // ── 1. Local tool-cache hit (fastest path, same runner) ────────────────
  const localCached = tc.find(toolName, version);
  if (localCached) {
    core.info(`Using local-cached docker-agent ${version} from ${localCached}`);
    return path.join(localCached, binaryName);
  }

  // ── 2. Remote @actions/cache hit (cross-run persistence) ───────────────
  const tmpBinDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'docker-agent-'));
  const cacheKey = `docker-agent-${toolName}-${version}-${platform}-${arch}`;
  let restoredKey: string | undefined;
  try {
    restoredKey = await actionsCache.restoreCache([tmpBinDir], cacheKey);
  } catch (err: unknown) {
    core.warning(
      `Remote cache restore failed (${(err as Error).message}); falling back to download`,
    );
  }

  if (restoredKey) {
    core.info(`Restored docker-agent ${version} from remote cache (key: ${restoredKey})`);
    // Populate local tool-cache from the restored directory
    const cachedResult = await tc.cacheDir(tmpBinDir, toolName, version);
    const binaryPath = path.join(cachedResult, binaryName);
    fs.chmodSync(binaryPath, 0o755);
    return binaryPath;
  }

  // ── 3. Download from GitHub releases ───────────────────────────────────
  const assetName = `docker-agent-${platform}-${arch}${ext}`;
  const downloadUrl = `https://github.com/docker/docker-agent/releases/download/${version}/${assetName}`;
  core.info(`Downloading docker-agent ${version} for ${platform}-${arch}...`);
  core.info(`URL: ${downloadUrl}`);

  const auth = githubToken ? `token ${githubToken}` : undefined;
  const downloadedPath = await tc.downloadTool(downloadUrl, undefined, auth);

  // Copy binary into our staging dir under its canonical name
  const binaryDest = path.join(tmpBinDir, binaryName);
  await fs.promises.copyFile(downloadedPath, binaryDest);
  fs.chmodSync(binaryDest, 0o755);

  // Persist to remote cache before populating local tool-cache
  try {
    await actionsCache.saveCache([tmpBinDir], cacheKey);
    core.info(`Saved docker-agent ${version} to remote cache (key: ${cacheKey})`);
  } catch (err: unknown) {
    // Cache save failures are non-fatal (e.g. read-only in forked PRs)
    core.warning(`Remote cache save skipped: ${(err as Error).message}`);
  }

  // Populate local tool-cache
  const cachedResult = await tc.cacheDir(tmpBinDir, toolName, version);
  core.info(`Cached docker-agent ${version} locally at ${cachedResult}`);

  return path.join(cachedResult, binaryName);
}

/**
 * Ensure mcp-gateway is installed into ~/.docker/cli-plugins/docker-mcp.
 *
 * @param version      The mcp-gateway version string (e.g. "v0.22.0").
 * @param githubToken  Optional GitHub PAT for download.
 */
async function ensureMcpGateway(version: string, githubToken?: string): Promise<void> {
  const { platform, arch } = detectPlatform();
  const toolName = 'docker-mcp';
  const pluginDir = path.join(os.homedir(), '.docker', 'cli-plugins');
  const pluginBinary = os.platform() === 'win32' ? 'docker-mcp.exe' : 'docker-mcp';
  const pluginPath = path.join(pluginDir, pluginBinary);

  // ── 1. Local tool-cache hit ─────────────────────────────────────────────
  const localCached = tc.find(toolName, version);
  if (localCached) {
    core.info(`Using local-cached mcp-gateway ${version}`);
    const cachedBinary = path.join(localCached, pluginBinary);
    await fs.promises.mkdir(pluginDir, { recursive: true });
    await fs.promises.copyFile(cachedBinary, pluginPath);
    fs.chmodSync(pluginPath, 0o755);
    return;
  }

  // ── 2. Remote @actions/cache hit ───────────────────────────────────────
  const tmpPluginDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'docker-mcp-'));
  const cacheKey = `docker-agent-${toolName}-${version}-${platform}-${arch}`;
  let restoredKey: string | undefined;
  try {
    restoredKey = await actionsCache.restoreCache([tmpPluginDir], cacheKey);
  } catch (err: unknown) {
    core.warning(
      `Remote cache restore failed (${(err as Error).message}); falling back to download`,
    );
  }

  if (restoredKey) {
    core.info(`Restored mcp-gateway ${version} from remote cache (key: ${restoredKey})`);
    const cachedResult = await tc.cacheDir(tmpPluginDir, toolName, version);
    const cachedBinary = path.join(cachedResult, pluginBinary);
    fs.chmodSync(cachedBinary, 0o755);
    await fs.promises.mkdir(pluginDir, { recursive: true });
    await fs.promises.copyFile(cachedBinary, pluginPath);
    fs.chmodSync(pluginPath, 0o755);
    return;
  }

  // ── 3. Download tarball from GitHub releases ────────────────────────────
  const assetName = `docker-mcp-${platform}-${arch}.tar.gz`;
  const downloadUrl = `https://github.com/docker/mcp-gateway/releases/download/${version}/${assetName}`;
  core.info(`Downloading mcp-gateway ${version} for ${platform}-${arch}...`);

  const auth = githubToken ? `token ${githubToken}` : undefined;
  const tarPath = await tc.downloadTool(downloadUrl, undefined, auth);
  const extractedDir = await tc.extractTar(tarPath);

  // The tarball contains the docker-mcp binary
  const extractedBinary = path.join(extractedDir, pluginBinary);
  fs.chmodSync(extractedBinary, 0o755);

  // Stage binary for caching
  await fs.promises.copyFile(extractedBinary, path.join(tmpPluginDir, pluginBinary));
  fs.chmodSync(path.join(tmpPluginDir, pluginBinary), 0o755);

  // Persist to remote cache
  try {
    await actionsCache.saveCache([tmpPluginDir], cacheKey);
    core.info(`Saved mcp-gateway ${version} to remote cache (key: ${cacheKey})`);
  } catch (err: unknown) {
    core.warning(`Remote cache save skipped: ${(err as Error).message}`);
  }

  // Populate local tool-cache
  await tc.cacheDir(tmpPluginDir, toolName, version);

  // Install to plugin directory
  await fs.promises.mkdir(pluginDir, { recursive: true });
  await fs.promises.copyFile(extractedBinary, pluginPath);
  fs.chmodSync(pluginPath, 0o755);
}

/**
 * Set up docker-agent and (optionally) mcp-gateway binaries.
 *
 * Caching strategy: remote @actions/cache for cross-run persistence,
 * local @actions/tool-cache for in-process resolution.
 *
 * @param opts.version           docker-agent version (from DOCKER_AGENT_VERSION file).
 * @param opts.mcpGateway        Whether to install mcp-gateway.
 * @param opts.mcpGatewayVersion mcp-gateway version (if installing).
 * @param opts.githubToken       GitHub token for authenticated downloads.
 * @param opts.debug             Enable verbose logging.
 */
export async function setupBinaries(opts: {
  version: string;
  mcpGateway: boolean;
  mcpGatewayVersion: string;
  githubToken?: string;
  debug?: boolean;
}): Promise<BinarySetupResult> {
  const { version, mcpGateway, mcpGatewayVersion, githubToken, debug } = opts;

  if (debug) {
    core.debug(`Setting up docker-agent ${version}`);
    core.debug(`MCP Gateway: ${mcpGateway ? mcpGatewayVersion : 'disabled'}`);
  }

  // Install docker-agent
  const dockerAgentPath = await ensureDockerAgent(version, githubToken);

  // Verify binary works
  core.info('Verifying docker-agent binary...');
  const verifyCode = await exec.exec(`"${dockerAgentPath}"`, ['version'], {
    ignoreReturnCode: true,
    silent: !debug,
  });
  if (verifyCode !== 0) {
    throw new Error(`docker-agent binary verification failed (exit code ${verifyCode})`);
  }

  // Install mcp-gateway if requested
  let mcpInstalled = false;
  if (mcpGateway) {
    await ensureMcpGateway(mcpGatewayVersion, githubToken);

    // Verify via `docker mcp version`
    core.info('Verifying mcp-gateway installation...');
    const mcpVerifyCode = await exec.exec('docker', ['mcp', 'version'], {
      ignoreReturnCode: true,
      silent: !debug,
    });
    if (mcpVerifyCode !== 0) {
      throw new Error(`mcp-gateway verification failed (exit code ${mcpVerifyCode})`);
    }
    mcpInstalled = true;
  }

  core.info(`✅ docker-agent ${version} ready at: ${dockerAgentPath}`);
  if (mcpInstalled) {
    core.info(`✅ mcp-gateway ${mcpGatewayVersion} installed`);
  }

  return { cagentVersion: version, mcpInstalled, dockerAgentPath };
}
