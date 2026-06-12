// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * outputs.ts — clean agent output by stripping tool-call noise.
 *
 * Faithful TypeScript port of the awk state machine in the `Run Docker Agent`
 * step of the original composite action.yml.  The filter removes:
 *
 *   - <thinking>…</thinking> and [thinking]…[/thinking] blocks
 *   - Thinking: lines
 *   - --- Tool: … blocks (multi-line, until next --- Tool:|--- Agent:|blank)
 *   - Calling <fn>( … ) blocks
 *   - <fn> response → … ) blocks
 *   - --- Agent: lines
 *   - time=, level=, msg= structured log lines
 *   - > [!NOTE] lines
 *   - "For any feedback", "transfer_task", "Delegating to", "Task delegated" lines
 *   - Leading blank lines (before any content has been seen)
 *
 * Additionally, if a ```docker-agent-output … ``` fenced block is present in
 * the cleaned text, only the content of that block is kept (overrides the awk
 * filter result).
 */

/** Possible states for the awk-equivalent state machine. */
type State = 'normal' | 'inThinking' | 'inThinkingBracket' | 'inTool' | 'inCall' | 'inResp';

/**
 * Filter verbose agent log lines into clean, user-facing output.
 *
 * @param raw  The full content of the verbose log file (as a string).
 * @returns    The cleaned output string.
 */
export function filterAgentOutput(raw: string): string {
  const lines = raw.split('\n');
  const out: string[] = [];
  let state: State = 'normal';
  let seenContent = false;

  for (const line of lines) {
    // ── Thinking blocks (HTML tags) ──────────────────────────────────────
    if (state === 'inThinking') {
      if (/<\/thinking>/i.test(line)) {
        state = 'normal';
      }
      continue;
    }
    if (/<thinking>/i.test(line)) {
      // If the closing tag is on the same line, skip and stay normal.
      if (/<\/thinking>/i.test(line)) {
        continue;
      }
      state = 'inThinking';
      continue;
    }

    // ── Thinking blocks (bracket style) ─────────────────────────────────
    if (state === 'inThinkingBracket') {
      if (/^\[\/thinking\]/.test(line)) {
        state = 'normal';
      }
      continue;
    }
    if (/^\[thinking\]/.test(line)) {
      if (/^\[\/thinking\]/.test(line)) {
        continue;
      }
      state = 'inThinkingBracket';
      continue;
    }

    // ── Thinking: line ───────────────────────────────────────────────────
    if (/^Thinking:/.test(line)) {
      continue;
    }

    // ── --- Tool: block ──────────────────────────────────────────────────
    if (state === 'inTool') {
      // End on blank line (drop it — matches awk `next`) or next Tool:/Agent: header.
      if (line.trim() === '') {
        state = 'normal';
        continue; // drop the blank line, matching awk `next`
      }
      if (/^--- (Tool:|Agent:)/.test(line)) {
        state = 'normal';
        // fall through — re-evaluate the header line below
      } else {
        continue;
      }
    }
    if (/^--- Tool:/.test(line)) {
      state = 'inTool';
      continue;
    }

    // ── Calling <fn>( … ) block ──────────────────────────────────────────
    if (state === 'inCall') {
      if (/^\)$/.test(line)) {
        state = 'normal';
      }
      continue;
    }
    if (/^Calling [a-zA-Z_]+\(/.test(line)) {
      state = 'inCall';
      continue;
    }

    // ── <fn> response → … ) block ────────────────────────────────────────
    if (state === 'inResp') {
      if (/^\)$/.test(line)) {
        state = 'normal';
      }
      continue;
    }
    if (/^[a-zA-Z_]+ response →/.test(line)) {
      state = 'inResp';
      continue;
    }

    // ── Single-line noise ────────────────────────────────────────────────
    if (/^--- Agent:/.test(line)) continue;
    if (/^time=/.test(line)) continue;
    if (/^level=/.test(line)) continue;
    if (/^msg=/.test(line)) continue;
    if (/^> \[!NOTE\]/.test(line)) continue;
    if (/For any feedback/.test(line)) continue;
    if (/transfer_task/.test(line)) continue;
    if (/Delegating to/.test(line)) continue;
    if (/Task delegated/.test(line)) continue;

    // ── Leading blank lines ──────────────────────────────────────────────
    if (line.trim() === '' && !seenContent) {
      continue;
    }

    if (line.trim() !== '') {
      seenContent = true;
    }

    out.push(line);
  }

  return out.join('\n');
}

/**
 * Extract content from a ```docker-agent-output … ``` fenced block, if present.
 * Returns `null` if no such block exists or the extracted block is empty.
 *
 * This mirrors the awk extraction in the `Sanitize output` step:
 *   - The fence opener may appear anywhere on a line (mid-line is allowed).
 *   - Extraction stops at the first closing ``` on its own line.
 */
export function extractDockerAgentOutputBlock(text: string): string | null {
  const lines = text.split('\n');
  const extracted: string[] = [];
  let capturing = false;

  for (const line of lines) {
    if (!capturing) {
      if (line.includes('```docker-agent-output')) {
        capturing = true;
      }
      continue;
    }
    // Closing fence: a line that is exactly ``` (possibly trailing whitespace)
    if (/^```\s*$/.test(line)) {
      capturing = false;
      continue;
    }
    extracted.push(line);
  }

  const result = extracted.join('\n').trim();
  return result.length > 0 ? result : null;
}

/**
 * Post-process the verbose agent log into clean user-facing output.
 *
 * 1. Run the awk-equivalent filter.
 * 2. If a ```docker-agent-output block is present, replace the output with
 *    just the block contents (agent's explicitly formatted answer takes priority).
 *
 * @param raw  Full contents of the verbose log file.
 * @returns    Clean output string.
 */
export function processAgentOutput(raw: string): string {
  const filtered = filterAgentOutput(raw);

  const block = extractDockerAgentOutputBlock(filtered);
  if (block !== null) {
    return block;
  }

  return filtered;
}
