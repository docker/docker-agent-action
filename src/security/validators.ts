// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Structural validators applied AFTER a regex match to reject false
 * positives. Ported from github.com/dgageot/portcullis (Apache-2.0).
 *
 * A validator returns true when the matched span is structurally
 * consistent with the credential format the regex targets — for
 * example, a GitHub token whose trailing 6 chars equal the base62
 * CRC32 of the rest of the token. Patterns without a validator are
 * matched on regex shape alone.
 */

const GITHUB_CHECKSUM_LEN = 6;
const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * GitHub bakes a base62-encoded CRC32 of the prefix+body into the
 * trailing 6 chars of every modern token (`ghp_`, `gho_`, `ghu_`,
 * `ghs_`, `ghr_`, `github_pat_…`). Real tokens validate; pattern
 * literals, placeholders, and example fixtures do not.
 *
 * Reference: portcullis/validators.go::validGitHubChecksum.
 */
export function validGitHubChecksum(token: string): boolean {
  if (token.length <= GITHUB_CHECKSUM_LEN) return false;
  const provided = token.slice(-GITHUB_CHECKSUM_LEN);
  const checksumless = token.slice(0, -GITHUB_CHECKSUM_LEN);
  return provided === base62CRC32(checksumless);
}

/**
 * Encode the unsigned 32-bit CRC32 of `s` (UTF-8) as a fixed-width
 * 6-character base62 string, MSB first — matches GitHub's reference
 * implementation.
 */
export function base62CRC32(s: string): string {
  let checksum = BigInt(crc32(Buffer.from(s, 'utf-8')));
  const out = new Array<string>(GITHUB_CHECKSUM_LEN);
  for (let i = GITHUB_CHECKSUM_LEN - 1; i >= 0; i--) {
    out[i] = BASE62_ALPHABET[Number(checksum % 62n)] as string;
    checksum /= 62n;
  }
  return out.join('');
}

// IEEE 802.3 CRC-32 lookup table (polynomial 0xEDB88320, reflected).
const CRC32_TABLE: readonly number[] = (() => {
  const t = new Array<number>(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[i] = c >>> 0;
  }
  return t;
})();

/** Compute the IEEE CRC-32 of `buf` and return it as an unsigned 32-bit integer. */
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const b of buf) {
    // Safe: lookup index is 0..255 by construction.
    // biome-ignore lint/style/noNonNullAssertion: indexed array access
    crc = (CRC32_TABLE[(crc ^ b) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
