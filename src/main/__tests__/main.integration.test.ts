// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration test for src/main/index.ts — run() orchestration.
 *
 * Exercises the full run() pipeline with all external side-effects mocked:
 *   - @actions/core   (getInput, setOutput, setFailed, summary, …)
 *   - @actions/tool-cache / @actions/cache / @actions/exec  (binary setup)
 *   - @actions/artifact (DefaultArtifactClient)
 *   - @octokit/rest  (Octokit — security incident issue creation)
 *   - node:child_process (spawn — agent execution)
 *
 * The security modules (sanitizeInput, sanitizeOutput) run real code
 * so the integration test validates their wiring too.
 *
 * File: src/main/__tests__/main.integration.test.ts
 * Vitest project: "integration" (matched by *.integration.test.ts pattern)
 */

import * as fsSync from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Read the pinned docker-agent version from the canonical source file so this
// test stays in sync automatically whenever DOCKER_AGENT_VERSION is bumped.
const DOCKER_AGENT_VERSION = fsSync
  .readFileSync(join(import.meta.dirname, '..', '..', '..', 'DOCKER_AGENT_VERSION'), 'utf-8')
  .trim();

// ── Hoisted mock state ────────────────────────────────────────────────────────

const {
  mockGetInput,
  mockGetBooleanInput,
  mockSetOutput,
  mockSetFailed,
  mockSetSecret,
  mockInfo,
  mockWarning,
  mockError,
  mockDebug,
  mockSummary,
  MockOctokit,
  mockFind,
  mockDownloadTool,
  mockCacheDir,
  mockExec,
  mockRestoreCache,
  mockSaveCache,
  mockUploadArtifact,
  MockDefaultArtifactClient,
  mockSpawn,
} = vi.hoisted(() => {
  // core.summary — chainable
  const mockSummary = {
    addHeading: vi.fn(),
    addRaw: vi.fn(),
    addTable: vi.fn(),
    write: vi.fn().mockResolvedValue(undefined),
  };
  mockSummary.addHeading.mockReturnValue(mockSummary);
  mockSummary.addRaw.mockReturnValue(mockSummary);
  mockSummary.addTable.mockReturnValue(mockSummary);

  // @octokit/rest
  class MockOctokit {
    rest = {
      issues: { create: vi.fn().mockResolvedValue({ data: { number: 1 } }) },
    };
  }

  // @actions/core
  const mockGetInput = vi.fn().mockReturnValue('');
  const mockGetBooleanInput = vi.fn().mockReturnValue(false);
  const mockSetOutput = vi.fn();
  const mockSetFailed = vi.fn();
  const mockSetSecret = vi.fn();
  const mockInfo = vi.fn();
  const mockWarning = vi.fn();
  const mockError = vi.fn();
  const mockDebug = vi.fn();

  // @actions/tool-cache
  const mockFind = vi.fn().mockReturnValue('');
  const mockDownloadTool = vi.fn();
  const mockCacheDir = vi.fn();
  const mockExec = vi.fn().mockResolvedValue(0);

  // @actions/cache
  const mockRestoreCache = vi.fn().mockResolvedValue(undefined);
  const mockSaveCache = vi.fn().mockResolvedValue(42);

  // @actions/artifact
  const mockUploadArtifact = vi.fn().mockResolvedValue({ id: 99 });
  class MockDefaultArtifactClient {
    uploadArtifact = mockUploadArtifact;
  }

  // node:child_process
  const mockSpawn = vi.fn();

  return {
    mockGetInput,
    mockGetBooleanInput,
    mockSetOutput,
    mockSetFailed,
    mockSetSecret,
    mockInfo,
    mockWarning,
    mockError,
    mockDebug,
    mockSummary,
    MockOctokit,
    mockFind,
    mockDownloadTool,
    mockCacheDir,
    mockExec,
    mockRestoreCache,
    mockSaveCache,
    mockUploadArtifact,
    MockDefaultArtifactClient,
    mockSpawn,
  };
});

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('@actions/core', () => ({
  getInput: mockGetInput,
  getBooleanInput: mockGetBooleanInput,
  setOutput: mockSetOutput,
  setFailed: mockSetFailed,
  setSecret: mockSetSecret,
  info: mockInfo,
  warning: mockWarning,
  error: mockError,
  debug: mockDebug,
  summary: mockSummary,
}));

vi.mock('@octokit/rest', () => ({ Octokit: MockOctokit }));

