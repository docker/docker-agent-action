// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for src/main/exec.ts
 *
 * buildArgs: pure function — no mocking required.
 * runAgent:  mocks child_process.spawn and @actions/core.
 *            Uses real temp files for verboseLogFile so fs ops work normally.
 */

import * as fsSync from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@actions/core');

// ── Mock child_process.spawn ──────────────────────────────────────────────────

const { mockSpawn } = vi.hoisted(() => {
  const mockSpawn = vi.fn();
  return { mockSpawn };
});

vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
}));

import { buildArgs, runAgent, TIMEOUT_EXIT_CODE } from '../exec.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir: string;
let verboseLogFile: string;

/** Create a mock child process that closes with the given exit code. */
function makeMockChild(exitCode: number, delayMs = 0) {
  const emitter = new EventEmitter() as EventEmitter & {
    stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
  };
  emitter.stdin = { write: vi.fn(), end: vi.fn() };

  // When killed (SIGTERM/SIGKILL), emit close shortly after — simulates real process dying.
  emitter.kill = vi.fn().mockImplementation(() => {
    setImmediate(() => emitter.emit('close', null));
  });

  // Natural exit after delayMs (ignored if kill fires first)
  setTimeout(() => emitter.emit('close', exitCode), delayMs);

  return emitter;
}

/** Minimal valid RunAgentOptions. */
function baseOpts(overrides: Partial<Parameters<typeof runAgent>[0]> = {}) {
  return {
    dockerAgentPath: '/usr/local/bin/docker-agent',
    agent: 'docker/test-agent',
    promptInput: 'Hello agent',
    promptCleanFile: join(tmpDir, 'nonexistent-clean.txt'), // doesn't exist → use promptInput
    workingDir: tmpDir,
    yolo: true,
    addPromptFiles: '',
    extraArgs: '',
    timeout: 0,
    maxRetries: 0,
    retryDelay: 0,
    retryOnTimeout: 0,
    debug: false,
    anthropicApiKey: 'sk-ant-test',
    telemetryTags: 'source=test',
    verboseLogFile,
    ...overrides,
  };
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'exec-test-'));
  verboseLogFile = join(tmpDir, 'verbose.log');
  fsSync.writeFileSync(verboseLogFile, '', 'utf-8');
  vi.clearAllMocks();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── buildArgs (pure) ─────────────────────────────────────────────────────────

describe('buildArgs', () => {
  it('basic args with yolo=true', () => {
    const args = buildArgs({
      agent: 'docker/test',
      yolo: true,
      workingDir: '/workspace',
      extraArgs: '',
      addPromptFiles: '',
    });
    expect(args).toEqual([
      'run',
      '--exec',
      '--yolo',
      '--working-dir',
      '/workspace',
      'docker/test',
      '-',
    ]);
  });

  it('omits --yolo when yolo=false', () => {
    const args = buildArgs({
      agent: 'docker/test',
      yolo: false,
      workingDir: '/workspace',
      extraArgs: '',
      addPromptFiles: '',
    });
    expect(args).not.toContain('--yolo');
    expect(args[0]).toBe('run');
  });

  it('word-splits extraArgs (no eval)', () => {
    const args = buildArgs({
      agent: 'docker/test',
      yolo: false,
      workingDir: '/workspace',
      extraArgs: '--model claude-3-5 --max-tokens 4096',
      addPromptFiles: '',
    });
    expect(args).toContain('--model');
    expect(args).toContain('claude-3-5');
    expect(args).toContain('--max-tokens');
    expect(args).toContain('4096');
  });

  it('expands comma-separated addPromptFiles into --prompt-file pairs', () => {
    const args = buildArgs({
      agent: 'docker/test',
      yolo: false,
      workingDir: '/workspace',
      extraArgs: '',
      addPromptFiles: 'AGENTS.md, CLAUDE.md',
    });
    // Expect two --prompt-file pairs
    const pfIdx = args.indexOf('--prompt-file');
    expect(pfIdx).toBeGreaterThan(-1);
    expect(args[pfIdx + 1]).toBe('AGENTS.md');
    const pfIdx2 = args.indexOf('--prompt-file', pfIdx + 1);
    expect(pfIdx2).toBeGreaterThan(-1);
    expect(args[pfIdx2 + 1]).toBe('CLAUDE.md');
  });

  it('filters empty entries from addPromptFiles', () => {
    const args = buildArgs({
      agent: 'docker/test',
      yolo: false,
      workingDir: '/workspace',
      extraArgs: '',
      addPromptFiles: 'a.md,,b.md',
    });
    const promptFiles = args.filter((_, i) => i > 0 && args[i - 1] === '--prompt-file');
    expect(promptFiles).toEqual(['a.md', 'b.md']);
  });

  it('always ends with agent identifier then "-"', () => {
    const args = buildArgs({
      agent: 'my/agent',
      yolo: false,
      workingDir: '/w',
      extraArgs: '',
      addPromptFiles: '',
    });
    expect(args.at(-2)).toBe('my/agent');
    expect(args.at(-1)).toBe('-');
  });
});

