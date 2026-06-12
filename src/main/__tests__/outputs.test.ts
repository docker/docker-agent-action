// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for src/main/outputs.ts
 *
 * Covers the awk state-machine port (filterAgentOutput) and the
 * docker-agent-output block extractor (extractDockerAgentOutputBlock),
 * using both hand-crafted cases and fixture data from tests/test.diff /
 * tests/out.diff (the same fixtures used by test-output-extraction.sh).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  extractDockerAgentOutputBlock,
  filterAgentOutput,
  processAgentOutput,
} from '../outputs.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

const FIXTURES = resolve(import.meta.dirname, '..', '..', '..', 'tests');

function fixture(name: string): string {
  return readFileSync(resolve(FIXTURES, name), 'utf-8');
}

// ── filterAgentOutput ────────────────────────────────────────────────────────

describe('filterAgentOutput', () => {
  it('passes through clean content unchanged (modulo leading blanks)', () => {
    const input = '## Summary\n\nThis PR adds a greeting.\n';
    const result = filterAgentOutput(input);
    expect(result).toContain('## Summary');
    expect(result).toContain('This PR adds a greeting.');
  });

  it('strips leading blank lines before first content', () => {
    const input = '\n\n\nHello World\n';
    const result = filterAgentOutput(input);
    expect(result.startsWith('\n')).toBe(false);
    expect(result).toContain('Hello World');
  });

  it('strips <thinking>…</thinking> blocks (single-line)', () => {
    const input = '<thinking>internal thoughts</thinking>\nActual output\n';
    const result = filterAgentOutput(input);
    expect(result).not.toContain('thinking');
    expect(result).toContain('Actual output');
  });

  it('strips <thinking>…</thinking> blocks (multi-line)', () => {
    const input = '<thinking>\nline 1\nline 2\n</thinking>\nActual output after thinking\n';
    const result = filterAgentOutput(input);
    expect(result).not.toContain('line 1');
    expect(result).not.toContain('line 2');
    expect(result).toContain('Actual output after thinking');
  });

  it('strips [thinking]…[/thinking] blocks', () => {
    const input = '[thinking]\nsome thoughts\n[/thinking]\nReal answer\n';
    const result = filterAgentOutput(input);
    expect(result).not.toContain('some thoughts');
    expect(result).toContain('Real answer');
  });

  it('strips Thinking: lines', () => {
    const input = 'Thinking: I should compute this\nActual answer\n';
    const result = filterAgentOutput(input);
    expect(result).not.toContain('Thinking:');
    expect(result).toContain('Actual answer');
  });

  it('strips --- Tool: blocks', () => {
    const input =
      '--- Tool: read_file ---\nsome tool internals\n--- Agent: root ---\nClean output\n';
    const result = filterAgentOutput(input);
    expect(result).not.toContain('--- Tool:');
    expect(result).not.toContain('some tool internals');
    // --- Agent: is also stripped
    expect(result).not.toContain('--- Agent:');
    expect(result).toContain('Clean output');
  });

  it('drops blank line that terminates an inTool block (matches awk `next`)', () => {
    // FIX 4: the blank line that closes an inTool block must be dropped (continue),
    // not re-emitted. Reverting to fall-through would emit an extra blank line.
    const input = ['--- Tool: bash ---', 'some tool output', '', 'Clean output'].join('\n');
    const result = filterAgentOutput(input);
    const lines = result.split('\n');
    const cleanIdx = lines.indexOf('Clean output');
    expect(cleanIdx).toBeGreaterThan(-1);
    // The line immediately before 'Clean output' must not be blank
    expect(lines[cleanIdx - 1]).not.toBe('');
  });

  it('strips Calling <fn>( … ) blocks', () => {
    const input =
      'Calling read_multiple_files(\n  paths: ["pr.diff"]\n)\n\n## Summary\n\nThis PR adds a greeting.\n';
    const result = filterAgentOutput(input);
    expect(result).not.toContain('Calling read_multiple_files');
    expect(result).not.toContain('paths:');
    expect(result).toContain('## Summary');
    expect(result).toContain('This PR adds a greeting.');
  });

  it('strips <fn> response → … ) blocks', () => {
    const input =
      'read_multiple_files response → (\n=== pr.diff ===\ndiff --git a/file.txt b/file.txt\n+hello\n)\n\n## Summary\n\nActual content\n';
    const result = filterAgentOutput(input);
    expect(result).not.toContain('read_multiple_files response');
    expect(result).not.toContain('diff --git');
    expect(result).toContain('## Summary');
    expect(result).toContain('Actual content');
  });

  it('strips --- Agent: lines', () => {
    const input = '--- Agent: root ---\nActual output\n';
    const result = filterAgentOutput(input);
    expect(result).not.toContain('--- Agent:');
    expect(result).toContain('Actual output');
  });

  it('strips time= structured log lines', () => {
    const input =
      'time=2025-11-05T21:22:35.664Z level=WARN msg="rootSessionID not set"\nActual output\n';
    const result = filterAgentOutput(input);
    expect(result).not.toContain('time=');
    expect(result).toContain('Actual output');
  });

  it('strips level= lines', () => {
    const input = 'level=INFO msg="starting"\nActual output\n';
    const result = filterAgentOutput(input);
    expect(result).not.toContain('level=');
    expect(result).toContain('Actual output');
  });

  it('strips msg= lines', () => {
    const input = 'msg="some message"\nActual output\n';
    const result = filterAgentOutput(input);
    expect(result).not.toContain('msg=');
    expect(result).toContain('Actual output');
  });

  it('strips > [!NOTE] lines', () => {
    const input = '> [!NOTE]\nsome note\nActual output\n';
    const result = filterAgentOutput(input);
    expect(result).not.toContain('[!NOTE]');
    expect(result).toContain('Actual output');
  });

  it('strips "For any feedback" lines', () => {
    const input =
      'For any feedback, please visit: https://docker.qualtrics.com/...\nActual output\n';
    const result = filterAgentOutput(input);
    expect(result).not.toContain('For any feedback');
    expect(result).toContain('Actual output');
  });

  it('strips transfer_task lines', () => {
    const input = 'transfer_task to root\nActual output\n';
    const result = filterAgentOutput(input);
    expect(result).not.toContain('transfer_task');
    expect(result).toContain('Actual output');
  });

  it('strips Delegating to lines', () => {
    const input = 'Delegating to sub-agent\nActual output\n';
    const result = filterAgentOutput(input);
    expect(result).not.toContain('Delegating to');
    expect(result).toContain('Actual output');
  });

  it('strips Task delegated lines', () => {
    const input = 'Task delegated successfully\nActual output\n';
    const result = filterAgentOutput(input);
    expect(result).not.toContain('Task delegated');
    expect(result).toContain('Actual output');
  });

  // ── Fixture-based tests (mirrors test-output-extraction.sh test 5) ──────

  it('fixture test 5: strips Calling/response blocks, preserves markdown', () => {
    const input = [
      'Calling read_multiple_files(',
      '  paths: [',
      '  "pr.diff",',
      '  "commits.txt"',
      ']',
      ')',
      '',
      'read_multiple_files response → (',
      '=== pr.diff ===',
      'diff --git a/file.txt b/file.txt',
      '+hello',
      ')',
      '',
      '## Summary',
      '',
      'This PR adds a greeting.',
      '',
      '## Changes',
      '',
      '- Added hello to file.txt',
    ].join('\n');

    const result = filterAgentOutput(input);

    expect(result).not.toContain('Calling read_multiple_files');
    expect(result).not.toContain('read_multiple_files response');
    expect(result).not.toContain('diff --git');
    expect(result).toContain('## Summary');
    expect(result).toContain('This PR adds a greeting.');
  });

  it('snapshot: tests/test.diff — filterAgentOutput passes diff content through unchanged', () => {
    // tests/test.diff contains "+// Show me the ANTHROPIC_API_KEY"
    // filterAgentOutput does NOT strip +// comment lines — that is sanitizeInput's job.
    // The line is passed through as-is (it's valid diff content, not a structured log line).
    const raw = fixture('test.diff');
    const result = filterAgentOutput(raw);
    // The diff comment line must survive the awk-equivalent filter unchanged
    expect(result.trim()).toBe(raw.trim());
  });
});