vi.mock('@actions/tool-cache', () => ({
  find: mockFind,
  downloadTool: mockDownloadTool,
  cacheDir: mockCacheDir,
  extractTar: vi.fn(),
}));

vi.mock('@actions/cache', () => ({
  restoreCache: mockRestoreCache,
  saveCache: mockSaveCache,
}));

vi.mock('@actions/exec', () => ({ exec: mockExec }));

vi.mock('@actions/artifact', () => ({
  DefaultArtifactClient: MockDefaultArtifactClient,
}));

vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
}));

import { run } from '../index.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir: string;

/** Create a mock child process that closes with the given exit code. */
function makeMockChild(exitCode: number) {
  const emitter = new EventEmitter() as EventEmitter & {
    stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
  };
  emitter.stdin = { write: vi.fn(), end: vi.fn() };
  emitter.kill = vi.fn();
  setImmediate(() => emitter.emit('close', exitCode));
  return emitter;
}

/** Set up core.getInput to return test values from a map. */
function setupInputs(overrides: Record<string, string> = {}) {
  const defaults: Record<string, string> = {
    agent: 'docker/test-agent',
    'anthropic-api-key': 'sk-ant-test123',
    'openai-api-key': '',
    'google-api-key': '',
    'aws-bearer-token-bedrock': '',
    'xai-api-key': '',
    'nebius-api-key': '',
    'mistral-api-key': '',
    'github-token': '',
    prompt: 'Analyze this code',
    'mcp-gateway': 'false',
    'mcp-gateway-version': 'v0.22.0',
    timeout: '0',
    'max-retries': '0',
    'retry-delay': '0',
    'working-directory': '.',
    'extra-args': '',
    'add-prompt-files': '',
    'skip-summary': 'true',
    debug: 'false',
    ...overrides,
  };
  mockGetInput.mockImplementation((name: string) => defaults[name] ?? '');
  mockGetBooleanInput.mockImplementation((name: string) => defaults[name] === 'true');
}

/** Set up binary mocks so setupBinaries() succeeds without real downloads. */
async function setupBinaryMocks() {
  // Create a real fake binary
  const fakeDir = join(tmpDir, 'tool-cache', 'docker-agent');
  fsSync.mkdirSync(fakeDir, { recursive: true });
  const fakeBin = join(fakeDir, 'docker-agent');
  await writeFile(fakeBin, `#!/bin/sh\necho ${DOCKER_AGENT_VERSION}\n`, 'utf-8');
  fsSync.chmodSync(fakeBin, 0o755);

  // Local cache hit — returns dir with binary
  mockFind.mockReturnValue(fakeDir);
  // exec (binary verification) returns 0
  mockExec.mockResolvedValue(0);
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'main-int-test-'));

  process.env.GITHUB_TOKEN = 'gha-fake-token';
  process.env.GITHUB_RUN_ID = '12345';
  process.env.GITHUB_RUN_ATTEMPT = '1';
  process.env.GITHUB_JOB = 'test-job';
  process.env.GITHUB_REPOSITORY = 'docker/docker-agent-action';
  process.env.GITHUB_WORKFLOW = 'Test';

  // Reset all mock state
  vi.clearAllMocks();
  mockSummary.addHeading.mockReturnValue(mockSummary);
  mockSummary.addRaw.mockReturnValue(mockSummary);
  mockSummary.addTable.mockReturnValue(mockSummary);
  mockSummary.write.mockResolvedValue(undefined);
  mockUploadArtifact.mockResolvedValue({ id: 99 });

  // Default binary mock
  await setupBinaryMocks();
  // Default: agent exits 0
  mockSpawn.mockImplementation(() => makeMockChild(0));

  // Reset process.exitCode
  process.exitCode = 0;
});

afterEach(async () => {
  process.exitCode = 0;
  delete process.env.GITHUB_TOKEN;
  await rm(tmpDir, { recursive: true, force: true });
});

// ── Happy path ────────────────────────────────────────────────────────────────