// ── runAgent ─────────────────────────────────────────────────────────────────

describe('runAgent', () => {
  it('returns exit code 0 on success', async () => {
    mockSpawn.mockReturnValue(makeMockChild(0));

    const result = await runAgent(baseOpts());

    expect(result.exitCode).toBe(0);
    expect(result.verboseLogFile).toBe(verboseLogFile);
    expect(mockSpawn).toHaveBeenCalledOnce();
  });

  it('passes agent args to spawn (never API keys in argv)', async () => {
    mockSpawn.mockReturnValue(makeMockChild(0));

    await runAgent(baseOpts({ anthropicApiKey: 'sk-ant-secret' }));

    const [binaryPath, args, opts] = mockSpawn.mock.calls[0] as [
      string,
      string[],
      object & { env: Record<string, string> },
    ];
    // Binary path matches
    expect(binaryPath).toBe('/usr/local/bin/docker-agent');
    // API key NOT in args
    expect(args.join(' ')).not.toContain('sk-ant-secret');
    // API key IS in env
    expect(opts.env.ANTHROPIC_API_KEY).toBe('sk-ant-secret');
  });

  it('masks secrets with setSecret before spawning', async () => {
    const { setSecret } = await import('@actions/core');
    mockSpawn.mockReturnValue(makeMockChild(0));

    await runAgent(
      baseOpts({
        anthropicApiKey: 'sk-ant-secret',
        openaiApiKey: 'sk-openai-secret',
      }),
    );

    expect(vi.mocked(setSecret)).toHaveBeenCalledWith('sk-ant-secret');
    expect(vi.mocked(setSecret)).toHaveBeenCalledWith('sk-openai-secret');
  });

  it('reads prompt from promptCleanFile when it exists', async () => {
    mockSpawn.mockReturnValue(makeMockChild(0));
    const cleanFile = join(tmpDir, 'clean.txt');
    fsSync.writeFileSync(cleanFile, 'Sanitized prompt', 'utf-8');

    await runAgent(baseOpts({ promptCleanFile: cleanFile }));

    // stdin.write was called with content of the clean file
    const child = makeMockChild(0); // just to get type
    const actualChild = mockSpawn.mock.results[0].value as typeof child;
    const writtenData = actualChild.stdin.write.mock.calls[0][0] as Buffer;
    expect(writtenData.toString()).toBe('Sanitized prompt');
  });

  it('falls back to promptInput when promptCleanFile does not exist', async () => {
    mockSpawn.mockReturnValue(makeMockChild(0));

    await runAgent(baseOpts({ promptInput: 'Raw prompt' }));

    const actualChild = mockSpawn.mock.results[0].value;
    const writtenData = actualChild.stdin.write.mock.calls[0][0] as Buffer;
    expect(writtenData.toString()).toContain('Raw prompt');
  });

  it('returns TIMEOUT_EXIT_CODE (124) without retrying on timeout when retryOnTimeout=0', async () => {
    // Return 124 (our timeout sentinel — simulate the timer firing)
    mockSpawn.mockReturnValue(makeMockChild(TIMEOUT_EXIT_CODE));

    const result = await runAgent(baseOpts({ timeout: 5, maxRetries: 3, retryOnTimeout: 0 }));

    expect(result.exitCode).toBe(TIMEOUT_EXIT_CODE);
    // Only spawned once — no retries after timeout
    expect(mockSpawn).toHaveBeenCalledOnce();
  });

  it('retries once on timeout when retryOnTimeout=1, succeeds on retry', async () => {
    mockSpawn
      .mockImplementationOnce(() => makeMockChild(TIMEOUT_EXIT_CODE))
      .mockImplementation(() => makeMockChild(0));

    const result = await runAgent(baseOpts({ maxRetries: 0, retryDelay: 0, retryOnTimeout: 1 }));

    expect(result.exitCode).toBe(0);
    // First attempt timed out, second attempt succeeded
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it('stops retrying on timeout after retryOnTimeout attempts', async () => {
    mockSpawn.mockImplementation(() => makeMockChild(TIMEOUT_EXIT_CODE));

    const result = await runAgent(baseOpts({ maxRetries: 0, retryDelay: 0, retryOnTimeout: 1 }));

    expect(result.exitCode).toBe(TIMEOUT_EXIT_CODE);
    // 1 initial + 1 timeout retry = 2 total
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it('timeout retry budget is independent of failure retry budget (mixed sequence)', async () => {
    // Attempt 1: normal failure — consumes one failureRetryCount slot
    // Attempt 2: timeout — should still get its own retryOnTimeout=1 slot
    // Attempt 3: success
    mockSpawn
      .mockImplementationOnce(() => makeMockChild(1)) // failure
      .mockImplementationOnce(() => makeMockChild(TIMEOUT_EXIT_CODE)) // timeout
      .mockImplementation(() => makeMockChild(0)); // success

    const result = await runAgent(baseOpts({ maxRetries: 1, retryDelay: 0, retryOnTimeout: 1 }));

    expect(result.exitCode).toBe(0);
    // failure retry + timeout retry + final success = 3 spawns
    expect(mockSpawn).toHaveBeenCalledTimes(3);
  });

  it('kills process with SIGTERM when timeout fires (FIX D)', async () => {
    // Child exits naturally in 5 s; action timeout is 50 ms.
    // The real timer path fires SIGTERM, then the child is killed.
    const child = makeMockChild(0, 5000);
    mockSpawn.mockReturnValue(child);

    const result = await runAgent(baseOpts({ timeout: 0.05, maxRetries: 0 }));

    expect(result.exitCode).toBe(TIMEOUT_EXIT_CODE);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  }, 2000);

  it('retries on non-zero exit code up to maxRetries times', async () => {
    // Each spawn call must have its own close event
    mockSpawn
      .mockImplementationOnce(() => makeMockChild(1))
      .mockImplementationOnce(() => makeMockChild(1))
      .mockImplementation(() => makeMockChild(0));

    const result = await runAgent(baseOpts({ maxRetries: 2, retryDelay: 0 }));

    expect(result.exitCode).toBe(0);
    expect(mockSpawn).toHaveBeenCalledTimes(3);
  });

  it('stops retrying after maxRetries and returns last exit code', async () => {
    // Use mockImplementation so each spawn call gets a fresh child with its own close event
    mockSpawn.mockImplementation(() => makeMockChild(1));

    const result = await runAgent(baseOpts({ maxRetries: 1, retryDelay: 0 }));

    expect(result.exitCode).toBe(1);
    // 1 initial attempt + 1 retry = 2 total
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it('appends retry separator to verbose log on retry', async () => {
    // Each spawn call gets a fresh child (fresh close event)
    mockSpawn
      .mockImplementationOnce(() => makeMockChild(1))
      .mockImplementation(() => makeMockChild(0));

    await runAgent(baseOpts({ maxRetries: 1, retryDelay: 0 }));

    const logContent = fsSync.readFileSync(verboseLogFile, 'utf-8');
    expect(logContent).toContain('RETRY ATTEMPT');
  });

  it('resolves with exit code 1 when spawn emits error', async () => {
    const emitter = new EventEmitter() as EventEmitter & {
      stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
      kill: ReturnType<typeof vi.fn>;
    };
    emitter.stdin = { write: vi.fn(), end: vi.fn() };
    emitter.kill = vi.fn();

    mockSpawn.mockReturnValue(emitter);
    setTimeout(() => emitter.emit('error', new Error('spawn ENOENT')), 0);

    const result = await runAgent(baseOpts({ maxRetries: 0 }));
    expect(result.exitCode).toBe(1);
  });

  it('injects all API keys into env (never args)', async () => {
    mockSpawn.mockReturnValue(makeMockChild(0));

    await runAgent(
      baseOpts({
        anthropicApiKey: 'ant-key',
        openaiApiKey: 'oai-key',
        googleApiKey: 'goog-key',
        awsBearerTokenBedrock: 'aws-key',
        xaiApiKey: 'xai-key',
        nebiusApiKey: 'neb-key',
        mistralApiKey: 'mis-key',
        ghToken: 'gh-token',
        telemetryTags: 'source=ci',
      }),
    );

    const envPassed = mockSpawn.mock.calls[0][2].env as Record<string, string>;
    expect(envPassed.ANTHROPIC_API_KEY).toBe('ant-key');
    expect(envPassed.OPENAI_API_KEY).toBe('oai-key');
    expect(envPassed.GOOGLE_API_KEY).toBe('goog-key');
    expect(envPassed.AWS_BEARER_TOKEN_BEDROCK).toBe('aws-key');
    expect(envPassed.XAI_API_KEY).toBe('xai-key');
    expect(envPassed.NEBIUS_API_KEY).toBe('neb-key');
    expect(envPassed.MISTRAL_API_KEY).toBe('mis-key');
    expect(envPassed.GH_TOKEN).toBe('gh-token');
    expect(envPassed.TELEMETRY_TAGS).toBe('source=ci');
  });
});
