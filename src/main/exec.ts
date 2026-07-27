// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * exec.ts — run docker-agent with retry loop, timeout, and stdin prompt.
 *
 * Ports the `Run Docker Agent` step from the original composite action.yml.
 *
 * Key behaviors preserved:
 *   - All API keys are passed via env, NEVER argv
 *   - Keys are registered with core.setSecret() BEFORE any exec call
 *   - Prompt is passed via stdin (from sanitized file or raw string)
 *   - stdout + stderr go to verbose log file (keeps runner console clean)
 *   - Exit code 124 = timeout (retried only within the retry-on-timeout budget)
 *   - Retry loop with exponential backoff
 *   - Optional total-timeout budget spanning all attempts: the last attempt is
 *     capped to the remaining budget and a retry needs >= 60 s left to start,
 *     so the loop always ends before a job-level timeout-minutes kill
 *   - Optional no-retry-pattern: retries are skipped once the verbose log
 *     proves a side effect already happened (e.g. a PR review was posted)
 *   - On retry: truncate clean output file, append separator to verbose log
 *   - SIGTERM on timeout, exit code reported as 124
 */

import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as core from '@actions/core';

export const TIMEOUT_EXIT_CODE = 124;

/** Minimum remaining total-timeout budget (seconds) for a retry to be worth starting. */
export const MIN_RETRY_BUDGET_SECONDS = 60;

export interface RunAgentOptions {
  /** Absolute path to the docker-agent binary. */
  dockerAgentPath: string;
  /** Agent identifier (e.g. "docker/code-analyzer" or path to yaml). */
  agent: string;
  /** Raw prompt string (used when no sanitized file is available). */
  promptInput: string;
  /** Path to sanitized prompt file (preferred over promptInput). */
  promptCleanFile: string;
  /** Working directory for agent execution. */
  workingDir: string;
  /** Whether to add --yolo flag. */
  yolo: boolean;
  /** Comma-separated prompt files for --prompt-file flags. */
  addPromptFiles: string;
  /** Raw extra args string (word-split, no eval). */
  extraArgs: string;
  /** Timeout in seconds (0 = no timeout). */
  timeout: number;
  /** Max retry attempts (0 = no retries). */
  maxRetries: number;
  /** Base delay between retries in seconds (doubles each attempt). */
  retryDelay: number;
  /** Number of additional retry attempts allowed when the agent times out (exit 124). */
  retryOnTimeout: number;
  /** Total wall-clock budget in seconds across all attempts, retries and delays (0 = unlimited). */
  totalTimeout: number;
  /** Regex source tested against the verbose log after a failed attempt; on match, retries are skipped. */
  noRetryPattern: string;
  /** Whether debug mode is enabled. */
  debug: boolean;

  // API keys — all passed via env, never argv
  anthropicApiKey?: string;
  openaiApiKey?: string;
  googleApiKey?: string;
  awsBearerTokenBedrock?: string;
  xaiApiKey?: string;
  nebiusApiKey?: string;
  mistralApiKey?: string;
  ghToken?: string;

  /** Telemetry tags string (passed as TELEMETRY_TAGS env). */
  telemetryTags: string;

  /** Path to verbose log file (receives all agent output). */
  verboseLogFile: string;
}

export interface RunAgentResult {
  /** Final exit code of the agent process (or 124 for timeout). */
  exitCode: number;
  /** Execution time in seconds. */
  executionTime: number;
  /** Path to the verbose log file (same as input). */
  verboseLogFile: string;
}

/**
 * Build the args array for docker-agent run.
 * No eval — word-split extraArgs with simple whitespace splitting (matches bash `read -ra`).
 */
export function buildArgs(opts: {
  agent: string;
  yolo: boolean;
  workingDir: string;
  extraArgs: string;
  addPromptFiles: string;
}): string[] {
  const args: string[] = ['run', '--exec'];

  if (opts.yolo) {
    args.push('--yolo');
  }

  // Resolved working directory so relative paths work correctly
  args.push('--working-dir', opts.workingDir);

  // Extra args — simple whitespace word-split (mirrors bash `read -ra`)
  if (opts.extraArgs.trim()) {
    const parts = opts.extraArgs.trim().split(/\s+/);
    args.push(...parts);
  }

  // Prompt files — comma-separated, each becomes --prompt-file <file>
  if (opts.addPromptFiles.trim()) {
    const files = opts.addPromptFiles
      .split(',')
      .map((f) => f.trim())
      .filter((f) => f.length > 0);
    for (const file of files) {
      args.push('--prompt-file', file);
    }
  }

  // Agent identifier
  args.push(opts.agent);

  // Stdin sentinel — agent reads prompt from stdin
  args.push('-');

  return args;
}

