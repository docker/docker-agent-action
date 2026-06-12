// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Single source of truth for all security detection patterns.
 * Ported from security/secret-patterns.sh and security/sanitize-input.sh.
 *
 * Pattern shapes are derived from the portcullis catalogue
 * (github.com/dgageot/portcullis, Apache-2.0): vendor-prefixed,
 * fixed-length bodies, with optional structural validators that
 * reject false positives the regex alone can't filter (e.g. the
 * base62 CRC32 baked into every modern GitHub token).
 */

import { validGitHubChecksum } from './validators.js';

/**
 * A secret pattern is a regex plus an optional structural validator.
 * The regex is the cheap first pass; the validator is invoked on the
 * matched span and must return true for the match to be reported.
 */
export interface SecretPattern {
  /** Identifier used in error messages and logs. */
  readonly name: string;
  /** Regex matching the credential's shape. */
  readonly regex: RegExp;
  /**
   * Optional structural check applied to the matched text.
   * Returning false suppresses the match (no leak reported).
   */
  readonly validator?: (match: string) => boolean;
}

// Full regex patterns for secret detection in output scanning.
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  // Anthropic API keys: `sk-ant-(api|sid|admin)NN-<93 base64url>AA` (~108 chars,
  // trailing `AA` is the standard base64 padding). `admin01` keys grant
  // org-wide management access, so leakage is at least as serious as `api01`.
  {
    name: 'anthropic-api-key',
    regex: /sk-ant-(?:api|sid|admin)\d{2}-[A-Za-z0-9_-]{93}AA/,
  },
  // GitHub personal / OAuth / user / server tokens. Every modern GitHub
  // token embeds a base62-encoded CRC32 of the prefix+body in its trailing
  // 6 chars; the validator rejects pattern literals and example fixtures.
  {
    name: 'github-pat',
    regex: /ghp_[A-Za-z0-9]{36}/,
    validator: validGitHubChecksum,
  },
  {
    name: 'github-oauth',
    regex: /gho_[A-Za-z0-9]{36}/,
    validator: validGitHubChecksum,
  },
  {
    name: 'github-user-token',
    regex: /ghu_[A-Za-z0-9]{36}/,
    validator: validGitHubChecksum,
  },
  {
    name: 'github-server-token',
    regex: /ghs_[A-Za-z0-9]{36}/,
    validator: validGitHubChecksum,
  },
  // GitHub fine-grained PAT: `github_pat_<22 alnum>_<59 alnum>` + 6-char CRC.
  {
    name: 'github-fine-grained-pat',
    regex: /github_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59}/,
    validator: validGitHubChecksum,
  },
  // OpenAI keys (project / service-account / admin / post-2024 reissues) all
  // embed the literal `T3BlbkFJ` (base64 of "OpenAI") between two long
  // alphanumeric runs. The marker keeps this rule from firing on unrelated
  // `sk-`-prefixed strings (DeepSeek, Stripe typos, random hashes).
  {
    name: 'openai-api-key',
    regex: /sk-[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}/,
  },
];

// Simplified alternation string for quick prefix detection in prompt verification.
export const SECRET_PREFIXES =
  '(sk-ant-|sk-proj-|sk-|ghp_|gho_|ghu_|ghs_|github_pat_|ANTHROPIC_API_KEY|GITHUB_TOKEN|OPENAI_API_KEY)';

// Critical patterns — direct secret exfiltration commands.
// These are programmatic commands that execute in the agent's environment to
// extract secrets. Never legitimate in a prompt. Triggers exit 1 (block).
export const CRITICAL_PATTERNS: RegExp[] = [
  // Direct secret extraction commands - shell
  /echo.*\$.*ANTHROPIC_API_KEY/i,
  /echo.*\$.*GITHUB_TOKEN/i,
  /echo.*\$.*OPENAI_API_KEY/i,
  /echo.*\$.*GOOGLE_API_KEY/i,

  // Direct secret extraction commands - Python
  /print\(.*ANTHROPIC_API_KEY/i,
  /print\(.*OPENAI_API_KEY/i,
  /print\(.*GITHUB_TOKEN/i,
  /print\(.*GOOGLE_API_KEY/i,
  /print.*os\.environ/i,

  // Direct secret extraction commands - JavaScript
  /console\.log.*process\.env/i,
  /console\.log\(.*ANTHROPIC_API_KEY/i,
  /console\.log\(.*OPENAI_API_KEY/i,
  /console\.log\(.*GITHUB_TOKEN/i,
  /console\.log\(.*GOOGLE_API_KEY/i,

  // Environment variable extraction
  /print.*environment.*variable/i,
  /printenv\s+(ANTHROPIC_API_KEY|OPENAI_API_KEY|GITHUB_TOKEN|GOOGLE_API_KEY)/i,

  // File access to secrets
  /cat\s+\.env/i,
];

// Suspicious patterns — behavioral / natural-language injection.
// Common in prompt injection attempts. Matching lines are stripped from
// the sanitized output and a warning is emitted; does not exit 1.
export const SUSPICIOUS_PATTERNS: RegExp[] = [
  // Instruction override attempts
  /ignore.*previous.*instruction/i,
  /ignore.*all.*instruction/i,
  /disregard.*previous/i,
  /forget.*previous/i,
  /new.*instruction.*follow/i,

  // System/mode override attempts
  /system.{0,20}override/i,
  /system.{0,20}mode([^a-z]|$)/i,
  /admin.*mode/i,
  /debug.*mode.*enable/i,
  /debug.*mode/i,
  /developer.*mode/i,

  // Direct secret revelation requests (natural language)
  /show.*me.*(your|the|my).*(key|secret|token|api)/i,
  /reveal.*(your|the|my).*(key|secret|token|api)/i,
  /display.*(your|the|my).*(key|secret|token|api)/i,
  /what.*is.*(your|the).*(api.*key|secret|token)/i,
  /give.*me.*(your|the).*(key|secret|token|api)/i,

  // System prompt extraction
  /repeat.*(your|the|back).*system.*prompt/i,
  /what.*are.*your.*instructions/i,
  /show.*initial.*prompt/i,
  /show.*(your|the).*system.*prompt/i,

  // Jailbreak attempts
  /act.*as.*no.*restrictions/i,
  /pretend.*to.*be.*evil/i,
  /pretend.*you.*are.*jailbroken/i,

  // Encoding/obfuscation attempts
  /base64.*decode/i,
  /decode.*base64/i,
  /atob\(/i,
  /btoa\(/i,
  /0x[0-9a-fA-F]{20,}/,
];

// Medium-risk patterns — API key variable names.
// Warrant warnings but don't block or strip; common in legitimate code.
export const MEDIUM_RISK_PATTERNS: string[] = [
  'ANTHROPIC_API_KEY',
  'GITHUB_TOKEN',
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
];