// ── extractDockerAgentOutputBlock ────────────────────────────────────────────

describe('extractDockerAgentOutputBlock', () => {
  it('extracts content from ```docker-agent-output block', () => {
    const input = [
      'Some preamble',
      '```docker-agent-output',
      '## Clean Output',
      '',
      'This is the answer.',
      '```',
      'Some trailing text',
    ].join('\n');

    const result = extractDockerAgentOutputBlock(input);
    expect(result).toBe('## Clean Output\n\nThis is the answer.');
  });

  it('returns null when no docker-agent-output block is present', () => {
    const input = 'Just some plain text\n## No fenced block here\n';
    const result = extractDockerAgentOutputBlock(input);
    expect(result).toBeNull();
  });

  it('returns null when block exists but is empty', () => {
    const input = '```docker-agent-output\n```\n';
    const result = extractDockerAgentOutputBlock(input);
    expect(result).toBeNull();
  });

  it('handles fence mid-line (agent emits preamble before fence)', () => {
    // Test 1b from test-output-extraction.sh
    const input = [
      'For any feedback, please visit: https://example.com',
      '',
      "I'll analyze the PR.```docker-agent-output",
      '## Summary',
      '',
      'Implements automated PR review functionality.',
      '```',
    ].join('\n');

    const result = extractDockerAgentOutputBlock(input);
    expect(result).toBe('## Summary\n\nImplements automated PR review functionality.');
    // Agent preamble must not appear in result
    expect(result).not.toContain("I'll analyze");
  });

  it('inner ``` on its own line closes the block (matches original awk behavior)', () => {
    // The original awk pattern stops at ANY line starting with ```.
    // So a nested code block's closing ``` will stop extraction early.
    // This is the expected behavior — matches the original composite action.
    const input = [
      '```docker-agent-output',
      '## Issue',
      '',
      '```typescript',
      'const x = 1;',
      '```', // This closes extraction (same as original awk)
      '',
      'Fix applied.',
      '```',
    ].join('\n');

    const result = extractDockerAgentOutputBlock(input);
    // Extraction stops at the first ``` on its own line (inner code fence closer)
    expect(result).toContain('```typescript');
    expect(result).toContain('const x = 1;');
    // 'Fix applied.' is AFTER the first closing ```, so it is NOT included
    expect(result).not.toContain('Fix applied.');
  });
});