/**
 * Sleep for the given number of seconds.
 */
function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

/**
 * Test the verbose log against the no-retry pattern. Fails open on read errors:
 * an unreadable log cannot prove a side effect happened, so retrying stays allowed.
 */
function verboseLogMatches(logFile: string, pattern: RegExp): boolean {
  try {
    return pattern.test(fs.readFileSync(logFile, 'utf-8'));
  } catch {
    return false;
  }
}

/**
 * Spawn docker-agent as a child process, piping stdin from the prompt
 * and stdout+stderr to the verbose log file.
 *
 * Returns {exitCode} — 124 if timed out.
 */
function spawnAgent(opts: {
  binaryPath: string;
  args: string[];
  env: Record<string, string>;
  stdinData: Buffer;
  verboseLogFd: number;
  timeoutSeconds: number;
}): Promise<number> {
  return new Promise((resolve) => {
    const child = childProcess.spawn(opts.binaryPath, opts.args, {
      env: opts.env,
      stdio: ['pipe', opts.verboseLogFd, opts.verboseLogFd],
    });

    // Feed stdin
    if (child.stdin) {
      child.stdin.write(opts.stdinData);
      child.stdin.end();
    }

    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (opts.timeoutSeconds > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        // Give the process a moment to exit gracefully, then SIGKILL
        setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // already exited
          }
        }, 5000);
      }, opts.timeoutSeconds * 1000);
    }

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        resolve(TIMEOUT_EXIT_CODE);
      } else {
        resolve(code ?? 1);
      }
    });

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      core.error(`Failed to spawn docker-agent: ${err.message}`);
      resolve(1);
    });
  });
}

/**
 * Register all non-empty secrets with core.setSecret() to prevent
 * accidental log exposure. Must be called BEFORE any exec/spawn.
 */
function maskSecrets(opts: RunAgentOptions): void {
  const secrets = [
    opts.anthropicApiKey,
    opts.openaiApiKey,
    opts.googleApiKey,
    opts.awsBearerTokenBedrock,
    opts.xaiApiKey,
    opts.nebiusApiKey,
    opts.mistralApiKey,
    opts.ghToken,
  ];
  for (const secret of secrets) {
    if (secret) {
      core.setSecret(secret);
    }
  }
}

/**
 * Build the env object for the agent child process.
 * All API keys go here — never in argv.
 */
function buildEnv(opts: RunAgentOptions): Record<string, string> {
  // Start with the current process env (provides GITHUB_*, HOME, PATH, etc.)
  const env: Record<string, string> = {};

  // Copy current environment
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) {
      env[k] = v;
    }
  }

  // Inject API keys
  if (opts.anthropicApiKey) env.ANTHROPIC_API_KEY = opts.anthropicApiKey;
  if (opts.openaiApiKey) env.OPENAI_API_KEY = opts.openaiApiKey;
  if (opts.googleApiKey) env.GOOGLE_API_KEY = opts.googleApiKey;
  if (opts.awsBearerTokenBedrock) env.AWS_BEARER_TOKEN_BEDROCK = opts.awsBearerTokenBedrock;
  if (opts.xaiApiKey) env.XAI_API_KEY = opts.xaiApiKey;
  if (opts.nebiusApiKey) env.NEBIUS_API_KEY = opts.nebiusApiKey;
  if (opts.mistralApiKey) env.MISTRAL_API_KEY = opts.mistralApiKey;
  if (opts.ghToken) env.GH_TOKEN = opts.ghToken;

  // Telemetry
  if (opts.telemetryTags) env.TELEMETRY_TAGS = opts.telemetryTags;

  return env;
}

/**
 * Run docker-agent with the full retry loop.
 */
