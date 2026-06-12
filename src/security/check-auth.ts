// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

import * as core from '@actions/core';

/**
 * Check if a user's association role is in the list of allowed roles.
 * Mirrors the jq-based check in security/check-auth.sh (exact string match).
 *
 * @param association - The user's GitHub author_association (e.g. "OWNER")
 * @param allowedRoles - Array of allowed role strings from action input
 * @returns true if authorized, false otherwise (also emits core.error on failure)
 */
export function checkAuth(association: string, allowedRoles: string[]): boolean {
  const authorized = allowedRoles.includes(association);

  if (authorized) {
    core.info('✅ Authorization successful');
    core.info(`   User role '${association}' is allowed`);
    return true;
  }

  core.error('═══════════════════════════════════════════════════════');
  core.error('❌ AUTHORIZATION FAILED');
  core.error('═══════════════════════════════════════════════════════');
  core.error('');
  core.error(`User association: ${association}`);
  core.error(`Allowed roles: ${JSON.stringify(allowedRoles)}`);
  core.error('');
  core.error('Only trusted contributors can trigger reviews.');
  core.error('Allowed: OWNER, MEMBER, COLLABORATOR');
  core.error('External contributors cannot use this action.');
  core.error('');
  core.error('If you are a maintainer, ensure you have appropriate');
  core.error('permissions in the repository.');
  core.error('═══════════════════════════════════════════════════════');
  return false;
}
