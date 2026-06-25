// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * score-confidence CLI entrypoint.
 *
 * Usage:
 *   node dist/score-confidence.js <findingsPath> [outputPath]
 *
 *   findingsPath  Path to a JSON file holding an array of merged finding records
 *                 (drafter hypothesis + verifier verdict). Read-only.
 *   outputPath    Optional. When given, the confidence report JSON is written to
 *                 this caller-controlled path; otherwise it is written to stdout
 *                 (the default — keeps the tool composable and avoids writing to a
 *                 fixed temp location).
 *
 * Each input record uses the agent's snake_case field names:
 *   {
 *     "file": "pkg/auth/oidc.go",
 *     "line": 72,
 *     "category": "security",
 *     "verdict": "CONFIRMED",
 *     "evidence_strength": "direct",
 *     "context_completeness": "full",
 *     "drafter_severity": "high",
 *     "verifier_severity": "high",
 *     "in_diff": true,
 *     "in_changed_code": true,
 *     "issue": "…",          // optional, passed through to output
 *     "details": "…"          // optional, passed through to output
 *   }
 *
 * The output JSON groups findings by their final posting disposition
 * (inline / summary / audit / dropped); each entry carries the original record
 * plus { score, band, disposition, forced, reason, breakdown }. See
 * score-confidence.ts for the scoring rules and posting policy.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { type FindingInput, scoreFindings } from './score-confidence.js';

/** Map one snake_case input record to the camelCase {@link FindingInput} shape. */
export function parseRecord(raw: Record<string, unknown>, index: number): FindingInput {
  const get = (key: string): unknown => raw[key];
  const require = (key: string): unknown => {
    const value = get(key);
    if (value === undefined || value === null) {
      throw new Error(`finding[${index}] is missing required field "${key}"`);
    }
    return value;
  };
  // Coerce a required field to a strict boolean. A real boolean passes through and
  // the canonical strings "true"/"false" are accepted; a missing/null or otherwise
  // unrecognized value throws. This must NOT silently fall back to `false`: the
  // scope flags gate the whole finding, so a dropped flag would silently discard
  // the finding (including forced security findings) with no diagnostic.
  const requireBool = (key: string): boolean => {
    const value = require(key);
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true') return true;
      if (normalized === 'false') return false;
    }
    throw new Error(
      `finding[${index}] field "${key}" must be a boolean, got ${JSON.stringify(value)}`,
    );
  };
  // Coerce a required field to a positive integer. `Number("abc")` is `NaN`, which
  // JSON-serializes to `null` and would break (or 422) the GitHub review line
  // anchor, so a non-numeric or out-of-range value throws rather than propagating.
  const requireInt = (key: string): number => {
    const value = require(key);
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error(
        `finding[${index}] field "${key}" must be a positive integer, got ${JSON.stringify(value)}`,
      );
    }
    return parsed;
  };
  return {
    file: String(require('file')),
    line: requireInt('line'),
    category: require('category') as FindingInput['category'],
    verdict: require('verdict') as FindingInput['verdict'],
    evidenceStrength: require('evidence_strength') as FindingInput['evidenceStrength'],
    contextCompleteness: require('context_completeness') as FindingInput['contextCompleteness'],
    drafterSeverity: require('drafter_severity') as FindingInput['drafterSeverity'],
    verifierSeverity: require('verifier_severity') as FindingInput['verifierSeverity'],
    inDiff: requireBool('in_diff'),
    inChangedCode: requireBool('in_changed_code'),
  };
}

/**
 * Narrow a parsed JSON value to the finding-record array the scorer expects.
 *
 * A non-array top-level value (e.g. `null`, a scalar, or a `{ "findings": [...] }`
 * wrapper) must fail loudly rather than be treated as an empty list: a silent
 * fallback would emit a valid-looking empty report and exit 0, indistinguishable
 * from a real zero-findings run. Throwing here joins the same loud-failure path as
 * every other bad input (the outer try/catch writes the message and exits 1).
 */
export function toFindingRecords(parsed: unknown): Record<string, unknown>[] {
  if (!Array.isArray(parsed)) {
    throw new Error(
      `input must be a JSON array of findings, got ${parsed === null ? 'null' : typeof parsed}`,
    );
  }
  return parsed as Record<string, unknown>[];
}

function main(): void {
  const [, , findingsPath, outputPath] = process.argv;

  if (!findingsPath) {
    process.stderr.write('Usage: score-confidence <findingsPath> [outputPath]\n');
    process.exit(1);
  }

  const parsed = JSON.parse(readFileSync(findingsPath, 'utf-8')) as unknown;
  const records = toFindingRecords(parsed);
  const inputs = records.map(parseRecord);
  const report = scoreFindings(inputs);

  // Re-attach the original records so passthrough fields (issue/details) survive,
  // grouped by final posting disposition.
  const project = (group: typeof report.inline): unknown[] =>
    group.map((s) => {
      const original = records[inputs.indexOf(s.input)] ?? {};
      return {
        ...original,
        score: s.result.score,
        band: s.result.band,
        disposition: s.result.disposition,
        forced: s.result.forced,
        reason: s.result.reason,
        breakdown: s.result.breakdown,
      };
    });

  const output = {
    inline: project(report.inline),
    summary: project(report.summary),
    audit: project(report.audit),
    dropped: project(report.dropped),
  };

  const json = JSON.stringify(output);
  // Default to stdout (composable, no fixed temp path); write to a file only when
  // the caller supplies an explicit, caller-controlled output path.
  if (outputPath) {
    writeFileSync(outputPath, json, 'utf-8');
  } else {
    process.stdout.write(`${json}\n`);
  }
}

// Guard: only run as a CLI when invoked directly as dist/score-confidence.js, never
// when imported (the unit tests import parseRecord directly and must not trigger main).
if (process.argv[1]?.endsWith('score-confidence.js') && !process.env.VITEST) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