export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  // Register secrets BEFORE any logging or exec
  maskSecrets(opts);

  const args = buildArgs({
    agent: opts.agent,
    yolo: opts.yolo,
    workingDir: opts.workingDir,
    extraArgs: opts.extraArgs,
    addPromptFiles: opts.addPromptFiles,
  });

  const env = buildEnv(opts);

  if (opts.debug) {
    core.debug(`docker-agent args (${args.length}): ${args.slice(0, -1).join(' ')} -`);
    core.debug(`Working directory: ${opts.workingDir}`);
    core.debug(`Verbose log: ${opts.verboseLogFile}`);
  }

  // Determine stdin data — prefer sanitized file
  let stdinData: Buffer;
  if (opts.promptCleanFile && fs.existsSync(opts.promptCleanFile)) {
    stdinData = fs.readFileSync(opts.promptCleanFile);
  } else {
    stdinData = Buffer.from(`${opts.promptInput}\n`, 'utf-8');
  }

  const startTime = Date.now();

  let noRetryRegex: RegExp | null = null;
  if (opts.noRetryPattern) {
    try {
      noRetryRegex = new RegExp(opts.noRetryPattern);
    } catch {
      core.warning(`Invalid no-retry-pattern /${opts.noRetryPattern}/ - ignoring it`);
    }
  }

  const deadline =
    opts.totalTimeout > 0 ? startTime + opts.totalTimeout * 1000 : Number.POSITIVE_INFINITY;

  let exitCode = 1;
  let totalAttempt = 0;
  // Track the two retry budgets independently so mixed-failure sequences
  // (e.g. a non-timeout failure followed by a timeout) consume only from
  // the correct budget and never silently exhaust the other.
  let failureRetryCount = 0;
  let timeoutRetryCount = 0;
  let currentDelay = opts.retryDelay;

  while (true) {
    totalAttempt++;

    if (totalAttempt > 1) {
      const retryLabel =
        exitCode === TIMEOUT_EXIT_CODE
          ? `Timeout retry ${timeoutRetryCount} of ${opts.retryOnTimeout}`
          : `Retry ${failureRetryCount} of ${opts.maxRetries}`;
      core.info(`🔄 ${retryLabel} (waiting ${currentDelay}s)...`);
      await sleep(currentDelay);
      currentDelay *= 2;

      // Reset verbose log separator for retry
      const separator = [
        '',
        `========== RETRY ATTEMPT ${totalAttempt} (${new Date().toISOString()}) ==========`,
        '',
      ].join(os.EOL);
      fs.appendFileSync(opts.verboseLogFile, separator, 'utf-8');
    }

    // Cap the attempt to whatever remains of the total budget so the loop can
    // never outlive it (a runner-enforced kill keeps job-level cleanup alive).
    // Clamped to >= 1 s: a zero/negative value would disable spawnAgent's timer.
    let attemptTimeout = opts.timeout;
    if (deadline !== Number.POSITIVE_INFINITY) {
      const remaining = Math.max((deadline - Date.now()) / 1000, 1);
      attemptTimeout = opts.timeout > 0 ? Math.min(opts.timeout, remaining) : remaining;
    }

    // Open verbose log fd for appending
    const verboseLogFd = fs.openSync(opts.verboseLogFile, 'a');

    try {
      exitCode = await spawnAgent({
        binaryPath: opts.dockerAgentPath,
        args,
        env,
        stdinData,
        verboseLogFd,
        timeoutSeconds: attemptTimeout,
      });
    } finally {
      fs.closeSync(verboseLogFd);
    }

    if (exitCode === 0) {
      break; // Success
    }

    if (exitCode === TIMEOUT_EXIT_CODE) {
      core.error(`Agent execution timed out after ${Math.round(attemptTimeout)} seconds`);
      if (timeoutRetryCount >= opts.retryOnTimeout) {
        break; // Timeout retry budget exhausted
      }
    } else if (failureRetryCount >= opts.maxRetries) {
      core.warning(`Agent failed after ${opts.maxRetries} retries (exit code: ${exitCode})`);
      break;
    }

    // A retry is available. Cross-cutting guards run before a retry budget is
    // consumed so a skipped retry never counts against either budget.
    if (noRetryRegex && verboseLogMatches(opts.verboseLogFile, noRetryRegex)) {
      core.warning(
        'Skipping retry: verbose log matches no-retry-pattern (a side effect of the failed attempt may already be committed)',
      );
      break;
    }
    if (deadline !== Number.POSITIVE_INFINITY) {
      const remainingAfterDelay = (deadline - Date.now()) / 1000 - currentDelay;
      if (remainingAfterDelay < MIN_RETRY_BUDGET_SECONDS) {
        core.warning(
          `Skipping retry: less than ${MIN_RETRY_BUDGET_SECONDS}s of the ${opts.totalTimeout}s total-timeout budget remains`,
        );
        break;
      }
    }

    if (exitCode === TIMEOUT_EXIT_CODE) {
      timeoutRetryCount++;
      core.warning(
        `Timeout — will retry (${timeoutRetryCount}/${opts.retryOnTimeout} timeout retries used)`,
      );
    } else {
      failureRetryCount++;
      core.warning(`Agent failed (exit code: ${exitCode}), will retry...`);
    }
  }

  const executionTime = Math.round((Date.now() - startTime) / 1000);

  if (opts.debug) {
    core.debug(`Exit code: ${exitCode}`);
    core.debug(`Execution time: ${executionTime}s`);
  }

  return { exitCode, executionTime, verboseLogFile: opts.verboseLogFile };
}
