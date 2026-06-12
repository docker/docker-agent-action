// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, writeFileSync } from 'node:fs';
import * as core from '@actions/core';
import { CRITICAL_PATTERNS, MEDIUM_RISK_PATTERNS, SUSPICIOUS_PATTERNS } from './patterns.js';

export interface SanitizeInputResult {
  blocked: boolean;
  stripped: boolean;
  riskLevel: 'low' | 'medium' | 'high';
}

/**
 * Return true if this line should be excluded from pattern-match detection
 * (false-positive filter). Mirrors the grep -v pipeline in sanitize-input.sh:
 *   grep -v "SUSPICIOUS_PATTERNS" | grep -v "CRITICAL_PATTERNS" |
 *   grep -v "MEDIUM_RISK_PATTERNS" |
 *   grep -v -E "^[+[:space:]-][[:space:]]*['\"].*['\"][[:space:]]*$"
 */
function isFalsePositive(line: string): boolean {
  // Skip lines that reference the pattern array names themselves
  // (self-referential security code or test fixtures).
  if (
    line.includes('SUSPICIOUS_PATTERNS') ||
    line.includes('CRITICAL_PATTERNS') ||
    line.includes('MEDIUM_RISK_PATTERNS')
  ) {
    return true;
  }
  // Skip purely quoted lines — but ONLY if the quoted content contains regex
  // metacharacters, indicating it is a pattern definition in code rather than
  // a real injection payload. A line like +"echo $ANTHROPIC_API_KEY" is NOT
  // a false positive: it has no bracket/brace/quantifier metacharacters. A
  // line like +'ghs_[a-zA-Z0-9]{36}' IS a false positive (contains [ ] { }).
  // Note: $ is intentionally excluded — shell variable references ($KEY)
  // must not suppress detection of exfiltration commands.
  if (/^[+\s-]\s*['"].*[[\]{}()*+?^\\].*['"]\s*$/.test(line)) {
    return true;
  }
  return false;
}

/**
 * Sanitize a user-provided prompt file using a three-tier strategy:
 *
 *   1. Strip `+`-prefixed diff comment lines (always — common injection vector).
 *   2. CRITICAL_PATTERNS  → block execution entirely (exit 1).
 *   3. SUSPICIOUS_PATTERNS → strip matching lines, warn, continue (exit 0).
 *   4. MEDIUM_RISK_PATTERNS → warn only (exit 0).
 *
 * Faithfully ports security/sanitize-input.sh including its false-positive
 * filters so that test fixtures and security-related code are not flagged.
 *
 * @param inputPath  Path to the raw prompt file
 * @param outputPath Path where the sanitized output is written
 */
export function sanitizeInput(inputPath: string, outputPath: string): SanitizeInputResult {
  const inputContent = readFileSync(inputPath, 'utf-8');
  const inputLines = inputContent.split('\n');

  // ── Step 1: Strip diff comment lines from output copy ──────────────────
  // Removes lines like "+// comment", "+/* block", "+  # shell comment"
  let outputLines = inputLines
    .filter((line) => !/^\+.*\/\//.test(line))
    .filter((line) => !/^\+.*\/\*/.test(line))
    .filter((line) => !/^\+\s*#/.test(line));

  core.info('🔍 Checking for suspicious patterns...');

  let foundCritical = false;
  let foundSuspicious = false;
  let foundMedium = false;

  // ── Step 2: Check CRITICAL patterns (block execution) ──────────────────
  // NOTE: isFalsePositive() is intentionally NOT applied here. CRITICAL patterns
  // represent direct secret exfiltration commands that are never legitimate in a
  // real prompt. Applying the false-positive filter creates exploitable bypass
  // vectors: an attacker can decorate a payload with metacharacters (e.g.
  // +"echo $ANTHROPIC_API_KEY[]") to trigger the quoted-line suppression and
  // evade detection. Any line matching a CRITICAL pattern is unconditionally blocked.
  for (const pattern of CRITICAL_PATTERNS) {
    const matches = inputLines.filter((line) => pattern.test(line));
    if (matches.length > 0) {
      core.error(`🚨 CRITICAL pattern detected: ${pattern.source}`);
      core.error('This is a direct secret exfiltration command');
      foundCritical = true;
    }
  }

  // ── Step 3: Check SUSPICIOUS patterns (strip + warn) ───────────────────
  for (const pattern of SUSPICIOUS_PATTERNS) {
    const matchingInputLines = inputLines.filter((line) => pattern.test(line));
    const realMatches = matchingInputLines.filter((line) => !isFalsePositive(line));
    if (realMatches.length > 0) {
      core.warning(`⚠️  Suspicious pattern stripped from prompt: ${pattern.source}`);
      foundSuspicious = true;
    }
    // Strip ALL matching lines from output regardless of the logging filter.
    // Mirrors: grep -ivE "$pattern" "$OUTPUT" > "${OUTPUT}.tmp"; mv "${OUTPUT}.tmp" "$OUTPUT"
    outputLines = outputLines.filter((line) => !pattern.test(line));
  }

  // ── Step 4: Check MEDIUM-RISK patterns (warn only, no strip) ───────────
  for (const name of MEDIUM_RISK_PATTERNS) {
    const re = new RegExp(name);
    const matchingLines = inputLines.filter((line) => re.test(line));
    const realMatches = matchingLines.filter((line) => !isFalsePositive(line));
    if (realMatches.length > 0) {
      core.warning(`⚠️  MEDIUM-RISK pattern detected: ${name}`);
      core.warning('This PR modifies API key configuration - review carefully');
      core.warning('Output will be scanned for actual secret leakage');
      foundMedium = true;
    }
  }

  // ── Determine outcome ───────────────────────────────────────────────────
  if (foundCritical) {
    core.error(
      '═══════════════════════════════════════════════════════\n' +
        '🚨 BLOCKED: CRITICAL SECRET EXFILTRATION DETECTED\n' +
        '═══════════════════════════════════════════════════════\n' +
        'The input contains commands that directly extract secrets.\n' +
        'Execution has been blocked.\n' +
        '═══════════════════════════════════════════════════════',
    );
    return { blocked: true, stripped: false, riskLevel: 'high' };
  }

  // Write sanitized output — only reached when not blocked.
  // Tainted content must never be flushed to disk before exit.
  writeFileSync(outputPath, outputLines.join('\n'), 'utf-8');

  if (foundSuspicious) {
    core.info('⚠️  Input sanitization completed - suspicious content stripped from prompt');
    core.info('   Stripped lines will not be passed to the agent');
    core.info('   Real security is in output scanning (will detect actual leaked secrets)');
    return { blocked: false, stripped: true, riskLevel: 'medium' };
  }

  if (foundMedium) {
    core.info('⚠️  Input sanitization completed with WARNINGS - proceeding with review');
    core.info('   Real security is in output scanning (will detect actual leaked secrets)');
    return { blocked: false, stripped: false, riskLevel: 'medium' };
  }

  core.info('✅ Input sanitization completed - no suspicious patterns found');
  return { blocked: false, stripped: false, riskLevel: 'low' };
}
