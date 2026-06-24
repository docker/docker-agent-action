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
 *   outputPath    Where to write the confidence report JSON
 *                 (default: /tmp/finding_confidence.json).
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

const DEFAULT_OUTPUT_PATH = '/tmp/finding_confidence.json';

/** Map one snake_case input record to the camelCase {@link FindingInput} shape. */
function parseRecord(raw: Record<string, unknown>, index: number): FindingInput {
  const get = (key: string): unknown => raw[key];
  const require = (key: string): unknown => {
    const value = get(key);
    if (value === undefined || value === null) {
      throw new Error(`finding[${index}] is missing required field "${key}"`);
    }
    return value;
  };
  return {
    file: String(require('file')),
    line: Number(require('line')),
    category: require('category') as FindingInput['category'],
    verdict: require('verdict') as FindingInput['verdict'],
    evidenceStrength: require('evidence_strength') as FindingInput['evidenceStrength'],
    contextCompleteness: require('context_completeness') as FindingInput['contextCompleteness'],
    drafterSeverity: require('drafter_severity') as FindingInput['drafterSeverity'],
    verifierSeverity: require('verifier_severity') as FindingInput['verifierSeverity'],
    inDiff: get('in_diff') === true,
    inChangedCode: get('in_changed_code') === true,
  };
}

function main(): void {
  const [, , findingsPath, outputPath = DEFAULT_OUTPUT_PATH] = process.argv;

  if (!findingsPath) {
    process.stderr.write('Usage: score-confidence <findingsPath> [outputPath]\n');
    process.exit(1);
  }

  const parsed = JSON.parse(readFileSync(findingsPath, 'utf-8')) as unknown;
  const records = Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : [];
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

  writeFileSync(outputPath, JSON.stringify(output), 'utf-8');
}

try {
  main();
} catch (err) {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
