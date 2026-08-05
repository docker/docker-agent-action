// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * caller-permissions — computes the GITHUB_TOKEN permissions a reusable
 * workflow requires from its caller and flags increases between releases.
 *
 * A called workflow can only downgrade the permissions granted by its caller,
 * never elevate them: every permission a job in the called workflow requests
 * (via its own `permissions:` block, or the workflow-level block when the job
 * has none) must be granted by the calling job, or GitHub rejects the run at
 * startup validation — before any job runs. That makes an increased
 * requirement a breaking change for every existing caller (issue #72: v2.0.3
 * raised `actions` from read to write on the review job and broke callers
 * granting only `actions: read`).
 *
 * The release workflow uses the CLI (index.ts) to compare the review-pr.yml
 * being released against the previous stable release, and prepends a
 * breaking-change migration warning to the generated release notes when the
 * requirement increased. Decreases are intentionally not flagged — callers
 * granting more than required keep working.
 *
 * The extractor is a focused, dependency-free reader of the GitHub Actions
 * workflow grammar (not a general YAML parser). It understands:
 *
 *   - the workflow-level `permissions:` block (column 0)
 *   - job-level `permissions:` blocks (direct children of entries in `jobs:`)
 *   - block-map entries (`scope: level`, trailing comments allowed)
 *   - the inline forms `{}`, `{scope: level, …}`, `read-all`, `write-all`
 *
 * Anything nested deeper (step `with:` inputs, `run:`/`if:` block scalars) is
 * excluded by indentation scoping: block-scalar content is always indented
 * deeper than its key, so it can never sit at column 0 or at a job's
 * direct-child indent. Unrecognized permission entries fail loudly so a
 * parsing gap can never silently suppress a breaking-change warning.
 */
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AccessLevel = 'none' | 'read' | 'write';

/** Scope name → requested access. The pseudo-scope `*` represents `read-all`/`write-all`. */
export type PermissionsMap = Record<string, AccessLevel>;

/** Pseudo-scope used to represent the `read-all` / `write-all` shorthands. */
export const ALL_SCOPES = '*';

export interface JobPermissions {
  id: string;
  /** undefined = no job-level block (the workflow-level block applies, else the caller's grant). */
  permissions: PermissionsMap | undefined;
}

export interface WorkflowPermissions {
  /** Workflow-level `permissions:` block. undefined when absent. */
  workflow: PermissionsMap | undefined;
  jobs: JobPermissions[];
}

export interface PermissionIncrease {
  scope: string;
  from: AccessLevel;
  to: AccessLevel;
}

const LEVEL_RANK: Record<AccessLevel, number> = { none: 0, read: 1, write: 2 };

// ---------------------------------------------------------------------------
// Workflow permissions extractor
// ---------------------------------------------------------------------------

interface SourceLine {
  indent: number;
  /** Trimmed line content (never blank, never a whole-line comment). */
  text: string;
  /** 1-based line number in the original source, for error messages. */
  lineNo: number;
}

/** Split into significant lines: blanks and whole-line comments dropped, indent recorded. */
function significantLines(source: string): SourceLine[] {
  const out: SourceLine[] = [];
  const rawLines = source.split('\n');
  for (let i = 0; i < rawLines.length; i++) {
    const noCr = rawLines[i].endsWith('\r') ? rawLines[i].slice(0, -1) : rawLines[i];
    const text = noCr.trim();
    if (text === '' || text.startsWith('#')) continue;
    out.push({ indent: noCr.length - noCr.trimStart().length, text, lineNo: i + 1 });
  }
  return out;
}