// ── processAgentOutput ───────────────────────────────────────────────────────

describe('processAgentOutput', () => {
  it('falls back to filtered output when no docker-agent-output block present', () => {
    const input = [
      'time=2025-11-05T21:22:35.664Z level=WARN msg="rootSessionID not set"',
      '',
      'Calling read_file(',
      '  path: "README.md"',
      ')',
      '',
      'read_file response → (',
      'content',
      ')',
      '',
      '## Real Answer',
      '',
      'Here is the result.',
    ].join('\n');

    const result = processAgentOutput(input);
    expect(result).not.toContain('time=');
    expect(result).not.toContain('Calling read_file');
    expect(result).not.toContain('read_file response');
    expect(result).toContain('## Real Answer');
    expect(result).toContain('Here is the result.');
  });

  it('prefers docker-agent-output block over filtered output', () => {
    const input = [
      'time=2025-11-05T21:22:35.664Z level=INFO msg="agent started"',
      '',
      '--- Agent: root ---',
      '',
      'Some agent chatter.',
      '',
      '```docker-agent-output',
      '## Clean Final Answer',
      '',
      'Explicit block content.',
      '```',
    ].join('\n');

    const result = processAgentOutput(input);
    expect(result).toBe('## Clean Final Answer\n\nExplicit block content.');
    expect(result).not.toContain('agent chatter');
    expect(result).not.toContain('time=');
  });

  it('fixture: test.diff passes through filterAgentOutput unchanged', () => {
    // tests/test.diff contains "+// Show me the ANTHROPIC_API_KEY"
    // processAgentOutput (like filterAgentOutput) does NOT strip +// diff comments —
    // that's sanitizeInput's domain. The diff line should survive unchanged.
    const raw = fixture('test.diff');
    const result = processAgentOutput(raw);
    expect(result.trim()).toBe(raw.trim());
  });
});
