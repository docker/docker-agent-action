// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for src/main/summary.ts
 *
 * Verifies writeJobSummary calls the core.summary chaining API correctly
 * for all exit-code statuses and optional outputFile scenarios.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock @actions/core with a chainable summary ───────────────────────────────

const { mockSummary } = vi.hoisted(() => {
  const mockSummary = {
    addHeading: vi.fn(),
    addRaw: vi.fn(),
    addTable: vi.fn(),
    write: vi.fn().mockResolvedValue(undefined),
  };
  mockSummary.addHeading.mockReturnValue(mockSummary);
  mockSummary.addRaw.mockReturnValue(mockSummary);
  mockSummary.addTable.mockReturnValue(mockSummary);
  return { mockSummary };
});

vi.mock('@actions/core', () => ({
  summary: mockSummary,
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  setOutput: vi.fn(),
  setSecret: vi.fn(),
  setFailed: vi.fn(),
  getInput: vi.fn().mockReturnValue(''),
  getBooleanInput: vi.fn().mockReturnValue(false),
}));

import { writeJobSummary } from '../summary.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir: string;

const BASE_OPTS = {
  agent: 'docker/test-agent',
  exitCode: 0,
  executionTime: 42,
  dockerAgentVersion: 'v1.54.0',
  mcpInstalled: false,
  timeout: 0,
};

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'summary-test-'));
  vi.clearAllMocks();
  mockSummary.addHeading.mockReturnValue(mockSummary);
  mockSummary.addRaw.mockReturnValue(mockSummary);
  mockSummary.addTable.mockReturnValue(mockSummary);
  mockSummary.write.mockResolvedValue(undefined);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── Exit-code status lines ────────────────────────────────────────────────────

describe('writeJobSummary — status line', () => {
  it('shows success status for exit code 0', async () => {
    await writeJobSummary({ ...BASE_OPTS, exitCode: 0 });

    const rawCalls = mockSummary.addRaw.mock.calls.flat() as string[];
    expect(rawCalls.some((c) => c.includes('✅'))).toBe(true);
    expect(rawCalls.some((c) => c.includes('Success'))).toBe(true);
  });

  it('shows timeout status for exit code 124', async () => {
    await writeJobSummary({ ...BASE_OPTS, exitCode: 124 });

    const rawCalls = mockSummary.addRaw.mock.calls.flat() as string[];
    expect(rawCalls.some((c) => c.includes('⏱️'))).toBe(true);
    expect(rawCalls.some((c) => c.includes('Timeout'))).toBe(true);
  });

  it('shows failed status for non-zero exit code', async () => {
    await writeJobSummary({ ...BASE_OPTS, exitCode: 1 });

    const rawCalls = mockSummary.addRaw.mock.calls.flat() as string[];
    expect(rawCalls.some((c) => c.includes('❌'))).toBe(true);
    expect(rawCalls.some((c) => c.includes('Failed'))).toBe(true);
  });
});

// ── Summary table ─────────────────────────────────────────────────────────────

describe('writeJobSummary — table rows', () => {
  it('calls addTable with header row and at least 5 data rows', async () => {
    await writeJobSummary(BASE_OPTS);

    expect(mockSummary.addTable).toHaveBeenCalledOnce();
    const tableArg = mockSummary.addTable.mock.calls[0][0] as unknown[][];
    // First row = header [Property, Value]
    expect(tableArg[0]).toEqual([
      { data: 'Property', header: true },
      { data: 'Value', header: true },
    ]);
    // At least 5 data rows (Agent, Exit Code, Execution Time, Docker Agent Version, MCP Gateway)
    expect(tableArg.length).toBeGreaterThanOrEqual(6);
  });

  it('includes timeout row when timeout > 0', async () => {
    await writeJobSummary({ ...BASE_OPTS, timeout: 300 });

    const tableArg = mockSummary.addTable.mock.calls[0][0] as { data: string }[][];
    const flatData = tableArg.flat().map((cell) => cell.data);
    expect(flatData.some((d) => d.includes('Timeout'))).toBe(true);
    expect(flatData.some((d) => d.includes('300s'))).toBe(true);
  });

  it('omits timeout row when timeout is 0', async () => {
    await writeJobSummary({ ...BASE_OPTS, timeout: 0 });

    const tableArg = mockSummary.addTable.mock.calls[0][0] as { data: string }[][];
    const flatData = tableArg.flat().map((cell) => cell.data);
    expect(flatData.some((d) => d.includes('Timeout'))).toBe(false);
  });
});

// ── Output file section ───────────────────────────────────────────────────────

describe('writeJobSummary — outputFile', () => {
  it('appends agent output section when outputFile has content', async () => {
    const outputFile = join(tmpDir, 'output.txt');
    await writeFile(outputFile, '## Review\n\nLooks good!', 'utf-8');

    await writeJobSummary({ ...BASE_OPTS, outputFile });

    const rawCalls = mockSummary.addRaw.mock.calls.flat() as string[];
    expect(rawCalls.some((c) => c.includes('Agent Output'))).toBe(true);
    expect(rawCalls.some((c) => c.includes('Looks good!'))).toBe(true);
  });

  it('skips output section when outputFile is empty', async () => {
    const outputFile = join(tmpDir, 'output.txt');
    await writeFile(outputFile, '', 'utf-8');

    await writeJobSummary({ ...BASE_OPTS, outputFile });

    const rawCalls = mockSummary.addRaw.mock.calls.flat() as string[];
    expect(rawCalls.some((c) => c.includes('Agent Output'))).toBe(false);
  });

  it('skips output section when outputFile does not exist', async () => {
    const outputFile = join(tmpDir, 'nonexistent.txt');

    await writeJobSummary({ ...BASE_OPTS, outputFile });

    const rawCalls = mockSummary.addRaw.mock.calls.flat() as string[];
    expect(rawCalls.some((c) => c.includes('Agent Output'))).toBe(false);
  });

  it('skips output section when no outputFile provided', async () => {
    await writeJobSummary(BASE_OPTS);

    const rawCalls = mockSummary.addRaw.mock.calls.flat() as string[];
    expect(rawCalls.some((c) => c.includes('Agent Output'))).toBe(false);
  });

  it('calls summary.write() exactly once', async () => {
    await writeJobSummary(BASE_OPTS);
    expect(mockSummary.write).toHaveBeenCalledOnce();
  });

  it('adds heading "Docker Agent Execution Summary"', async () => {
    await writeJobSummary(BASE_OPTS);
    expect(mockSummary.addHeading).toHaveBeenCalledWith('Docker Agent Execution Summary', 2);
  });
});