/** Strip a trailing ` # comment` (YAML requires whitespace before an inline `#`). */
function stripTrailingComment(text: string): string {
  return text.replace(/(?:^|\s)#.*$/, '').trim();
}

const KEY_RE = /^([A-Za-z_][A-Za-z0-9_-]*):(?:\s+(.*))?$/;

/** Match a `key:` or `key: value` line. Returns the key and its comment-stripped inline value. */
function matchKey(text: string): { key: string; rest: string } | null {
  const m = text.match(KEY_RE);
  if (!m) return null;
  return { key: m[1], rest: stripTrailingComment(m[2] ?? '') };
}

function parseAccessLevel(token: string, lineNo: number): AccessLevel {
  const unquoted = token.replace(/^(['"])(.*)\1$/, '$2');
  if (unquoted === 'none' || unquoted === 'read' || unquoted === 'write') return unquoted;
  throw new Error(
    `Unrecognized permission level "${token}" at line ${lineNo} (expected none, read, or write)`,
  );
}

/** Parse an inline permissions value: `read-all`, `write-all`, `{}`, or `{scope: level, …}`. */
function parseInlinePermissions(value: string, lineNo: number): PermissionsMap {
  if (value === 'read-all') return { [ALL_SCOPES]: 'read' };
  if (value === 'write-all') return { [ALL_SCOPES]: 'write' };
  if (value.startsWith('{') && value.endsWith('}')) {
    const inner = value.slice(1, -1).trim();
    if (inner === '') return {};
    const permissions: PermissionsMap = {};
    for (const part of inner.split(',')) {
      const m = part.trim().match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(\S+)$/);
      if (!m) {
        throw new Error(`Malformed inline permissions entry "${part.trim()}" at line ${lineNo}`);
      }
      permissions[m[1]] = parseAccessLevel(m[2], lineNo);
    }
    return permissions;
  }
  throw new Error(`Unrecognized permissions value "${value}" at line ${lineNo}`);
}

/**
 * Parse the permissions value belonging to the `permissions:` key at lines[keyIdx].
 * Returns the parsed map and the index of the first line after the block.
 */
function parsePermissionsValue(
  lines: SourceLine[],
  keyIdx: number,
  inlineValue: string,
): { permissions: PermissionsMap; nextIdx: number } {
  const keyLine = lines[keyIdx];
  if (inlineValue !== '') {
    return {
      permissions: parseInlinePermissions(inlineValue, keyLine.lineNo),
      nextIdx: keyIdx + 1,
    };
  }
  const permissions: PermissionsMap = {};
  let i = keyIdx + 1;
  while (i < lines.length && lines[i].indent > keyLine.indent) {
    const entry = stripTrailingComment(lines[i].text);
    const m = entry.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(\S+)$/);
    if (!m) {
      throw new Error(`Malformed permissions entry at line ${lines[i].lineNo}: "${lines[i].text}"`);
    }
    permissions[m[1]] = parseAccessLevel(m[2], lines[i].lineNo);
    i++;
  }
  return { permissions, nextIdx: i };
}

/** Parse the body of one job (lines after its id, deeper than jobIndent). */
function parseJobBody(
  lines: SourceLine[],
  start: number,
  jobIndent: number,
  job: JobPermissions,
): number {
  let i = start;
  let childIndent = -1;
  while (i < lines.length && lines[i].indent > jobIndent) {
    const line = lines[i];
    // The first key inside the job fixes the direct-child indent; only a
    // `permissions:` at exactly that indent belongs to the job itself
    // (deeper occurrences are step inputs or scalar content).
    if (childIndent === -1) childIndent = line.indent;
    if (line.indent === childIndent) {
      const m = matchKey(line.text);
      if (m?.key === 'permissions') {
        const parsed = parsePermissionsValue(lines, i, m.rest);
        job.permissions = parsed.permissions;
        i = parsed.nextIdx;
        continue;
      }
    }
    i++;
  }
  return i;
}

/** Parse the `jobs:` section (lines after the `jobs:` key, until the next column-0 key). */
function parseJobsSection(lines: SourceLine[], start: number, out: JobPermissions[]): number {
  let i = start;
  let jobIndent = -1;
  while (i < lines.length && lines[i].indent > 0) {
    const line = lines[i];
    if (jobIndent === -1) jobIndent = line.indent;
    if (line.indent === jobIndent) {
      const m = matchKey(line.text);
      if (m) {
        const job: JobPermissions = { id: m.key, permissions: undefined };
        out.push(job);
        i = parseJobBody(lines, i + 1, jobIndent, job);
        continue;
      }
    }
    i++;
  }
  return i;
}

/**
 * Extract the workflow-level and per-job `permissions:` blocks from a GitHub
 * Actions workflow source. Throws on malformed permissions entries.
 */
export function parseWorkflowPermissions(source: string): WorkflowPermissions {
  const lines = significantLines(source);
  let workflow: PermissionsMap | undefined;
  const jobs: JobPermissions[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent === 0) {
      const m = matchKey(line.text);
      if (m?.key === 'permissions') {
        const parsed = parsePermissionsValue(lines, i, m.rest);
        workflow = parsed.permissions;
        i = parsed.nextIdx;
        continue;
      }
      if (m?.key === 'jobs') {
        i = parseJobsSection(lines, i + 1, jobs);
        continue;
      }
    }
    i++;
  }
  return { workflow, jobs };
}

// ---------------------------------------------------------------------------
// Caller-facing requirement + diff
// ---------------------------------------------------------------------------

/**
 * Compute what a caller must grant: for each scope, the maximum level any job
 * requests. A job's effective request is its own block when present, else the
 * workflow-level block (a job-level block REPLACES the workflow-level one, it
 * is not merged). Explicit `none` entries impose no requirement and are dropped.
 */
export function computeCallerRequirement(wf: WorkflowPermissions): PermissionsMap {
  const blocks = wf.jobs.map((job) => job.permissions ?? wf.workflow);
  // No jobs parsed (degenerate input): fall back to the workflow-level block
  // so a requirement is never silently under-reported.
  const effectiveBlocks = blocks.length > 0 ? blocks : [wf.workflow];

  const requirement: PermissionsMap = {};
  for (const block of effectiveBlocks) {
    if (block === undefined) continue;
    for (const [scope, level] of Object.entries(block)) {
      const current = requirement[scope] ?? 'none';
      if (LEVEL_RANK[level] > LEVEL_RANK[current]) requirement[scope] = level;
    }
  }
  for (const [scope, level] of Object.entries(requirement)) {
    if (level === 'none') delete requirement[scope];
  }
  return requirement;
}

/**
 * Scopes whose required level increased (none < read < write) from `previous`
 * to `current`, sorted by scope name. Reductions are never reported — callers
 * granting more than required keep working.
 */
export function diffCallerRequirements(
  previous: PermissionsMap,
  current: PermissionsMap,
): PermissionIncrease[] {
  const effective = (req: PermissionsMap, scope: string): AccessLevel => {
    const direct = req[scope] ?? 'none';
    if (scope === ALL_SCOPES) return direct;
    const wildcard = req[ALL_SCOPES] ?? 'none';
    return LEVEL_RANK[direct] >= LEVEL_RANK[wildcard] ? direct : wildcard;
  };

  const scopes = [...new Set([...Object.keys(previous), ...Object.keys(current)])].sort();
  const increases: PermissionIncrease[] = [];
  for (const scope of scopes) {
    const from = effective(previous, scope);
    const to = effective(current, scope);
    if (LEVEL_RANK[to] > LEVEL_RANK[from]) increases.push({ scope, from, to });
  }
  return increases;
}

// ---------------------------------------------------------------------------
// Release-notes warning
// ---------------------------------------------------------------------------

const SETUP_DOCS_URL =
  'https://github.com/docker/docker-agent-action/blob/main/review-pr/README.md#quick-start';

/**
 * Render the breaking-change migration warning prepended to release notes.
 * Returns '' when there is nothing to warn about.
 */
export function renderBreakingChangeWarning(increases: PermissionIncrease[]): string {
  if (increases.length === 0) return '';
  const bullets = increases
    .map((inc) => {
      const scope = inc.scope === ALL_SCOPES ? 'all scopes' : `\`${inc.scope}\``;
      const from = inc.from === 'none' ? 'not previously required' : `\`${inc.from}\``;
      return `- ${scope}: ${from} → \`${inc.to}\``;
    })
    .join('\n');
  return [
    '## ⚠️ Breaking change: callers of the PR-review workflow must grant more permissions',
    '',
    'This release increases the GitHub token permissions that the reusable PR-review workflow (`.github/workflows/review-pr.yml`) requests from its caller:',
    '',
    bullets,
    '',
    `A called workflow cannot elevate the permissions granted by its caller, so calling jobs that still grant the previous level fail GitHub's workflow validation at startup — before any job runs. Update the \`permissions:\` block on every job that calls this workflow **before** upgrading. See the [PR review setup docs](${SETUP_DOCS_URL}) for the full recommended block.`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// I/O wrapper (used by the CLI entry point)
// ---------------------------------------------------------------------------

/**
 * Compare the caller-facing permission requirement of two workflow files and
 * return the release-notes warning ('' when the requirement did not increase).
 *
 * The previous file may be absent (workflow introduced in this release — no
 * existing caller can break): treated as no baseline, empty result. The
 * current file must exist so a mistyped path in release.yml fails loudly
 * instead of silently disabling the safeguard.
 *
 * Progress messages are written to stderr; stdout is reserved for the warning.
 */
export function generateCallerPermissionsWarning(
  previousPath: string,
  currentPath: string,
): string {
  const currentSource = readFileSync(currentPath, 'utf-8');

  let previousSource: string;
  try {
    previousSource = readFileSync(previousPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      process.stderr.write(`ℹ️  No previous workflow at ${previousPath} — nothing to compare\n`);
      return '';
    }
    throw err;
  }

  const previous = computeCallerRequirement(parseWorkflowPermissions(previousSource));
  const current = computeCallerRequirement(parseWorkflowPermissions(currentSource));
  const increases = diffCallerRequirements(previous, current);

  if (increases.length === 0) {
    process.stderr.write('✅ No caller-facing permission increases\n');
    return '';
  }
  for (const inc of increases) {
    process.stderr.write(`⚠️  Caller permission increased: ${inc.scope}: ${inc.from} → ${inc.to}\n`);
  }
  return renderBreakingChangeWarning(increases);
}
