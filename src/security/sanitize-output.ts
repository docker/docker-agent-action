// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
import * as core from '@actions/core';
import { MEDIUM_RISK_PATTERNS, SECRET_PATTERNS } from './patterns.js';

export interface SanitizeOutputResult {
  leaked: boolean;
  detectedPatterns: string[];
}

// Matches any regex metacharacter. Used to detect pattern definitions vs real secrets.
const REGEX_METACHAR_RE = /[[\]{}()*+?^$\\]/;

/**
 * Scan an AI response file for leaked secrets before it is posted to a PR.
 *
 * Implements two false-positive heuristics ported from sanitize-output.sh:
 *   1. Skip a match if the matched text itself contains regex metacharacters —
 *      it is probably a pattern definition in code, not a real secret.
 *   2. Skip a match if the matched text appears wrapped in single quotes
 *      somewhere in the file — it is a quoted regex pattern in a comment or doc.
 *
 * Separately warns (does not block) on occurrences of API key variable names.
 *
 * @param filePath Path to the AI response file to scan
 */
export function sanitizeOutput(filePath: string): SanitizeOutputResult {
  const content = readFileSync(filePath, 'utf-8');

  core.info('Scanning output for leaked secrets...');

  let leaked = false;
  const detectedPatterns: string[] = [];

  for (const pattern of SECRET_PATTERNS) {
    // Use a fresh global regex each time to avoid lastIndex issues.
    const globalRe = new RegExp(pattern.regex.source, 'g');

    for (const match of content.matchAll(globalRe)) {
      const matchedText = match[0];

      // Heuristic 1: Skip if match contains regex metacharacters.
      // Real tokens are alphanumeric-only after the prefix; metacharacters
      // indicate a pattern definition, not an actual secret.
      if (REGEX_METACHAR_RE.test(matchedText)) {
        core.debug(`Skipping false positive (regex pattern): ${matchedText}`);
        continue;
      }

      // Heuristic 2: Skip only if THIS specific occurrence is wrapped in single quotes.
      // Checking the characters immediately before and after match.index ensures that
      // a file containing BOTH a bare token and a single-quoted copy is still flagged
      // (the bare occurrence is not individually quoted and therefore must be reported).
      const idx = match.index ?? 0;
      const isQuoted =
        idx > 0 && content[idx - 1] === "'" && content[idx + matchedText.length] === "'";
      if (isQuoted) {
        core.debug(`Skipping false positive (quoted occurrence): ${matchedText}`);
        continue;
      }

      // Heuristic 3 (structural validator). For credentials whose shape
      // includes a checksum or other invariant (e.g. the base62 CRC32
      // baked into every modern GitHub token), reject matches that fail
      // the check. This eliminates pattern literals, placeholders, and
      // example fixtures that happen to satisfy the regex.
      if (pattern.validator && !pattern.validator(matchedText)) {
        core.debug(`Skipping false positive (validator rejected): ${matchedText}`);
        continue;
      }

      // This is a real secret leak.
      core.error(`🚨 SECRET LEAK DETECTED: Pattern matched: ${pattern.name}`);
      leaked = true;
      detectedPatterns.push(pattern.name);
      break; // One confirmed match per pattern is sufficient to flag.
    }
  }

  // Warn on environment variable name references (indirect disclosure).
  // Does not block execution — just flags for manual review.
  const mediumRe = new RegExp(`(${MEDIUM_RISK_PATTERNS.join('|')})`, 'i');
  if (mediumRe.test(content)) {
    core.warning('⚠️  Environment variable names detected in output');
    core.warning('This may indicate an attempted information disclosure');
  }

  if (leaked) {
    core.error('═══════════════════════════════════════════════════════');
    core.error('🚨 CRITICAL SECURITY INCIDENT: SECRET LEAK DETECTED');
    core.error('═══════════════════════════════════════════════════════');
    core.error('');
    core.error('Response contains secret patterns:');
    for (const p of detectedPatterns) {
      core.error(`  - ${p}`);
    }
    core.error('');
    core.error('ACTIONS TAKEN:');
    core.error('  ✓ Response BLOCKED from being posted to PR');
    core.error('  ✓ Security incident logged');
    core.error('  ✓ Workflow will fail');
    core.error('');
    core.error('IMMEDIATE ACTIONS REQUIRED:');
    core.error('  1. Investigate PR for prompt injection');
    core.error('  2. Review AI response in workflow logs');
    core.error('  3. Rotate compromised secrets immediately');
    core.error('  4. Block the PR author if malicious');
    core.error('');
    core.error('DO NOT post this response to the PR!');
    core.error('═══════════════════════════════════════════════════════');
  } else {
    core.info('✅ No secrets detected in output - safe to post');
  }

  return { leaked, detectedPatterns };
}