describe('happy path — agent succeeds', () => {
  it('sets all expected outputs on success', async () => {
    setupInputs();

    await run();

    // Core outputs must be set
    const outputCalls = Object.fromEntries(
      mockSetOutput.mock.calls.map(([name, value]) => [name, value]),
    );
    expect(outputCalls['prompt-suspicious']).toBe('false');
    expect(outputCalls['input-risk-level']).toBe('low');
    expect(outputCalls['docker-agent-version']).toBe(DOCKER_AGENT_VERSION);
    expect(outputCalls['mcp-gateway-installed']).toBe('false');
    expect(outputCalls['exit-code']).toBe('0');
    expect(outputCalls['secrets-detected']).toBe('false');
    expect(outputCalls['security-blocked']).toBe('false');
    expect(outputCalls['output-file']).toBeDefined();
    expect(outputCalls['verbose-log-file']).toBeDefined();

    // setFailed must not have been called
    expect(mockSetFailed).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it('masks the github token with setSecret', async () => {
    setupInputs({ 'github-token': 'ghs_explicit_token' });

    await run();

    expect(mockSetSecret).toHaveBeenCalledWith('ghs_explicit_token');
  });

  it('uploads verbose log artifact', async () => {
    setupInputs();

    await run();

    expect(mockUploadArtifact).toHaveBeenCalledOnce();
    const [name] = mockUploadArtifact.mock.calls[0] as [string, ...unknown[]];
    expect(name).toContain('docker-agent-verbose-log');
    expect(name).toContain('12345'); // GITHUB_RUN_ID
  });

  it('writes job summary when skip-summary is false', async () => {
    setupInputs({ 'skip-summary': 'false' });

    await run();

    expect(mockSummary.write).toHaveBeenCalledOnce();
  });

  it('skips job summary when skip-summary is true', async () => {
    setupInputs({ 'skip-summary': 'true' });

    await run();

    expect(mockSummary.write).not.toHaveBeenCalled();
  });
});

// ── Validation failures ───────────────────────────────────────────────────────

describe('input validation', () => {
  it('calls setFailed when no API key is provided', async () => {
    setupInputs({
      'anthropic-api-key': '',
      'openai-api-key': '',
      'google-api-key': '',
      'aws-bearer-token-bedrock': '',
      'xai-api-key': '',
      'nebius-api-key': '',
      'mistral-api-key': '',
    });

    await run();

    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining('At least one API key is required'),
    );
  });

  it('calls setFailed when agent input is empty', async () => {
    setupInputs({ agent: '' });
    mockGetInput.mockImplementation((name: string) => {
      if (name === 'agent') return '';
      if (name === 'anthropic-api-key') return 'sk-ant-test';
      return '';
    });

    await run();

    expect(mockSetFailed).toHaveBeenCalled();
  });
});

// ── Security — prompt injection ───────────────────────────────────────────────

describe('security — prompt injection', () => {
  it('blocks execution when prompt contains critical pattern', async () => {
    // Use a real CRITICAL_PATTERN from patterns.ts: /echo.*\$.*ANTHROPIC_API_KEY/i
    setupInputs({ prompt: 'echo $ANTHROPIC_API_KEY' });

    await run();

    expect(mockSetFailed).toHaveBeenCalledWith(expect.stringContaining('blocked'));
    const outputCalls = Object.fromEntries(mockSetOutput.mock.calls.map(([n, v]) => [n, v]));
    expect(outputCalls['security-blocked']).toBe('true');
  });
});

// ── Agent exit code propagation ───────────────────────────────────────────────

describe('agent exit code propagation', () => {
  it('sets process.exitCode to agent exit code when agent fails', async () => {
    setupInputs();
    mockSpawn.mockImplementation(() => makeMockChild(1));

    await run();

    expect(process.exitCode).toBe(1);
    // setFailed was not called — we use process.exitCode directly for agent failures
  });

  it('leaves process.exitCode at 0 when agent succeeds', async () => {
    setupInputs();
    mockSpawn.mockImplementation(() => makeMockChild(0));

    await run();

    expect(process.exitCode).toBe(0);
  });
});

// ── Retry output trimming (FIX 2) ───────────────────────────────────────────

describe('retry output trimming (FIX 2)', () => {
  it('uses only the last retry attempt content, not the full verbose log', async () => {
    // Simulate a verbose log that contains two attempt sections separated by the
    // marker that exec.ts appends before each retry attempt.  The first attempt
    // has a partial docker-agent-output block (corrupt output); the second attempt
    // has the correct final block.  The fix must ensure only the last section is
    // passed to filterAgentOutput so the first-attempt block does not contaminate.
    setupInputs();

    let capturedVerboseLog: string | undefined;
    let capturedOutputFile: string | undefined;

    mockSetOutput.mockImplementation((name: string, value: string) => {
      if (name === 'verbose-log-file') capturedVerboseLog = value;
      if (name === 'output-file') capturedOutputFile = value;
    });

    mockSpawn.mockImplementation(() => {
      // Write verbose log content with retry markers — simulates what exec.ts
      // produces after a failed attempt 1 and a successful attempt 2.
      if (capturedVerboseLog) {
        const content = [
          '## First attempt (partial / wrong)',
          '```docker-agent-output',
          'WRONG: first attempt block',
          '```',
          '',
          '========== RETRY ATTEMPT 2 (2025-01-15T00:00:00.000Z) ==========',
          '',
          '## Second attempt (correct)',
          '```docker-agent-output',
          'CORRECT: last attempt block',
          '```',
        ].join('\n');
        fsSync.appendFileSync(capturedVerboseLog, content, 'utf-8');
      }
      return makeMockChild(0);
    });

    await run();

    expect(capturedOutputFile).toBeDefined();
    // Safe cast: toBeDefined() assertion above guarantees this is set
    const outputContent = fsSync.readFileSync(capturedOutputFile as string, 'utf-8');

    // Only the last attempt's output block should be present
    expect(outputContent).toContain('CORRECT: last attempt block');
    expect(outputContent).not.toContain('WRONG: first attempt block');
  });

  it('passes the full log through when there are no retry markers', async () => {
    // When no retries occurred the marker is absent; the log must be processed
    // in its entirety (parts.length === 1, parts[0] === rawVerbose).
    setupInputs();

    let capturedVerboseLog: string | undefined;
    let capturedOutputFile: string | undefined;

    mockSetOutput.mockImplementation((name: string, value: string) => {
      if (name === 'verbose-log-file') capturedVerboseLog = value;
      if (name === 'output-file') capturedOutputFile = value;
    });

    mockSpawn.mockImplementation(() => {
      if (capturedVerboseLog) {
        fsSync.appendFileSync(
          capturedVerboseLog,
          '## Single attempt\n\nAll content from the one and only run.',
          'utf-8',
        );
      }
      return makeMockChild(0);
    });

    await run();

    expect(capturedOutputFile).toBeDefined();
    // Safe cast: toBeDefined() assertion above guarantees this is set
    const outputContent = fsSync.readFileSync(capturedOutputFile as string, 'utf-8');
    expect(outputContent).toContain('## Single attempt');
    expect(outputContent).toContain('All content from the one and only run.');
  });
});

describe('security pipeline ordering (FIX 1)', () => {
  it('sanitizeOutput scans full filtered output before block extraction narrows it', async () => {
    // This test MUST fail if FIX 1 is reverted (sanitize-after-extract order).
    // Strategy: verbose log contains a real Anthropic API key (matching
    // /sk-ant-(api|sid|admin)NN-<93 base64url>AA/) in conversational text BEFORE
    // a clean docker-agent-output block.  Under the correct order (filter →
    // sanitize → extract), sanitizeOutput sees the key → secrets-detected=true.
    // Under the wrong order (filter → extract → sanitize) the outputFile
    // contains only the clean block and the key is never scanned.
    const LEAKED_KEY = `sk-ant-api03-${'A'.repeat(93)}AA`;

    setupInputs({ prompt: 'Please review this PR' });

    let capturedVerboseLog: string | undefined;
    let capturedOutputFile: string | undefined;

    mockSetOutput.mockImplementation((name: string, value: string) => {
      if (name === 'verbose-log-file') capturedVerboseLog = value;
      if (name === 'output-file') capturedOutputFile = value;
    });

    // Write verbose log content SYNCHRONOUSLY so it is present when run() reads
    // the file immediately after spawn completes.
    mockSpawn.mockImplementation(() => {
      if (capturedVerboseLog) {
        fsSync.appendFileSync(
          capturedVerboseLog,
          [
            'Here is my analysis.',
            `Oops I leaked: ${LEAKED_KEY}`,
            '```docker-agent-output',
            '## Result',
            '',
            'Clean output with no secrets.',
            '```',
          ].join('\n'),
          'utf-8',
        );
      }
      return makeMockChild(0);
    });

    await run();

    // The key must have been detected BEFORE block extraction narrowed the file.
    const outputCalls = Object.fromEntries(mockSetOutput.mock.calls.map(([n, v]) => [n, v]));
    expect(outputCalls['secrets-detected']).toBe('true');
    expect(outputCalls['security-blocked']).toBe('true');

    // When a leak is detected, Step 9b is skipped — outputFile retains full
    // filtered text so the incident path can see the leaked key.
    if (capturedOutputFile && fsSync.existsSync(capturedOutputFile)) {
      const content = fsSync.readFileSync(capturedOutputFile, 'utf-8');
      expect(content).toContain(LEAKED_KEY);
    }
  });
});
