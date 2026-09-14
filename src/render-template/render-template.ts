// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * render-template — pure substitution + validation logic for staging the
 * review-pr agent reference templates.
 *
 * Two templates are rendered:
 *   - posting-format.md: __PR_HEAD_SHA__ and {pr} placeholders, staged before
 *     the review agent runs so the `gh api .../pulls/<pr>/reviews` command
 *     always contains a real PR number and the immutable review commit SHA.
 *   - pr-review-reply.yaml: {pr} placeholder only, staged before the reply
 *     agent runs so `gh api .../pulls/<pr>/comments` always contains a real
 *     PR number.
 *
 * `{pr}` is not a gh CLI template variable (only `{owner}`/`{repo}` are), so
 * an unrendered `{pr}` produces a guaranteed 404. Both render functions fail
 * closed (throw) rather than emit a template that still contains a
 * placeholder — a caller that swallows the error and posts anyway is a bug
 * in the caller, not in this module.
 */

export class TemplateValidationError extends Error {}

export interface RenderPostingOptions {
  prHeadSha: string;
  prNumber: string;
}

const SHA_PATTERN = /^[0-9a-fA-F]{40}$/;
const PR_NUMBER_PATTERN = /^[0-9]+$/;

/** Renders posting-format.md, substituting the immutable SHA and PR number. */
export function renderPostingTemplate(template: string, opts: RenderPostingOptions): string {
  const { prHeadSha, prNumber } = opts;
  if (!SHA_PATTERN.test(prHeadSha)) {
    throw new TemplateValidationError(
      'Selected PR head SHA is invalid; refusing to stage review posting',
    );
  }
  if (!PR_NUMBER_PATTERN.test(prNumber)) {
    throw new TemplateValidationError(
      'Resolved PR number is invalid; refusing to stage review posting',
    );
  }

  const rendered = template.split('__PR_HEAD_SHA__').join(prHeadSha).split('{pr}').join(prNumber);

  if (rendered.includes('__PR_HEAD_SHA__') || rendered.includes('$PR_HEAD_SHA')) {
    throw new TemplateValidationError(
      'Rendered posting template failed validation (unreplaced SHA placeholder)',
    );
  }
  if (rendered.includes('{pr}')) {
    throw new TemplateValidationError(
      'Rendered posting template failed validation (unreplaced {pr} placeholder)',
    );
  }
  const commitIdCount = (rendered.match(/--arg commit_id/g) ?? []).length;
  if (commitIdCount !== 1) {
    throw new TemplateValidationError(
      'Rendered posting template failed validation (expected exactly one commit_id argument)',
    );
  }
  if (!rendered.includes(`--arg commit_id "${prHeadSha}"`)) {
    throw new TemplateValidationError(
      'Rendered posting template failed validation (commit_id does not match selected SHA)',
    );
  }
  return rendered;
}

/** Renders pr-review-reply.yaml, substituting the PR number. */
export function renderReplyTemplate(template: string, prNumber: string): string {
  if (!PR_NUMBER_PATTERN.test(prNumber)) {
    throw new TemplateValidationError(
      'Resolved PR number is invalid; refusing to stage reply posting',
    );
  }
  const rendered = template.split('{pr}').join(prNumber);
  if (rendered.includes('{pr}')) {
    throw new TemplateValidationError(
      'Rendered reply template failed validation (unreplaced {pr} placeholder)',
    );
  }
  return rendered;
}
