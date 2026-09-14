// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import {
  renderPostingTemplate,
  renderReplyTemplate,
  TemplateValidationError,
} from '../render-template.js';

const SHA = 'a'.repeat(40);
const PR = '5929';

describe('renderPostingTemplate', () => {
  // Mutation-coverage note: this is the regression test for the original bug
  // ({pr} is not a gh CLI template variable, so an unrendered {pr} 404s).
  // The function validates its OWN output for a leftover {pr} before
  // returning, so deleting either the substitution or that internal guard
  // makes this test fail: with the guard intact but substitution removed,
  // renderPostingTemplate throws (uncaught in this test); with both removed,
  // the `not.toContain('{pr}')` assertion fails.
  it('substitutes __PR_HEAD_SHA__ and {pr}, producing no leftover placeholder', () => {
    const template =
      'jq -n --arg commit_id "__PR_HEAD_SHA__" \'{}\' | gh api repos/{owner}/{repo}/pulls/{pr}/reviews --input -';
    const rendered = renderPostingTemplate(template, { prHeadSha: SHA, prNumber: PR });
    expect(rendered).not.toContain('{pr}');
    expect(rendered).not.toContain('__PR_HEAD_SHA__');
    expect(rendered).toContain(`pulls/${PR}/reviews`);
    expect(rendered).toContain(`--arg commit_id "${SHA}"`);
    // {owner}/{repo} are real gh CLI template variables — left untouched
    expect(rendered).toContain('repos/{owner}/{repo}/pulls');
  });

  it('rejects an invalid PR head SHA', () => {
    expect(() =>
      renderPostingTemplate('jq -n --arg commit_id "__PR_HEAD_SHA__"', {
        prHeadSha: 'not-a-sha',
        prNumber: PR,
      }),
    ).toThrow(TemplateValidationError);
  });

  it.each([
    ['empty', ''],
    ['non-numeric', 'abc'],
    ['shell metacharacters', '111; echo INJECTED'],
  ])('rejects an invalid PR number (%s)', (_name, prNumber) => {
    expect(() =>
      renderPostingTemplate('jq -n --arg commit_id "__PR_HEAD_SHA__"', {
        prHeadSha: SHA,
        prNumber,
      }),
    ).toThrow(TemplateValidationError);
  });

  it('rejects a template with zero commit_id arguments', () => {
    expect(() =>
      renderPostingTemplate('jq -n --arg body "review"', { prHeadSha: SHA, prNumber: PR }),
    ).toThrow(/exactly one commit_id/);
  });

  it('rejects a template with multiple commit_id arguments', () => {
    const template = 'jq -n --arg commit_id "__PR_HEAD_SHA__" --arg commit_id "x"';
    expect(() => renderPostingTemplate(template, { prHeadSha: SHA, prNumber: PR })).toThrow(
      /exactly one commit_id/,
    );
  });

  it('rejects a template whose commit_id does not resolve to the selected SHA', () => {
    // __PR_HEAD_SHA__ is absent entirely, so the commit_id literal never
    // matches the selected SHA — must fail rather than post an empty/wrong commit_id.
    const template = 'jq -n --arg commit_id "deadbeef"';
    expect(() => renderPostingTemplate(template, { prHeadSha: SHA, prNumber: PR })).toThrow(
      /exactly one commit_id|does not match/,
    );
  });

  it('rejects a template where __PR_HEAD_SHA__ literally survives (unresolved placeholder)', () => {
    const template = 'jq -n --arg commit_id "$PR_HEAD_SHA"';
    expect(() => renderPostingTemplate(template, { prHeadSha: SHA, prNumber: PR })).toThrow(
      /unreplaced SHA placeholder/,
    );
  });
});

describe('renderReplyTemplate', () => {
  it('substitutes {pr}, producing no leftover placeholder', () => {
    const template = 'gh api repos/{owner}/{repo}/pulls/{pr}/comments --input -';
    const rendered = renderReplyTemplate(template, PR);
    expect(rendered).not.toContain('{pr}');
    expect(rendered).toContain(`pulls/${PR}/comments`);
    expect(rendered).toContain('repos/{owner}/{repo}/pulls');
  });

  it.each([
    ['empty', ''],
    ['non-numeric', 'abc'],
    ['shell metacharacters', '111; echo INJECTED'],
  ])('fails closed on an invalid PR number (%s) instead of shipping an unrendered {pr}', (_name, prNumber) => {
    expect(() =>
      renderReplyTemplate('gh api repos/{owner}/{repo}/pulls/{pr}/comments', prNumber),
    ).toThrow(TemplateValidationError);
  });
});
