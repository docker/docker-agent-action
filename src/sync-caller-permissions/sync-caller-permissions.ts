// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * sync-caller-permissions — raises a consumer workflow's `permissions:` grants
 * to what the pinned reusable PR-review workflow requires from its caller.
 *
 * A called workflow cannot elevate its caller's permissions: when a release
 * raises what review-pr.yml requests (issue #72: v2.0.3 raised `actions` from
 * read to write), merging a version-bump PR breaks every caller still granting
 * the old level — GitHub rejects the run at startup validation. The
 * update-consumers workflow therefore runs this tool right after re-pinning a
 * consumer's `uses:` ref, so the same PR also fixes the caller's grant.
 *
 * The comparison is absolute (target requirement vs what the consumer grants),
 * not a version diff — a consumer that was already under-granting gets fixed
 * regardless of which version it is coming from.
 *
 * Only the block that applies to the calling job is touched (its own
 * `permissions:` block, else the workflow-level one — a job block REPLACES the
 * workflow block, they are not merged), and only upward: grants above the
 * requirement are never reduced. Everything else in the file is preserved
 * byte-for-byte. Cases that cannot be edited safely are reported as `manual`
 * instead of guessed:
 *
 *   - no explicit `permissions:` block anywhere: the effective grant is the
 *     repo/org default, which is unknowable here — inventing a block could
 *     REDUCE effective permissions (unlisted scopes become none).
 *   - a `read-all` shorthand with a write-level requirement: rewriting the
 *     shorthand into a block map is too invasive for an automated PR.
 *
 * The requirement side reuses the caller-permissions extractor (also used by
 * the release-notes breaking-change safeguard) so both tools can never
 * disagree on what a release requires.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  type AccessLevel,
  ALL_SCOPES,
  computeCallerRequirement,
  type PermissionsMap,
  parseWorkflowPermissions,
} from '../caller-permissions/caller-permissions.js';

/** `uses:` marker identifying a job that calls the reusable PR-review workflow. */
export const REUSABLE_WORKFLOW_REF = 'docker/docker-agent-action/.github/workflows/review-pr.yml@';

const LEVEL_RANK: Record<AccessLevel, number> = { none: 0, read: 1, write: 2 };

export interface AppliedIncrease {
  /** `workflow` for the workflow-level block, `job:<id>` for a job-level block. */
  block: string;
  scope: string;
  from: AccessLevel;
  to: AccessLevel;
}

export interface ManualIncrease {
  /** `job:<id>` of the calling job (or the block owner when a block exists but is uneditable). */
  block: string;
  scope: string;
  /** `unknown` when no explicit block exists (the repo/org default applies). */
  from: AccessLevel | 'unknown';
  to: AccessLevel;
}

export interface SyncResult {
  /** Rewritten file content. Identical to the input when nothing was applied. */
  content: string;
  changed: boolean;
  /** Increases edited into the file. */
  applied: AppliedIncrease[];
  /** Increases that are required but could not be edited safely. */
  manual: ManualIncrease[];
}

// ---------------------------------------------------------------------------
// Consumer-side scanner (line positions retained for in-place editing)
// ---------------------------------------------------------------------------

interface ScanLine {
  indent: number;
  /** Trimmed text with any trailing \r removed (never blank / whole-line comment). */
  text: string;
  /** Index into the raw line array (0-based). */
  idx: number;
}

type BlockKind = 'block-map' | 'inline-map' | 'read-all' | 'write-all';

interface BlockEntry {
  lineIdx: number;
  scope: string;
  level: AccessLevel;
}

interface PermissionsBlock {
  owner: string;
  kind: BlockKind;
  keyLineIdx: number;
  entries: BlockEntry[];
  /** Indent for inserted entries (block-map only). */
  entryIndent: number;
  /** Granted scopes (ALL_SCOPES pseudo-scope for the shorthands). */
  map: PermissionsMap;
}

