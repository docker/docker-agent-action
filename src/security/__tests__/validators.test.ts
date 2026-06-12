// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { base62CRC32, validGitHubChecksum } from '../validators.js';

describe('base62CRC32', () => {
  // Reference values match portcullis/validators_test.go::TestBase62CRC32.
  it('encodes empty input as the all-zeros checksum', () => {
    expect(base62CRC32('')).toBe('000000');
  });

  it('encodes the GitHub reference fixture correctly', () => {
    expect(base62CRC32(`ghp_${'A'.repeat(30)}`)).toBe('1yBYBE');
  });

  it('produces a 6-char base62 string', () => {
    expect(base62CRC32('hello world')).toMatch(/^[0-9A-Za-z]{6}$/);
  });
});

describe('validGitHubChecksum', () => {
  // Real-shape tokens with valid CRC32, mirroring portcullis fixtures.
  const validTokens: ReadonlyArray<readonly [string, string]> = [
    ['ghp', `ghp_${'A'.repeat(30)}1yBYBE`],
    ['gho', `gho_${'B'.repeat(30)}2EnKYh`],
    ['ghu', `ghu_${'C'.repeat(30)}12Mf6L`],
    ['ghs', `ghs_${'D'.repeat(30)}1fOFde`],
    ['ghr', `ghr_${'E'.repeat(30)}0rAO3S`],
    ['github_pat_', `github_pat_${'a'.repeat(22)}_${'b'.repeat(53)}2ioKsE`],
  ];

  for (const [label, token] of validTokens) {
    it(`accepts a valid ${label} token`, () => {
      expect(validGitHubChecksum(token)).toBe(true);
    });
  }

  it('rejects a token whose trailing 6 chars are not the CRC32', () => {
    // Plausible-shape token with a wrong checksum.
    expect(validGitHubChecksum(`ghp_${'a'.repeat(36)}`)).toBe(false);
  });

  it('rejects a fine-grained-PAT-shaped token without a real CRC32', () => {
    expect(validGitHubChecksum(`github_pat_${'a'.repeat(22)}_${'b'.repeat(59)}`)).toBe(false);
  });

  it('rejects strings shorter than the checksum', () => {
    expect(validGitHubChecksum('short')).toBe(false);
    expect(validGitHubChecksum('123456')).toBe(false);
  });
});