interface JobScan {
  id: string;
  callsReusable: boolean;
  block: PermissionsBlock | undefined;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function significantLines(rawLines: string[]): ScanLine[] {
  const out: ScanLine[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const noCr = rawLines[i].endsWith('\r') ? rawLines[i].slice(0, -1) : rawLines[i];
    const text = noCr.trim();
    if (text === '' || text.startsWith('#')) continue;
    out.push({ indent: noCr.length - noCr.trimStart().length, text, idx: i });
  }
  return out;
}

/** Strip a trailing ` # comment` (YAML requires whitespace before an inline `#`). */
function stripTrailingComment(text: string): string {
  return text.replace(/(?:^|\s)#.*$/, '').trim();
}

const KEY_RE = /^([A-Za-z_][A-Za-z0-9_-]*):(?:\s+(.*))?$/;

function matchKey(text: string): { key: string; rest: string } | null {
  const m = text.match(KEY_RE);
  if (!m) return null;
  return { key: m[1], rest: stripTrailingComment(m[2] ?? '') };
}

function parseAccessLevel(token: string, lineIdx: number): AccessLevel {
  const unquoted = token.replace(/^(['"])(.*)\1$/, '$2');
  if (unquoted === 'none' || unquoted === 'read' || unquoted === 'write') return unquoted;
  throw new Error(
    `Unrecognized permission level "${token}" at line ${lineIdx + 1} (expected none, read, or write)`,
  );
}

/** Parse the ordered entries of an inline `{scope: level, …}` map. */
function parseInlineEntries(
  value: string,
  lineIdx: number,
): Array<{ scope: string; level: AccessLevel }> {
  const inner = value.slice(1, -1).trim();
  if (inner === '') return [];
  return inner.split(',').map((part) => {
    const m = part.trim().match(/^(['"]?)([A-Za-z][A-Za-z0-9_-]*)\1:\s*(\S+)$/);
    if (!m) {
      throw new Error(`Malformed inline permissions entry "${part.trim()}" at line ${lineIdx + 1}`);
    }
    return { scope: m[2], level: parseAccessLevel(m[3], lineIdx) };
  });
}

/** Parse the permissions block whose key sits at lines[keyPos]. Returns the next scan position. */
function parseBlockAt(
  lines: ScanLine[],
  keyPos: number,
  inlineValue: string,
  owner: string,
): { block: PermissionsBlock; nextPos: number } {
  const keyLine = lines[keyPos];
  const base: Omit<PermissionsBlock, 'kind' | 'map'> = {
    owner,
    keyLineIdx: keyLine.idx,
    entries: [],
    entryIndent: keyLine.indent + 2,
  };

  if (inlineValue !== '') {
    if (inlineValue === 'read-all') {
      return {
        block: { ...base, kind: 'read-all', map: { [ALL_SCOPES]: 'read' } },
        nextPos: keyPos + 1,
      };
    }
    if (inlineValue === 'write-all') {
      return {
        block: { ...base, kind: 'write-all', map: { [ALL_SCOPES]: 'write' } },
        nextPos: keyPos + 1,
      };
    }
    if (inlineValue.startsWith('{') && inlineValue.endsWith('}')) {
      const map: PermissionsMap = {};
      for (const { scope, level } of parseInlineEntries(inlineValue, keyLine.idx)) {
        map[scope] = level;
      }
      return { block: { ...base, kind: 'inline-map', map }, nextPos: keyPos + 1 };
    }
    throw new Error(`Unrecognized permissions value "${inlineValue}" at line ${keyLine.idx + 1}`);
  }

  const entries: BlockEntry[] = [];
  const map: PermissionsMap = {};
  let i = keyPos + 1;
  while (i < lines.length && lines[i].indent > keyLine.indent) {
    const entry = stripTrailingComment(lines[i].text);
    const m = entry.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(\S+)$/);
    if (!m) {
      throw new Error(
        `Malformed permissions entry at line ${lines[i].idx + 1}: "${lines[i].text}"`,
      );
    }
    const level = parseAccessLevel(m[2], lines[i].idx);
    entries.push({ lineIdx: lines[i].idx, scope: m[1], level });
    map[m[1]] = level;
    i++;
  }
  const entryIndent = entries.length > 0 ? lines[i - entries.length].indent : keyLine.indent + 2;
  return {
    block: { ...base, kind: 'block-map', entries, entryIndent, map },
    nextPos: i,
  };
}

/** Scan one job body; returns the next scan position. */
function scanJobBody(lines: ScanLine[], start: number, jobIndent: number, job: JobScan): number {
  let i = start;
  let childIndent = -1;
  while (i < lines.length && lines[i].indent > jobIndent) {
    const line = lines[i];
    // The first key inside the job fixes the direct-child indent; deeper
    // occurrences (step inputs, block-scalar content) never belong to the job.
    if (childIndent === -1) childIndent = line.indent;
    if (line.indent === childIndent) {
      const m = matchKey(line.text);
      if (m?.key === 'permissions') {
        const parsed = parseBlockAt(lines, i, m.rest, `job:${job.id}`);
        job.block = parsed.block;
        i = parsed.nextPos;
        continue;
      }
      if (m?.key === 'uses' && m.rest.includes(REUSABLE_WORKFLOW_REF)) {
        job.callsReusable = true;
      }
    }
    i++;
  }
  return i;
}

function scanJobs(lines: ScanLine[], start: number, out: JobScan[]): number {
  let i = start;
  let jobIndent = -1;
  while (i < lines.length && lines[i].indent > 0) {
    const line = lines[i];
    if (jobIndent === -1) jobIndent = line.indent;
    if (line.indent === jobIndent) {
      const m = matchKey(line.text);
      if (m) {
        const job: JobScan = { id: m.key, callsReusable: false, block: undefined };
        out.push(job);
        i = scanJobBody(lines, i + 1, jobIndent, job);
        continue;
      }
    }
    i++;
  }
  return i;
}

function scanConsumer(rawLines: string[]): {
  workflowBlock: PermissionsBlock | undefined;
  jobs: JobScan[];
} {
  const lines = significantLines(rawLines);
  let workflowBlock: PermissionsBlock | undefined;
  const jobs: JobScan[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent === 0) {
      const m = matchKey(line.text);
      if (m?.key === 'permissions') {
        const parsed = parseBlockAt(lines, i, m.rest, 'workflow');
        workflowBlock = parsed.block;
        i = parsed.nextPos;
        continue;
      }
      if (m?.key === 'jobs') {
        i = scanJobs(lines, i + 1, jobs);
        continue;
      }
    }
    i++;
  }
  return { workflowBlock, jobs };
}

// ---------------------------------------------------------------------------
// Edit planning and application
// ---------------------------------------------------------------------------

function effectiveGrant(map: PermissionsMap, scope: string): AccessLevel {
  const direct = map[scope] ?? 'none';
  if (scope === ALL_SCOPES) return direct;
  const wildcard = map[ALL_SCOPES] ?? 'none';
  return LEVEL_RANK[direct] >= LEVEL_RANK[wildcard] ? direct : wildcard;
}

/** Replace the level of a `scope: level` block-map line, preserving indent, quotes, and comment. */
function upgradeEntryLine(line: string, scope: string, to: AccessLevel): string | null {
  const re = new RegExp(
    `^(\\s*${escapeRegExp(scope)}:\\s*)(['"]?)(?:none|read|write)\\2((?:\\s+#.*)?\\s*)$`,
  );
  const m = line.match(re);
  if (!m) return null;
  return `${m[1]}${m[2]}${to}${m[2]}${m[3]}`;
}

/**
 * Rebuild an inline `permissions: {…}` value with upgrades applied and missing
 * scopes appended. Spacing inside the braces is normalized; the prefix and any
 * trailing comment are preserved. Returns null when the line shape is
 * unexpected (caller falls back to a manual report).
 */
function editInlineLine(
  line: string,
  lineIdx: number,
  upgrades: ReadonlyMap<string, AccessLevel>,
  additions: ReadonlyArray<{ scope: string; level: AccessLevel }>,
): string | null {
  const m = line.match(/^(\s*permissions:\s*)(\{[^}]*\})((?:\s+#.*)?\s*)$/);
  if (!m) return null;
  const entries = parseInlineEntries(m[2], lineIdx).map(({ scope, level }) => ({
    scope,
    level: upgrades.get(scope) ?? level,
  }));
  entries.push(...additions);
  const inner = entries.map(({ scope, level }) => `${scope}: ${level}`).join(', ');
  return `${m[1]}{${inner}}${m[3]}`;
}

/**
 * Raise the consumer's grants to `required`. Pure: returns the rewritten
 * content plus what was applied and what needs a manual follow-up.
 */
export function syncCallerPermissions(source: string, required: PermissionsMap): SyncResult {
  const rawLines = source.split('\n');
  const { workflowBlock, jobs } = scanConsumer(rawLines);
  const callers = jobs.filter((job) => job.callsReusable);

  const applied: AppliedIncrease[] = [];
  const manual: ManualIncrease[] = [];
  const requiredScopes = Object.keys(required).sort();

  if (callers.length === 0 || requiredScopes.length === 0) {
    return { content: source, changed: false, applied, manual };
  }

  // Dedupe by block position: several calling jobs may share the
  // workflow-level block, which must be edited (and reported) once.
  const blocks = new Map<number, PermissionsBlock>();
  for (const job of callers) {
    const block = job.block ?? workflowBlock;
    if (block === undefined) {
      // No explicit block: the repo/org default applies and cannot be
      // verified from here. Never invent a block — unlisted scopes would
      // drop to none and could break scopes the default currently grants.
      for (const scope of requiredScopes) {
        manual.push({ block: `job:${job.id}`, scope, from: 'unknown', to: required[scope] });
      }
      continue;
    }
    blocks.set(block.keyLineIdx, block);
  }

  const lineEdits = new Map<number, string>();
  const insertions: Array<{ afterIdx: number; text: string }> = [];

  for (const block of blocks.values()) {
    const needs = requiredScopes
      .map((scope) => ({ scope, from: effectiveGrant(block.map, scope), to: required[scope] }))
      .filter(({ from, to }) => LEVEL_RANK[to] > LEVEL_RANK[from]);
    if (needs.length === 0) continue;

    if (block.kind === 'read-all' || block.kind === 'write-all') {
      // Rewriting a shorthand into a block map is too invasive to automate.
      // (write-all can only get here for the ALL_SCOPES pseudo-requirement.)
      for (const need of needs) manual.push({ block: block.owner, ...need });
      continue;
    }

    // The ALL_SCOPES pseudo-requirement (reusable workflow declares read-all/
    // write-all) has no block-map representation — report it, never write `*:`.
    const editable = needs.filter((need) => need.scope !== ALL_SCOPES);
    for (const need of needs) {
      if (need.scope === ALL_SCOPES) manual.push({ block: block.owner, ...need });
    }

    if (block.kind === 'inline-map') {
      const upgrades = new Map<string, AccessLevel>();
      const additions: Array<{ scope: string; level: AccessLevel }> = [];
      for (const need of editable) {
        if (need.scope in block.map) upgrades.set(need.scope, need.to);
        else additions.push({ scope: need.scope, level: need.to });
      }
      const raw = rawLines[block.keyLineIdx];
      const hasCR = raw.endsWith('\r');
      const edited = editInlineLine(
        hasCR ? raw.slice(0, -1) : raw,
        block.keyLineIdx,
        upgrades,
        additions,
      );
      if (edited === null) {
        for (const need of editable) manual.push({ block: block.owner, ...need });
        continue;
      }
      lineEdits.set(block.keyLineIdx, hasCR ? `${edited}\r` : edited);
      for (const need of editable) applied.push({ block: block.owner, ...need });
      continue;
    }

    // block-map: upgrade existing entry lines in place, append missing scopes
    // after the last entry (or right after the key when the block is empty).
    const insertAfter =
      block.entries.length > 0 ? block.entries[block.entries.length - 1].lineIdx : block.keyLineIdx;
    const anchorHasCR = rawLines[insertAfter].endsWith('\r');
    for (const need of editable) {
      const entry = block.entries.find((e) => e.scope === need.scope);
      if (entry === undefined) {
        const text = `${' '.repeat(block.entryIndent)}${need.scope}: ${need.to}`;
        insertions.push({ afterIdx: insertAfter, text: anchorHasCR ? `${text}\r` : text });
        applied.push({ block: block.owner, ...need });
        continue;
      }
      const raw = rawLines[entry.lineIdx];
      const hasCR = raw.endsWith('\r');
      const edited = upgradeEntryLine(hasCR ? raw.slice(0, -1) : raw, need.scope, need.to);
      if (edited === null) {
        manual.push({ block: block.owner, ...need });
        continue;
      }
      lineEdits.set(entry.lineIdx, hasCR ? `${edited}\r` : edited);
      applied.push({ block: block.owner, ...need });
    }
  }

  const out: string[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    out.push(lineEdits.get(i) ?? rawLines[i]);
    for (const ins of insertions) {
      if (ins.afterIdx === i) out.push(ins.text);
    }
  }
  const content = out.join('\n');
  return { content, changed: content !== source, applied, manual };
}

// ---------------------------------------------------------------------------
// I/O wrapper (used by the CLI entry point)
// ---------------------------------------------------------------------------

export interface ApplySyncResult {
  changed: boolean;
  applied: AppliedIncrease[];
  manual: ManualIncrease[];
}

/**
 * Compute the caller requirement of the reusable workflow at `reusablePath`
 * and sync `consumerPath` against it in place (written only when changed).
 * Progress goes to stderr; stdout is reserved for the CLI's report lines.
 */
export function applySync(reusablePath: string, consumerPath: string): ApplySyncResult {
  const required = computeCallerRequirement(
    parseWorkflowPermissions(readFileSync(reusablePath, 'utf-8')),
  );
  const consumerSource = readFileSync(consumerPath, 'utf-8');
  const result = syncCallerPermissions(consumerSource, required);

  if (result.changed) {
    writeFileSync(consumerPath, result.content, 'utf-8');
    for (const inc of result.applied) {
      process.stderr.write(
        `✅ ${consumerPath}: ${inc.scope}: ${inc.from} → ${inc.to} (${inc.block})\n`,
      );
    }
  } else {
    process.stderr.write(`ℹ️  ${consumerPath}: caller permissions already sufficient\n`);
  }
  for (const inc of result.manual) {
    process.stderr.write(
      `⚠️  ${consumerPath}: ${inc.scope} needs ${inc.to} but could not be edited (${inc.block}, currently ${inc.from})\n`,
    );
  }
  return { changed: result.changed, applied: result.applied, manual: result.manual };
}
