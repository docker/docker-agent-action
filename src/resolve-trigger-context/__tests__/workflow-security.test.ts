// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { findLastReviewedSha } from '../../incremental-review/incremental-review.js';
import { builtReviewAssessmentCli } from '../../review-assessment/__tests__/build-cli.js';
import { resolverOutputs } from '../index.js';
import type { CanonicalComment, CanonicalTriggerContext } from '../resolve-trigger-context.js';

const root = resolve(import.meta.dirname, '../../..');
// The review-assessment CLI harnesses run `node` from the rendered scripts,
// so the spawning node's own directory is prepended to the deterministic
// system-tool path.
const safePath = `${dirname(process.execPath)}${delimiter}/usr/bin:/bin`;

// Bundled once per test process (tsup, same shape as `pnpm build`): the
// production scripts under test execute this exact runtime artifact.
let reviewAssessmentCli = '';
beforeAll(async () => {
  reviewAssessmentCli = await builtReviewAssessmentCli();
});

function testEnvironment(values: Record<string, string>): NodeJS.ProcessEnv {
  return {
    HOME: '/tmp',
    PATH: safePath,
    TMPDIR: tmpdir(),
    ...values,
  };
}

type WorkflowStep = {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
  run?: string;
};

type WorkflowJob = {
  if?: string;
  outputs?: Record<string, string>;
  permissions?: Record<string, string>;
  steps?: WorkflowStep[];
};

type Workflow = {
  on?: Record<string, unknown>;
  jobs: Record<string, WorkflowJob>;
};

type Action = {
  runs?: { steps?: WorkflowStep[] };
};

function parseWorkflow(path: string): Workflow {
  return parseDocument(readFileSync(path, 'utf8')).toJS() as Workflow;
}

const workflow = parseWorkflow(resolve(root, '.github/workflows/review-pr.yml'));
const e2e = parseWorkflow(resolve(root, '.github/workflows/test-e2e.yml'));

function job(name: string): WorkflowJob {
  const result = workflow.jobs[name];
  if (!result) throw new Error(`Missing ${name} job`);
  return result;
}

function step(jobName: string, name: string): WorkflowStep {
  const result = job(jobName).steps?.find((candidate) => candidate.name === name);
  if (!result) throw new Error(`Missing ${name} step in ${jobName}`);
  return result;
}

function stepIndex(jobName: string, name: string): number {
  const result = job(jobName).steps?.findIndex((candidate) => candidate.name === name) ?? -1;
  if (result < 0) throw new Error(`Missing ${name} step in ${jobName}`);
  return result;
}

function values(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(values);
  if (value && typeof value === 'object') return Object.values(value).flatMap(values);
  return [];
}

function resolverOutputNames(): Set<string> {
  const context: CanonicalTriggerContext = {
    event: 'pull_request_review_comment',
    runId: 1,
    runHeadSha: 'a'.repeat(40),
    actor: 'actor',
    pullRequest: {
      number: 1,
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      baseRef: 'main',
      author: 'author',
    },
    comment: canonicalComment({ inReplyToId: 2 }),
  };
  return new Set(Object.keys(resolverOutputs(context)));
}

const canonicalContext: CanonicalTriggerContext = {
  event: 'pull_request_review_comment',
  runId: 123,
  runHeadSha: 'a'.repeat(40),
  actor: 'actor',
  pullRequest: {
    number: 1,
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    baseRef: 'main',
    author: 'author',
  },
  comment: {
    id: 1,
    author: 'author',
    authorType: 'User',
    body: '@docker-agent',
    inReplyToId: null,
    pullRequestUrl: 'https://api.github.com/repos/docker/docker-agent-action/pulls/1',
    path: 'src/example.ts',
    line: 42,
    originalLine: 40,
    side: 'RIGHT',
    startLine: 41,
    startSide: 'RIGHT',
    diffHunk: '@@ -40,3 +40,5 @@',
    commitId: 'a'.repeat(40),
    originalCommitId: 'b'.repeat(40),
  },
};

const canonicalGate = "needs.resolve-context.outputs.canonical-context-available == 'true'";

function extractedProjection(jobName: string, stepName: string): string {
  const run = step(jobName, stepName).run ?? '';
  const match = run.match(/\n\s*jq '([\s\S]*?)' "\$CANONICAL_CONTEXT" > "\$/);
  if (!match) throw new Error(`Missing canonical jq projection in ${jobName}/${stepName}`);
  return match[1];
}

function runJq(filter: string, context: CanonicalTriggerContext): unknown {
  const result = spawnSync('/usr/bin/jq', [filter], {
    input: JSON.stringify(context),
    encoding: 'utf8',
    env: testEnvironment({
      GITHUB_REPOSITORY: 'docker/docker-agent-action',
      GITHUB_REPOSITORY_OWNER: 'docker',
    }),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout);
}

function projectedComment(comment: CanonicalComment) {
  return {
    id: comment.id,
    body: comment.body,
    in_reply_to_id: comment.inReplyToId,
    path: comment.path,
    line: comment.line,
    original_line: comment.originalLine,
    side: comment.side,
    start_line: comment.startLine,
    start_side: comment.startSide,
    diff_hunk: comment.diffHunk,
    commit_id: comment.commitId,
    original_commit_id: comment.originalCommitId,
    user: { login: comment.author, type: comment.authorType },
  };
}

function mutateProjection(filter: string, anchor: string, source: string, kind: 'drop' | 'rename') {
  const member = new RegExp(`^(\\s*)${anchor}(?:: ([^\\n]+))?,`, 'm');
  const mutated = filter.replace(member, (_matched, indent: string, value?: string) => {
    if (kind === 'drop') return '';
    return `${indent}mutated_${anchor}: ${value ?? `.${source}`},`;
  });
  if (mutated === filter) throw new Error(`Could not ${kind} ${anchor}`);
  return mutated;
}

const artifactGate = "needs.resolve-context.outputs.canonical-context-artifact-id != ''";
const triggerRoute = "inputs.trigger-run-id != ''";

function canonicalComment(overrides: Partial<CanonicalComment> = {}): CanonicalComment {
  return {
    id: 1,
    author: 'author',
    authorType: 'User',
    body: '@docker-agent',
    inReplyToId: null,
    pullRequestUrl: 'https://api.github.com/repos/docker/docker-agent-action/pulls/1',
    path: 'src/example.ts',
    line: 42,
    originalLine: 40,
    side: 'RIGHT',
    startLine: 41,
    startSide: 'RIGHT',
    diffHunk: '@@ -40,3 +40,5 @@',
    commitId: 'a'.repeat(40),
    originalCommitId: 'b'.repeat(40),
    ...overrides,
  };
}

function routeContext(
  comment: CanonicalTriggerContext['comment'],
): Pick<CanonicalTriggerContext, 'event' | 'comment'> {
  return { event: 'pull_request_review_comment', comment };
}

function productionTriggerRoute(
  context: Pick<CanonicalTriggerContext, 'event' | 'comment'>,
): string {
  return resolverOutputs({
    ...context,
    runId: 1,
    runHeadSha: 'a'.repeat(40),
    headAdvanced: false,
    actor: 'actor',
    pullRequest: {
      number: 1,
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      baseRef: 'main',
      author: 'author',
    },
  })['trigger-route'];
}

const routingScenarios = [
  {
    name: 'threaded reply without a mention',
    context: routeContext(canonicalComment({ inReplyToId: 101 })),
    route: 'feedback',
  },
  {
    name: 'threaded reply with a mention',
    context: routeContext(canonicalComment({ inReplyToId: 101, body: '@docker-agent' })),
    route: 'feedback',
  },
  { name: 'top-level mention', context: routeContext(canonicalComment()), route: 'mention' },
  {
    name: 'review command',
    context: routeContext(canonicalComment({ body: '/review @docker-agent' })),
    route: 'none',
  },
  {
    name: 'ordinary top-level comment',
    context: routeContext(canonicalComment({ body: 'hello' })),
    route: 'none',
  },
] as const;

const artifactIdExpression =
  '${' + '{ needs.resolve-context.outputs.canonical-context-artifact-id }}';
const reviewShaExpression = '${' + '{ steps.pr.outputs.head-sha }}';
const feedbackShaExpression = '${' + '{ steps.feedback.outputs.pr-head-sha }}';
const githubTokenExpression = '${' + '{ github.token }}';
const uploadName =
  'trusted-trigger-context-${' + '{ github.run_id }}-${' + '{ github.run_attempt }}';

type Expression =
  | { kind: 'literal'; value: string | boolean }
  | { kind: 'path'; value: string }
  | { kind: 'call'; name: 'always' | 'contains' | 'startsWith'; args: Expression[] }
  | { kind: 'not'; operand: Expression }
  | { kind: 'binary'; operator: '&&' | '||' | '==' | '!='; left: Expression; right: Expression };

type ConditionTarget = {
  id: string;
  expression: string;
  job: string;
  scope: 'job' | 'step';
  step?: string;
};

type AtomicPredicate = {
  id: string;
  expression: Expression;
  category: ConditionCategory;
  target: string;
};

type ConditionCategory =
  | 'direct/workflow route selection'
  | 'bot/self guards'
  | 'requested-reviewer gate'
  | 'resolver-result guard'
  | 'canonical-availability gate'
  | 'artifact-ID gate'
  | 'reply-parent route split'
  | 'conjunction/&&→|| weakening';

const conditionStepInventory = [
  ['resolve-context', 'Setup credentials'],
  ['resolve-context', 'Verify token for cross-run artifact download'],
  ['resolve-context', 'Create trigger context directory'],
  ['resolve-context', 'Download trigger context'],
  ['resolve-context', 'Guard trigger context directory'],
  ['resolve-context', 'Resolve trusted trigger context'],
  ['resolve-context', 'Guard canonical trigger context before upload'],
  ['resolve-context', 'Upload canonical trigger context'],
  ['reply-to-feedback', 'Setup cross-run credentials'],
  ['reply-to-feedback', 'Verify token for cross-run artifact download'],
  ['reply-to-feedback', 'Validate canonical context artifact ID'],
  ['reply-to-feedback', 'Download canonical trigger context'],
  ['reply-to-feedback', 'Guard downloaded feedback context'],
  ['reply-to-mention', 'Validate canonical context artifact ID'],
  ['reply-to-mention', 'Download canonical trigger context'],
  ['reply-to-mention', 'Guard downloaded mention context'],
  ['reply-to-mention', 'Synthesize mention-reply event context'],
] as const;

function productionConditionTargets(): ConditionTarget[] {
  const targets: ConditionTarget[] = [
    'resolve-context',
    'review',
    'reply-to-feedback',
    'reply-to-mention',
  ].map((name) => ({
    id: `job:${name}`,
    expression: requiredCondition(job(name).if, `job ${name}`),
    job: name,
    scope: 'job',
  }));
  for (const [jobName, stepName] of conditionStepInventory) {
    targets.push({
      id: `step:${jobName}/${stepName}`,
      expression: requiredCondition(step(jobName, stepName).if, `${jobName}/${stepName}`),
      job: jobName,
      scope: 'step',
      step: stepName,
    });
  }
  return targets;
}

function requiredCondition(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`Missing condition for ${name}`);
  return value;
}

function tokenize(expression: string): string[] {
  const tokens = expression.match(
    /\s*(\|\||&&|==|!=|!|\(|\)|,|'[^']*'|[A-Za-z_][A-Za-z0-9_.-]*)\s*/g,
  );
  if (!tokens || tokens.join('').replace(/\s/g, '') !== expression.replace(/\s/g, ''))
    throw new Error(`Unsupported condition syntax: ${expression}`);
  return tokens.map((token) => token.trim());
}

function parseCondition(expression: string): Expression {
  const tokens = tokenize(expression);
  let index = 0;
  const peek = () => tokens[index];
  const take = () => tokens[index++];
  const consume = (token: string) => {
    if (peek() !== token) return false;
    index++;
    return true;
  };
  const primary = (): Expression => {
    const token = take();
    if (!token) throw new Error('Unexpected end of condition');
    if (token === '(') {
      const nested = or();
      if (!consume(')')) throw new Error('Missing closing parenthesis');
      return nested;
    }
    if (token.startsWith("'")) return { kind: 'literal', value: token.slice(1, -1) };
    if (token === 'true' || token === 'false') return { kind: 'literal', value: token === 'true' };
    if (consume('(')) {
      const args: Expression[] = [];
      if (peek() !== ')') {
        args.push(or());
        while (consume(',')) args.push(or());
      }
      if (!consume(')')) throw new Error(`Missing closing parenthesis for ${token}`);
      if (!['always', 'contains', 'startsWith'].includes(token))
        throw new Error(`Unsupported function: ${token}`);
      if ((token === 'always' && args.length !== 0) || (token !== 'always' && args.length !== 2))
        throw new Error(`Invalid arguments for ${token}`);
      return { kind: 'call', name: token as 'always' | 'contains' | 'startsWith', args };
    }
    return { kind: 'path', value: token };
  };
  const comparison = (): Expression => {
    let left = primary();
    while (peek() === '==' || peek() === '!=') {
      left = { kind: 'binary', operator: take() as '==' | '!=', left, right: primary() };
    }
    return left;
  };
  const unary = (): Expression => (consume('!') ? { kind: 'not', operand: unary() } : comparison());
  const and = (): Expression => {
    let left = unary();
    while (consume('&&')) left = { kind: 'binary', operator: '&&', left, right: unary() };
    return left;
  };
  const or = (): Expression => {
    let left = and();
    while (consume('||')) left = { kind: 'binary', operator: '||', left, right: and() };
    return left;
  };
  const result = or();
  if (index !== tokens.length) throw new Error(`Unexpected token: ${tokens[index]}`);
  return result;
}

function evaluateExpression(expression: Expression, bindings: Record<string, unknown>): unknown {
  switch (expression.kind) {
    case 'literal':
      return expression.value;
    case 'path':
      if (!(expression.value in bindings)) throw new Error(`Missing binding: ${expression.value}`);
      return bindings[expression.value];
    case 'call': {
      const args = expression.args.map((argument) => evaluateExpression(argument, bindings));
      if (expression.name === 'always') return true;
      if (expression.name === 'contains')
        return String(args[0] ?? '').includes(String(args[1] ?? ''));
      return String(args[0] ?? '').startsWith(String(args[1] ?? ''));
    }
    case 'not':
      return !evaluateExpression(expression.operand, bindings);
    case 'binary': {
      const left = evaluateExpression(expression.left, bindings);
      if (expression.operator === '&&')
        return Boolean(left) && Boolean(evaluateExpression(expression.right, bindings));
      if (expression.operator === '||')
        return Boolean(left) || Boolean(evaluateExpression(expression.right, bindings));
      const right = evaluateExpression(expression.right, bindings);
      return expression.operator === '==' ? left === right : left !== right;
    }
  }
}

function evaluateCondition(expression: string, bindings: Record<string, unknown>): boolean {
  return Boolean(evaluateExpression(parseCondition(expression), bindings));
}

function renderExpression(expression: Expression): string {
  switch (expression.kind) {
    case 'literal':
      return typeof expression.value === 'string'
        ? `'${expression.value}'`
        : String(expression.value);
    case 'path':
      return expression.value;
    case 'call':
      return `${expression.name}(${expression.args.map(renderExpression).join(', ')})`;
    case 'not':
      return `!${renderExpression(expression.operand)}`;
    case 'binary':
      return `(${renderExpression(expression.left)} ${expression.operator} ${renderExpression(expression.right)})`;
  }
}

function categoryFor(expression: Expression): ConditionCategory {
  const rendered = renderExpression(expression);
  if (expression.kind === 'binary' && expression.operator === '&&')
    return 'conjunction/&&→|| weakening';
  if (rendered.includes('requested_reviewer')) return 'requested-reviewer gate';
  if (rendered.includes('needs.resolve-context.result')) return 'resolver-result guard';
  if (rendered.includes('canonical-context-available')) return 'canonical-availability gate';
  if (rendered.includes('canonical-context-artifact-id') || rendered.includes('canonical-artifact'))
    return 'artifact-ID gate';
  if (rendered.includes('comment-in-reply-to-id') || rendered.includes('comment.in_reply_to_id'))
    return 'reply-parent route split';
  if (
    rendered.includes('comment-author') ||
    rendered.includes('comment.user.') ||
    rendered.includes('sender.')
  )
    return 'bot/self guards';
  return 'direct/workflow route selection';
}

function atomicPredicates(
  expression: Expression,
  target: string,
  path = 'root',
): AtomicPredicate[] {
  if (expression.kind === 'binary' && expression.operator === '&&')
    return [
      ...(path === 'root'
        ? [{ id: `${target}:${path}`, expression, category: categoryFor(expression), target }]
        : []),
      ...atomicPredicates(expression.left, target, `${path}.left`),
      ...atomicPredicates(expression.right, target, `${path}.right`),
    ];
  if (expression.kind === 'binary' && expression.operator === '||')
    return [
      ...atomicPredicates(expression.left, target, `${path}.left`),
      ...atomicPredicates(expression.right, target, `${path}.right`),
    ];
  return [{ id: `${target}:${path}`, expression, category: categoryFor(expression), target }];
}

function replaceExpression(
  expression: Expression,
  id: string,
  replacement: Expression,
  target: string,
  path = 'root',
): Expression {
  if (`${target}:${path}` === id) return replacement;
  if (expression.kind === 'not')
    return {
      ...expression,
      operand: replaceExpression(expression.operand, id, replacement, target, `${path}.operand`),
    };
  if (expression.kind === 'binary')
    return {
      ...expression,
      left: replaceExpression(expression.left, id, replacement, target, `${path}.left`),
      right: replaceExpression(expression.right, id, replacement, target, `${path}.right`),
    };
  if (expression.kind === 'call')
    return {
      ...expression,
      args: expression.args.map((argument, index) =>
        replaceExpression(argument, id, replacement, target, `${path}.arg${index}`),
      ),
    };
  return expression;
}

function mutateAtom(atom: Expression): Expression {
  if (atom.kind === 'binary' && atom.operator === '&&') return { ...atom, operator: '||' };
  if (atom.kind === 'binary' && atom.operator === '==') return { ...atom, operator: '!=' };
  if (atom.kind === 'binary' && atom.operator === '!=') return { ...atom, operator: '==' };
  if (atom.kind === 'not') return atom.operand;
  return { kind: 'not', operand: atom };
}

function canonicalBindings(
  route: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    'github.event_name': 'workflow_run',
    'github.event.action': '',
    'github.event.issue.pull_request': false,
    'github.event.comment.in_reply_to_id': false,
    'github.event.comment.user.login': '',
    'github.event.comment.user.type': '',
    'github.event.comment.body': '',
    'github.event.sender.type': '',
    'github.event.sender.login': '',
    'github.event.requested_reviewer.login': '',
    'inputs.pr-number': '',
    'inputs.trigger-run-id': '123',
    'needs.resolve-context.result': 'success',
    'needs.resolve-context.outputs.canonical-context-available': 'true',
    'needs.resolve-context.outputs.canonical-context-artifact-id': '456',
    'needs.resolve-context.outputs.trigger-event': 'pull_request_review_comment',
    'needs.resolve-context.outputs.trigger-route': route,
    'needs.resolve-context.outputs.comment-in-reply-to-id': route === 'feedback' ? '789' : '',
    'needs.resolve-context.outputs.comment-author': 'human',
    'needs.resolve-context.outputs.comment-author-type': 'User',
    ...overrides,
  };
}

function requiredComment(context: CanonicalTriggerContext): CommentContext {
  if (!context.comment) throw new Error('Scenario must include a comment');
  return context.comment;
}

function reviewActionSteps(): WorkflowStep[] {
  const action = parseDocument(
    readFileSync(resolve(root, 'review-pr/action.yml'), 'utf8'),
  ).toJS() as Action;
  return action.runs?.steps ?? [];
}

function reviewActionStep(name: string): WorkflowStep {
  const matches = reviewActionSteps().filter((candidate) => candidate.name === name);
  if (matches.length !== 1) throw new Error(`Expected one ${name} step`);
  return matches[0];
}

function actionStepRun(name: string): string {
  const run = reviewActionStep(name).run;
  if (!run) throw new Error(`Expected a ${name} run body`);
  return run;
}

function summaryRun(): string {
  return actionStepRun('Post clean summary');
}

const TEST_NONCE = '0123456789abcdef0123456789abcdef';
const TEST_MARKER = `<!-- docker-agent-review-run:${TEST_NONCE} -->`;

function runCopyReference(
  headSha: string,
  template: string,
  repository = 'docker/docker-agent-action',
  prNumber = '88',
  runNonce = TEST_NONCE,
): { result: ReturnType<typeof spawnSync>; rendered: string } {
  const directory = mkdtempSync(resolve(tmpdir(), 'docker-agent-copy-reference-'));
  const actionPath = resolve(directory, 'action');
  const refs = resolve(actionPath, 'agents/refs');
  const output = resolve(directory, 'output');
  const originalRefs = '/tmp/refs';
  const backupRefs = resolve(directory, 'refs-backup');
  try {
    if (existsSync(originalRefs))
      cpSync(originalRefs, backupRefs, { recursive: true, dereference: false });
    rmSync(originalRefs, { recursive: true, force: true });
    writeFileSync(resolve(directory, 'run.sh'), actionStepRun('Copy reference files'));
    writeFileSync(resolve(directory, 'posting-format.md'), template);
    cpSync(resolve(root, 'review-pr/agents/refs'), refs, { recursive: true });
    writeFileSync(resolve(refs, 'posting-format.md'), template);
    // The step hard-requires the bundled CLI at $ACTION_PATH/../dist.
    mkdirSync(resolve(directory, 'dist'), { recursive: true });
    cpSync(reviewAssessmentCli, resolve(directory, 'dist/review-assessment.js'));
    const result = spawnSync(
      '/bin/bash',
      ['--noprofile', '--norc', '-e', '-o', 'pipefail', resolve(directory, 'run.sh')],
      {
        env: testEnvironment({
          ACTION_PATH: actionPath,
          PR_HEAD_SHA: headSha,
          REPOSITORY: repository,
          PR_NUMBER: prNumber,
          RUN_NONCE: runNonce,
          GITHUB_OUTPUT: output,
        }),
        encoding: 'utf8',
      },
    );
    let rendered = '';
    if (result.status === 0) {
      expect(readFileSync(output, 'utf8')).toContain(
        'posting-reference=/tmp/refs/posting-format.md',
      );
      rendered = readFileSync(resolve(originalRefs, 'posting-format.md'), 'utf8');
    }
    return { result, rendered };
  } finally {
    rmSync(originalRefs, { recursive: true, force: true });
    if (existsSync(backupRefs))
      cpSync(backupRefs, originalRefs, { recursive: true, dereference: false });
    rmSync(directory, { recursive: true, force: true });
  }
}

type ReviewState = {
  id: number | null;
  /** Review author as the API reports it. */
  user?: { login?: string | null } | null;
  commit_id?: string;
  body?: string;
  /** COMMENTED / APPROVED / CHANGES_REQUESTED / PENDING as GitHub reports it. */
  state?: string;
};

type SummaryInvocation = {
  skipReason?: string;
  exitCode?: string;
  verboseLog?: string;
  chunkCount?: string;
  headSha?: string;
  postingReference?: string;
  /** BASELINE_MAX_REVIEW_ID env — the pre-run maximum review ID. */
  baseline?: string;
  /** RUN_NONCE env — this run's attribution nonce. */
  nonce?: string;
  /** Post-run review state the gh mock serves for the paginate lookup. */
  reviews?: ReviewState[];
  reviewsFetchFails?: boolean;
  postFails?: boolean;
};

type GhRecord = { args: string; input: string };

const summaryReviewsRoute = 'api --paginate repos/docker/docker-agent-action/pulls/88/reviews';

/**
 * Mock gh: records every invocation, serves the paginate reviews lookup from
 * GH_REVIEWS_FILE (or fails it when GH_REVIEWS_FETCH_FAILS=1), rejects empty
 * --input payloads like the real API, and fails posts when GH_POST_FAILS=1.
 */
function ghMock(): string {
  return `#!/usr/bin/env bash
set -euo pipefail
args="$*"
input=""
if [[ "$args" == *" --input -" ]]; then input=$(cat); fi
printf '%s\\n' "$(jq -cn --arg args "$args" --arg input "$input" '{args: $args, input: $input}')" >> "$GH_RECORDS"
if [[ "$args" == "${summaryReviewsRoute}" ]]; then
  if [[ "\${GH_REVIEWS_FETCH_FAILS:-}" == "1" ]]; then exit 1; fi
  cat "$GH_REVIEWS_FILE"
fi
if [[ "$args" == *" --input -" ]]; then
  if [[ -z "$input" ]]; then exit 22; fi
  if [[ "\${GH_POST_FAILS:-}" == "1" ]]; then exit 1; fi
fi
`;
}

function runSummary(invocation: SummaryInvocation): {
  result: ReturnType<typeof spawnSync>;
  records: GhRecord[];
  summary: string;
  outputs: string;
  directory: string;
} {
  const directory = mkdtempSync(resolve(tmpdir(), 'docker-agent-summary-'));
  const output = resolve(directory, 'output');
  const summary = resolve(directory, 'summary');
  const recordsPath = resolve(directory, 'gh-records.jsonl');
  const reviewsPath = resolve(directory, 'reviews.json');
  writeFileSync(recordsPath, '');
  writeFileSync(output, '');
  writeFileSync(summary, '');
  writeFileSync(reviewsPath, JSON.stringify(invocation.reviews ?? []));
  const reference = invocation.postingReference ?? resolve(directory, 'posting-format.md');
  const sha = invocation.headSha ?? 'a'.repeat(40);
  const nonce = invocation.nonce ?? TEST_NONCE;
  writeFileSync(resolve(directory, 'summary.sh'), summaryRun());
  if (!invocation.postingReference) {
    writeFileSync(
      reference,
      [
        `node /tmp/review-assessment.js finalize-body /tmp/review_body.md ${TEST_NONCE} /tmp/review_comments.json`,
        `jq -n --arg commit_id "${sha}" '{commit_id: $commit_id}' | gh api "repos/docker/docker-agent-action/pulls/88/reviews" --input -`,
      ].join('\n'),
    );
  }
  // The summary step classifies via the bundled CLI at $ACTION_PATH/../dist.
  const actionPath = resolve(directory, 'action');
  mkdirSync(actionPath, { recursive: true });
  mkdirSync(resolve(directory, 'dist'), { recursive: true });
  cpSync(reviewAssessmentCli, resolve(directory, 'dist/review-assessment.js'));
  if (invocation.verboseLog !== undefined)
    writeFileSync(resolve(directory, 'verbose.log'), invocation.verboseLog);
  writeFileSync(resolve(directory, 'gh'), ghMock());
  chmodSync(resolve(directory, 'gh'), 0o755);
  const result = spawnSync(
    '/bin/bash',
    [
      '--noprofile',
      '--norc',
      '-e',
      '-o',
      'pipefail',
      '-c',
      'source "$1"',
      'bash',
      resolve(directory, 'summary.sh'),
    ],
    {
      cwd: directory,
      env: testEnvironment({
        PATH: `${directory}${delimiter}${safePath}`,
        GH_RECORDS: recordsPath,
        GH_REVIEWS_FILE: reviewsPath,
        GH_REVIEWS_FETCH_FAILS: invocation.reviewsFetchFails ? '1' : '',
        GH_POST_FAILS: invocation.postFails ? '1' : '',
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
        REPOSITORY: 'docker/docker-agent-action',
        PR_NUMBER: '88',
        RUN_URL: 'https://example.test/run',
        SKIP_REASON: invocation.skipReason ?? '',
        EXIT_CODE: invocation.exitCode ?? '',
        VERBOSE_LOG_FILE:
          invocation.verboseLog === undefined ? '' : resolve(directory, 'verbose.log'),
        CHUNK_COUNT: invocation.chunkCount ?? '',
        LOCK_AGE: '',
        ACTION_PATH: actionPath,
        PR_HEAD_SHA: sha,
        POSTING_REFERENCE: reference,
        BASELINE_MAX_REVIEW_ID: invocation.baseline ?? '100',
        RUN_NONCE: nonce,
      }),
      encoding: 'utf8',
    },
  );
  const records = readFileSync(recordsPath, 'utf8', { flag: 'a+' })
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as GhRecord);
  return {
    result,
    records,
    summary: readFileSync(summary, 'utf8'),
    outputs: readFileSync(output, 'utf8'),
    directory,
  };
}

function reviewCreations(records: GhRecord[]): GhRecord[] {
  return records.filter(
    (record) => record.args === 'api repos/docker/docker-agent-action/pulls/88/reviews --input -',
  );
}

function expectReviewPayload(record: GhRecord, sha: string, bodyPrefix: string): void {
  expect(JSON.parse(record.input)).toEqual({
    body: expect.stringMatching(new RegExp(`^${bodyPrefix}`)),
    event: 'COMMENT',
    commit_id: sha,
    comments: [],
  });
}

describe('fork workflow security regressions', () => {
  it('connects every resolver producer, job output, and downstream consumer', () => {
    const resolveContext = job('resolve-context');
    const resolverStep = step('resolve-context', 'Resolve trusted trigger context');
    const producers = resolverOutputNames();
    expect(resolverStep.run).toContain('canonical-context-available');
    producers.add('canonical-context-available');

    for (const [name, expression] of Object.entries(resolveContext.outputs ?? {})) {
      const match = expression.match(/^\${{\s*steps\.read\.outputs\.([\w-]+)\s*}}$/);
      if (match) expect(producers, `${name} must be emitted by the resolver`).toContain(match[1]);
    }

    const exposedOutputs = new Set(Object.keys(resolveContext.outputs ?? {}));
    const downstreamReferences = new Set<string>();
    for (const [name, candidate] of Object.entries(workflow.jobs)) {
      if (name === 'resolve-context') continue;
      for (const value of values(candidate)) {
        for (const match of value.matchAll(/needs\.resolve-context\.outputs\.([\w-]+)/g)) {
          downstreamReferences.add(match[1]);
        }
      }
    }
    for (const output of downstreamReferences) {
      expect(exposedOutputs, `${output} must be exposed by resolve-context`).toContain(output);
    }
  });

  it.each(routingScenarios)('routes $name through the production trigger policy', ({
    context,
    route,
  }) => {
    const actualRoute = productionTriggerRoute(context);
    const routeToJob = { feedback: 'reply-to-feedback', mention: 'reply-to-mention' } as const;

    for (const jobName of ['review', 'reply-to-feedback', 'reply-to-mention'] as const) {
      const condition = job(jobName).if ?? '';
      const enabled = evaluateCondition(condition, canonicalBindings(actualRoute));
      expect(enabled, `${jobName} for ${actualRoute}`).toBe(
        actualRoute !== 'none' && routeToJob[actualRoute as keyof typeof routeToJob] === jobName,
      );
    }
    expect(actualRoute).toBe(route);
  });

  it('rejects unsupported syntax and kills a real routing mutation', () => {
    expect(() => evaluateCondition('unknown()', {})).toThrow('Unsupported function');
    expect(() =>
      evaluateCondition('github.event_name ==', { 'github.event_name': 'workflow_run' }),
    ).toThrow();

    const review = job('review').if ?? '';
    const target = "needs.resolve-context.outputs.trigger-route == 'review'";
    expect(review).toContain(target);
    const mutated = review.replace(
      target,
      "needs.resolve-context.outputs.trigger-route != 'review'",
    );
    const bindings = canonicalBindings('review', {
      'needs.resolve-context.outputs.trigger-event': 'pull_request',
    });
    expect(evaluateCondition(review, bindings)).toBe(true);
    expect(evaluateCondition(mutated, bindings)).toBe(false);
  });

  it('parses production condition ASTs and kills every categorized mutation with real route scenarios', () => {
    const targets = productionConditionTargets();
    expect(targets.map((target) => target.id)).toEqual([
      'job:resolve-context',
      'job:review',
      'job:reply-to-feedback',
      'job:reply-to-mention',
      ...conditionStepInventory.map(([jobName, stepName]) => `step:${jobName}/${stepName}`),
    ]);

    const parsed = targets.map((target) => ({ ...target, ast: parseCondition(target.expression) }));
    const atoms = parsed.flatMap((target) => atomicPredicates(target.ast, target.id));
    expect(new Set(atoms.map((atom) => atom.id)).size).toBe(atoms.length);
    const categories: ConditionCategory[] = [
      'direct/workflow route selection',
      'bot/self guards',
      'requested-reviewer gate',
      'resolver-result guard',
      'canonical-availability gate',
      'artifact-ID gate',
      'reply-parent route split',
      'conjunction/&&→|| weakening',
    ];
    for (const category of categories)
      expect(
        atoms.filter((atom) => atom.category === category),
        `${category} has no production atoms`,
      ).not.toHaveLength(0);

    const contexts = {
      review: { ...canonicalContext, event: 'pull_request', comment: undefined },
      feedback: {
        ...canonicalContext,
        comment: canonicalComment({ inReplyToId: 7, body: 'reply' }),
      },
      mention: { ...canonicalContext, comment: canonicalComment({ body: '@docker-agent' }) },
      none: { ...canonicalContext, comment: canonicalComment({ body: 'ordinary' }) },
      bot: {
        ...canonicalContext,
        comment: canonicalComment({ author: 'docker-agent', body: '@docker-agent' }),
      },
    } as const;

    const outputMappings = job('resolve-context').outputs ?? {};
    const outputBindings = (
      context: CanonicalTriggerContext,
      available = true,
      artifactId = '456',
    ) => {
      const outputs = resolverOutputs(context);
      const bindings: Record<string, unknown> = {};
      const artifactOutput = '${' + '{ steps.canonical-context.outputs.artifact-id }}';
      for (const [name, mapping] of Object.entries(outputMappings)) {
        const resolver = mapping.match(/^\${{\s*steps\.read\.outputs\.([\w-]+)\s*}}$/);
        if (resolver) {
          if (resolver[1] === 'canonical-context-available') {
            bindings[`needs.resolve-context.outputs.${name}`] = available ? 'true' : 'false';
            continue;
          }
          if (!(resolver[1] in outputs)) throw new Error(`No resolver producer for ${name}`);
          bindings[`needs.resolve-context.outputs.${name}`] = outputs[resolver[1]];
          continue;
        }
        if (mapping === artifactOutput) {
          bindings[`needs.resolve-context.outputs.${name}`] = artifactId;
          continue;
        }
        throw new Error(`Unsupported resolve-context output producer: ${name}=${mapping}`);
      }
      bindings['needs.resolve-context.outputs.canonical-context-available'] = available
        ? 'true'
        : 'false';
      return bindings;
    };

    const directBindings = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      'github.event_name': 'issue_comment',
      'github.event.action': 'created',
      'github.event.issue.pull_request': true,
      'github.event.comment.in_reply_to_id': '',
      'github.event.comment.user.login': 'human',
      'github.event.comment.user.type': 'User',
      'github.event.comment.body': 'ordinary',
      'github.event.sender.type': 'User',
      'github.event.sender.login': 'human',
      'github.event.requested_reviewer.login': '',
      'inputs.pr-number': '',
      'inputs.trigger-run-id': '',
      'needs.resolve-context.result': 'skipped',
      'needs.resolve-context.outputs.canonical-context-available': 'false',
      'needs.resolve-context.outputs.canonical-context-artifact-id': '',
      'needs.resolve-context.outputs.trigger-event': '',
      'needs.resolve-context.outputs.trigger-route': '',
      'needs.resolve-context.outputs.comment-in-reply-to-id': '',
      'needs.resolve-context.outputs.comment-author': '',
      'needs.resolve-context.outputs.comment-author-type': '',
      'steps.context-exists.outputs.exists': 'true',
      'steps.read.outputs.canonical-context-available': 'true',
      'steps.canonical-artifact.outputs.valid': 'true',
      ...overrides,
    });
    const workflowBindings = (
      context: CanonicalTriggerContext,
      overrides: Record<string, unknown> = {},
    ) =>
      directBindings({
        'github.event_name': 'workflow_run',
        'github.event.action': '',
        'github.event.issue.pull_request': false,
        'inputs.trigger-run-id': '123',
        'needs.resolve-context.result': 'success',
        ...outputBindings(context),
        ...overrides,
      });

    const scenarios = [
      {
        name: 'direct issue protected marker denied',
        bindings: directBindings({ 'github.event.comment.body': '<!-- docker-agent-review -->' }),
        routes: [],
      },
      {
        name: 'direct issue mention',
        bindings: directBindings({ 'github.event.comment.body': '@docker-agent' }),
        routes: ['review', 'reply-to-mention'],
      },
      {
        name: 'direct issue command',
        bindings: directBindings({ 'github.event.comment.body': '/review' }),
        routes: ['review'],
      },
      { name: 'direct issue ordinary', bindings: directBindings(), routes: ['review'] },
      {
        name: 'direct pull request automatic',
        bindings: directBindings({
          'github.event_name': 'pull_request',
          'github.event.action': 'synchronize',
        }),
        routes: ['review'],
      },
      {
        name: 'direct pull request unsupported action',
        bindings: directBindings({
          'github.event_name': 'pull_request',
          'github.event.action': 'closed',
        }),
        routes: ['review'],
      },
      {
        name: 'direct requested reviewer',
        bindings: directBindings({
          'github.event_name': 'pull_request',
          'github.event.action': 'review_requested',
          'github.event.requested_reviewer.login': 'docker-agent',
        }),
        routes: ['review'],
      },
      {
        name: 'direct requested reviewer mismatch',
        bindings: directBindings({
          'github.event_name': 'pull_request',
          'github.event.action': 'review_requested',
          'github.event.requested_reviewer.login': 'other',
        }),
        routes: [],
      },
      {
        name: 'direct feedback reply',
        bindings: directBindings({
          'github.event_name': 'pull_request_review_comment',
          'github.event.comment.in_reply_to_id': 7,
        }),
        routes: ['reply-to-feedback'],
      },
      {
        name: 'direct inline mention',
        bindings: directBindings({
          'github.event_name': 'pull_request_review_comment',
          'github.event.comment.body': '@docker-agent',
        }),
        routes: ['reply-to-mention'],
      },
      {
        name: 'direct bot denied',
        bindings: directBindings({
          'github.event.comment.body': '@docker-agent',
          'github.event.comment.user.login': 'docker-agent',
          'github.event.sender.login': 'docker-agent',
        }),
        routes: [],
      },
      { name: 'workflow review', bindings: workflowBindings(contexts.review), routes: ['review'] },
      {
        name: 'workflow feedback',
        bindings: workflowBindings(contexts.feedback),
        routes: ['reply-to-feedback'],
      },
      {
        name: 'workflow mention',
        bindings: workflowBindings(contexts.mention),
        routes: ['reply-to-mention'],
      },
      { name: 'workflow no route', bindings: workflowBindings(contexts.none), routes: [] },
      {
        name: 'workflow unavailable',
        bindings: workflowBindings(contexts.mention, {
          'needs.resolve-context.outputs.canonical-context-available': 'false',
        }),
        routes: [],
      },
      {
        name: 'workflow no artifact',
        bindings: workflowBindings(contexts.mention, {
          'needs.resolve-context.outputs.canonical-context-artifact-id': '',
        }),
        routes: [],
      },
      {
        name: 'workflow resolver failure',
        bindings: workflowBindings(contexts.mention, { 'needs.resolve-context.result': 'failure' }),
        routes: [],
      },
      {
        name: 'workflow resolver cancelled',
        bindings: workflowBindings(contexts.mention, {
          'needs.resolve-context.result': 'cancelled',
          'needs.resolve-context.outputs.canonical-context-available': 'false',
        }),
        routes: [],
      },
      { name: 'workflow bot denied', bindings: workflowBindings(contexts.bot), routes: [] },
    ];

    const downstreamConditions = new Map(
      parsed
        .filter((target) => target.scope === 'job' && target.id !== 'job:resolve-context')
        .map((target) => [target.job, target.ast]),
    );
    for (const scenario of scenarios) {
      expect(
        Boolean(evaluateExpression(parsed[0].ast, scenario.bindings)),
        `${scenario.name}: resolver entry`,
      ).toBe(scenario.bindings['inputs.trigger-run-id'] !== '');
      const enabled = ['review', 'reply-to-feedback', 'reply-to-mention'].filter((name) => {
        const condition = downstreamConditions.get(name);
        if (!condition) throw new Error(`Missing job condition: ${name}`);
        return Boolean(evaluateExpression(condition, scenario.bindings));
      });
      expect(enabled, scenario.name).toEqual(scenario.routes);
    }

    let killed = 0;
    for (const target of parsed) {
      for (const atom of atomicPredicates(target.ast, target.id)) {
        const mutant = replaceExpression(
          target.ast,
          atom.id,
          mutateAtom(atom.expression),
          target.id,
        );
        expect(renderExpression(mutant), `${atom.category}/${atom.id} was a no-op`).not.toBe(
          renderExpression(target.ast),
        );
        const killer = scenarios.find(
          (scenario) =>
            Boolean(evaluateExpression(target.ast, scenario.bindings)) !==
            Boolean(evaluateExpression(mutant, scenario.bindings)),
        );
        expect(
          killer,
          `${atom.category}/${atom.id}/${renderExpression(atom.expression)}`,
        ).toBeDefined();
        killed++;
      }
    }
    expect(killed).toBe(atoms.length);
  });

  it('executes canonical comment projections and kills every anchor mutation', () => {
    const anchors = [
      ['path', 'path'],
      ['line', 'line'],
      ['original_line', 'originalLine'],
      ['side', 'side'],
      ['start_line', 'startLine'],
      ['start_side', 'startSide'],
      ['diff_hunk', 'diffHunk'],
      ['commit_id', 'commitId'],
      ['original_commit_id', 'originalCommitId'],
    ] as const;
    const contexts = [
      { ...canonicalContext, comment: { ...canonicalContext.comment, inReplyToId: 1 } },
      {
        ...canonicalContext,
        comment: {
          ...canonicalContext.comment,
          inReplyToId: 1,
          path: null,
          line: null,
          originalLine: null,
          side: null,
          startLine: null,
          startSide: null,
          diffHunk: null,
          commitId: null,
          originalCommitId: null,
        },
      },
    ];
    const projections = [
      ['feedback', extractedProjection('reply-to-feedback', 'Parse comment context')],
      [
        'mention',
        extractedProjection('reply-to-mention', 'Synthesize mention-reply event context'),
      ],
    ] as const;
    let kills = 0;

    for (const [projectionName, projection] of projections) {
      for (const context of contexts) {
        const expectedComment = projectedComment(requiredComment(context));
        const expected =
          projectionName === 'feedback'
            ? expectedComment
            : expect.objectContaining({ comment: expectedComment });
        expect(runJq(projection, context)).toEqual(expected);
      }
      for (const [anchor, source] of anchors) {
        for (const kind of ['drop', 'rename'] as const) {
          const mutant = mutateProjection(projection, anchor, source, kind);
          for (const context of contexts) {
            const actual = runJq(mutant, context);
            const expectedComment = projectedComment(requiredComment(context));
            const expected =
              projectionName === 'feedback'
                ? expectedComment
                : expect.objectContaining({ comment: expectedComment });
            expect(actual).not.toEqual(expected);
            kills++;
          }
        }
      }
    }
    expect(kills).toBe(72);
  });

  const summarySha = 'a'.repeat(40);
  const summaryOtherSha = 'b'.repeat(40);
  const postedReview = (id = 101, commitId = summarySha, login = 'docker-agent'): ReviewState => ({
    id,
    user: { login },
    commit_id: commitId,
    body: `### Assessment: 🟡 NEEDS ATTENTION\n\n${TEST_MARKER}\n`,
    state: 'COMMENTED',
  });
  const unmarkedReview = (
    id = 101,
    commitId = summarySha,
    login = 'docker-agent',
  ): ReviewState => ({
    id,
    user: { login },
    commit_id: commitId,
    body: '### Assessment: 🟡 NEEDS ATTENTION',
    state: 'COMMENTED',
  });
  const agentStatusReview = (header: string): ReviewState => ({
    id: 101,
    user: { login: 'github-actions[bot]' },
    commit_id: summarySha,
    body: `${header}\nchunk 2: Drafter did not complete\n\n${TEST_MARKER}\n`,
    state: 'COMMENTED',
  });
  const noticeReview = (commitId: string, login = 'docker-agent'): ReviewState => ({
    id: 60,
    user: { login },
    commit_id: commitId,
    body: '⚠️ **Review incomplete** — The review agent finished without posting a review.',
    state: 'COMMENTED',
  });

  it.each([
    {
      name: 'API-verified success (verbose log says nothing)',
      exitCode: '0',
      verboseLog: 'no review',
      reviews: [postedReview()],
      status: 'completed',
      body: undefined,
    },
    {
      name: 'exit 0 with only a log-quoted review ID (no-post fallback)',
      // The regression the API baseline fixes: an old review ID mentioned in
      // the verbose log must never count as evidence this run posted a review.
      exitCode: '0',
      verboseLog: 'replying about pullrequestreview-999 from an old run',
      reviews: [],
      status: 'incomplete',
      body: '⚠️ \\*\\*Review incomplete\\*\\*',
    },
    {
      name: 'exit 0 with only a fresh human review on a different SHA',
      exitCode: '0',
      verboseLog: 'no review',
      reviews: [unmarkedReview(101, summaryOtherSha, 'human-reviewer')],
      status: 'incomplete',
      body: '⚠️ \\*\\*Review incomplete\\*\\*',
    },
    {
      name: 'exit 0 with only a pre-baseline unmarked bot review on the selected SHA',
      exitCode: '0',
      verboseLog: 'no review',
      reviews: [unmarkedReview(100)],
      status: 'incomplete',
      body: '⚠️ \\*\\*Review incomplete\\*\\*',
    },
    {
      name: 'exit 0 without a verbose log and no posted review',
      exitCode: '0',
      reviews: [],
      status: 'incomplete',
      body: '⚠️ \\*\\*Review incomplete\\*\\*',
    },
    {
      name: 'exit 0 with a fresh marker review posted by the app-token identity',
      exitCode: '0',
      verboseLog: 'no review',
      reviews: [postedReview(101, summarySha, 'docker-agent[bot]')],
      status: 'completed',
      body: undefined,
    },
    {
      // The github-token input defaults to github.token, which posts as
      // github-actions[bot]; a custom PAT posts as an arbitrary machine user.
      // Attribution is by exact marker, so both complete.
      name: 'exit 0 with a fresh marker review posted by the default-token identity',
      exitCode: '0',
      verboseLog: 'no review',
      reviews: [postedReview(101, summarySha, 'github-actions[bot]')],
      status: 'completed',
      body: undefined,
    },
    {
      name: 'exit 0 with a fresh marker review posted by a consumer machine user',
      exitCode: '0',
      verboseLog: 'no review',
      reviews: [postedReview(101, summarySha, 'consumer-machine-user')],
      status: 'completed',
      body: undefined,
    },
    {
      name: 'exit 0 with a fresh same-SHA unmarked review from a human (unrelated)',
      exitCode: '0',
      verboseLog: 'no review',
      reviews: [unmarkedReview(101, summarySha, 'human-reviewer')],
      status: 'incomplete',
      body: '⚠️ \\*\\*Review incomplete\\*\\*',
    },
    {
      // The agent honestly posted an incomplete review (unreviewed chunks):
      // that semantic status stands — no duplicate notice, never completed.
      name: 'exit 0 with an agent-posted incomplete review body',
      exitCode: '0',
      verboseLog: 'no review',
      reviews: [agentStatusReview('### ⚠️ Review incomplete')],
      status: 'incomplete',
      body: undefined,
    },
    {
      name: 'exit 0 with an agent-posted inconclusive review body',
      exitCode: '0',
      verboseLog: 'no review',
      reviews: [agentStatusReview('### ⚠️ Verification inconclusive')],
      status: 'inconclusive',
      body: undefined,
    },
    {
      name: 'incomplete notice already posted for this SHA',
      exitCode: '0',
      verboseLog: 'no review',
      reviews: [noticeReview(summarySha)],
      status: 'incomplete',
      body: undefined,
    },
    {
      name: 'incomplete notice from the app-token identity dedups',
      exitCode: '0',
      verboseLog: 'no review',
      reviews: [noticeReview(summarySha, 'docker-agent[bot]')],
      status: 'incomplete',
      body: undefined,
    },
    {
      name: 'incomplete notice from a human on this SHA never dedups',
      exitCode: '0',
      verboseLog: 'no review',
      reviews: [noticeReview(summarySha, 'human-reviewer')],
      status: 'incomplete',
      body: '⚠️ \\*\\*Review incomplete\\*\\*',
    },
    {
      name: 'incomplete notice on another SHA never dedups',
      exitCode: '0',
      verboseLog: 'no review',
      reviews: [noticeReview(summaryOtherSha)],
      status: 'incomplete',
      body: '⚠️ \\*\\*Review incomplete\\*\\*',
    },
    {
      name: 'timeout with unknown chunks',
      exitCode: '124',
      verboseLog: 'no review',
      chunkCount: '',
      status: 'timed-out',
      body: '⏱️',
    },
    {
      name: 'timeout with one chunk',
      exitCode: '124',
      verboseLog: 'no review',
      chunkCount: '1',
      status: 'timed-out',
      body: '⏱️',
    },
    {
      name: 'timeout with many chunks',
      exitCode: '124',
      verboseLog: 'no review',
      chunkCount: '2',
      status: 'timed-out',
      body: '⏱️',
    },
    {
      name: 'timeout after this run posted its review (no redundant fallback)',
      exitCode: '124',
      verboseLog: 'no review',
      reviews: [postedReview()],
      status: 'completed-with-warnings',
      body: undefined,
    },
    {
      // Exit 124 after an agent-posted incomplete review keeps the semantic
      // status — no duplicate timeout fallback next to the posted review.
      name: 'timeout after an agent-posted incomplete review',
      exitCode: '124',
      verboseLog: 'no review',
      chunkCount: '1',
      reviews: [agentStatusReview('### ⚠️ Review incomplete')],
      status: 'incomplete',
      body: undefined,
    },
    {
      name: 'timeout after an agent-posted inconclusive review',
      exitCode: '124',
      verboseLog: 'no review',
      chunkCount: '1',
      reviews: [agentStatusReview('### ⚠️ Verification inconclusive')],
      status: 'inconclusive',
      body: undefined,
    },
    {
      name: 'timeout with only a fresh same-SHA human review still posts the fallback',
      exitCode: '124',
      verboseLog: 'no review',
      chunkCount: '1',
      reviews: [unmarkedReview(101, summarySha, 'human-reviewer')],
      status: 'timed-out',
      body: '⏱️',
    },
    {
      name: 'non-124 failure without a posted review despite a log marker',
      exitCode: '1',
      verboseLog: 'pullrequestreview-1',
      reviews: [],
      status: 'failed',
      body: '❌',
    },
    {
      name: 'non-124 failure with only a fresh same-SHA human review',
      exitCode: '1',
      verboseLog: 'no review',
      reviews: [unmarkedReview(101, summarySha, 'human-reviewer')],
      status: 'failed',
      body: '❌',
    },
    {
      name: 'non-124 failure with an API-verified posted review',
      exitCode: '1',
      verboseLog: 'no review',
      reviews: [postedReview()],
      status: 'completed-with-warnings',
      body: undefined,
    },
    {
      // Nonzero exit after an agent-posted incomplete review keeps the
      // semantic status — no duplicate failure fallback.
      name: 'non-124 failure after an agent-posted incomplete review',
      exitCode: '1',
      verboseLog: 'no review',
      reviews: [agentStatusReview('### ⚠️ Review incomplete')],
      status: 'incomplete',
      body: undefined,
    },
    {
      name: 'non-124 failure after an agent-posted inconclusive review',
      exitCode: '1',
      verboseLog: 'no review',
      reviews: [agentStatusReview('### ⚠️ Verification inconclusive')],
      status: 'inconclusive',
      body: undefined,
    },
  ])('executes the summary $name vector with exact review payload behavior', (vector) => {
    const run = runSummary(vector);
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.outputs).toContain(`review-status=${vector.status}`);
      // Exactly one authoritative API state lookup; the old per-branch --jq
      // queries are gone.
      expect(run.records.filter((record) => record.args === summaryReviewsRoute)).toHaveLength(1);
      expect(run.records.filter((record) => record.args.includes(' --jq '))).toHaveLength(0);
      const creations = reviewCreations(run.records);
      expect(creations).toHaveLength(vector.body ? 1 : 0);
      if (vector.body) expectReviewPayload(creations[0], summarySha, vector.body);
      // Fail-closed: no summary-step fallback may ever synthesize an approval
      // or advance the incremental checkpoint (the false-LGTM regression:
      // docker/gordon PRs #1798/#1803/#1808/#1809).
      for (const creation of creations) {
        const body = (JSON.parse(creation.input) as { body: string }).body;
        expect(body).not.toContain('### Assessment:');
        expect(body).not.toMatch(/LGTM|No issues found/);
        // The trusted step mechanically embeds this run's attribution marker
        // in every fallback notice — rate counting stays login-independent.
        expect(body).toContain(TEST_MARKER);
        // Never a checkpoint, whichever identity posted the fallback.
        for (const login of ['docker-agent', 'github-actions[bot]']) {
          expect(
            findLastReviewedSha([
              {
                user: { login },
                body,
                commit_id: summarySha,
                submitted_at: '2026-01-01T00:00:00Z',
              },
            ]),
          ).toBeNull();
        }
      }
    } finally {
      rmSync(run.directory, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: 'missing pre-run baseline',
      invocation: { exitCode: '0', verboseLog: 'no review', baseline: '' },
      diagnostic: 'Pre-run review baseline is missing or unreadable',
      apiCalls: 0,
    },
    {
      name: 'garbled pre-run baseline',
      invocation: { exitCode: '0', verboseLog: 'no review', baseline: '12x' },
      diagnostic: 'Pre-run review baseline is missing or unreadable',
      apiCalls: 0,
    },
    {
      name: 'missing run attribution nonce',
      invocation: { exitCode: '0', verboseLog: 'no review', nonce: '' },
      diagnostic: 'Run attribution nonce is missing or malformed',
      apiCalls: 0,
    },
    {
      name: 'malformed run attribution nonce',
      invocation: { exitCode: '0', verboseLog: 'no review', nonce: 'abc123' },
      diagnostic: 'Run attribution nonce is missing or malformed',
      apiCalls: 0,
    },
    {
      name: 'post-run review lookup failure on exit 0',
      invocation: { exitCode: '0', verboseLog: 'no review', reviewsFetchFails: true },
      diagnostic: 'Post-run review lookup failed',
      apiCalls: 1,
    },
    {
      name: 'post-run review lookup failure on a nonzero exit',
      invocation: { exitCode: '1', verboseLog: 'pullrequestreview-1', reviewsFetchFails: true },
      diagnostic: 'Post-run review lookup failed',
      apiCalls: 1,
    },
    {
      // A stale/copied marker off this run's SHA or baseline is exactly the
      // ambiguity the classifier refuses to interpret.
      name: 'marker-bearing review on a different SHA',
      invocation: {
        exitCode: '0',
        verboseLog: 'no review',
        reviews: [postedReview(101, summaryOtherSha)],
      },
      diagnostic: 'Posted-review state is ambiguous',
      apiCalls: 1,
    },
    {
      name: 'marker-bearing review at the pre-run baseline',
      invocation: { exitCode: '0', verboseLog: 'no review', reviews: [postedReview(100)] },
      diagnostic: 'Posted-review state is ambiguous',
      apiCalls: 1,
    },
    {
      name: 'duplicate exact-marker reviews',
      invocation: {
        exitCode: '0',
        verboseLog: 'no review',
        reviews: [postedReview(101), postedReview(102)],
      },
      diagnostic: 'Posted-review state is ambiguous',
      apiCalls: 1,
    },
    {
      name: 'marker-bearing review in a non-COMMENTED state',
      invocation: {
        exitCode: '0',
        verboseLog: 'no review',
        reviews: [{ ...postedReview(), state: 'PENDING' }],
      },
      diagnostic: 'Posted-review state is ambiguous',
      apiCalls: 1,
    },
    {
      name: 'marker-bearing review in an APPROVED state',
      invocation: {
        exitCode: '0',
        verboseLog: 'no review',
        reviews: [{ ...postedReview(), state: 'APPROVED' }],
      },
      diagnostic: 'Posted-review state is ambiguous',
      apiCalls: 1,
    },
    {
      name: 'marker-bearing review without a status line (malformed body)',
      invocation: {
        exitCode: '0',
        verboseLog: 'no review',
        reviews: [{ ...postedReview(), body: `some prose\n\n${TEST_MARKER}\n` }],
      },
      diagnostic: 'Posted-review state is ambiguous',
      apiCalls: 1,
    },
    {
      name: 'marker-bearing review with conflicting status markers',
      invocation: {
        exitCode: '0',
        verboseLog: 'no review',
        reviews: [
          {
            ...postedReview(),
            body: `### ⚠️ Review incomplete\n### Assessment: 🟢 NO FINDINGS\n\n${TEST_MARKER}\n`,
          },
        ],
      },
      diagnostic: 'Posted-review state is ambiguous',
      apiCalls: 1,
    },
    {
      name: 'marker-bearing review with active LGTM wording',
      invocation: {
        exitCode: '0',
        verboseLog: 'no review',
        reviews: [
          {
            ...postedReview(),
            body: `### Assessment: 🟢 NO FINDINGS\n\nLGTM!\n\n${TEST_MARKER}\n`,
          },
        ],
      },
      diagnostic: 'Posted-review state is ambiguous',
      apiCalls: 1,
    },
    {
      name: 'marker-bearing review with active APPROVE wording',
      invocation: {
        exitCode: '124',
        verboseLog: 'no review',
        reviews: [
          {
            ...postedReview(),
            body: `### Assessment: 🟢 APPROVE\n\n${TEST_MARKER}\n`,
          },
        ],
      },
      diagnostic: 'Posted-review state is ambiguous',
      apiCalls: 1,
    },
    {
      // A fresh same-SHA bot review without the marker means the template was
      // bypassed or another integration posted mid-run — unattributable.
      name: 'fresh same-SHA docker-agent review without a marker',
      invocation: { exitCode: '0', verboseLog: 'no review', reviews: [unmarkedReview(101)] },
      diagnostic: 'Posted-review state is ambiguous',
      apiCalls: 1,
    },
  ])('fails closed on $name instead of trusting the exit code', ({
    invocation,
    diagnostic,
    apiCalls,
  }) => {
    const run = runSummary(invocation);
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain(diagnostic);
      expect(run.outputs).toContain('review-status=unverified');
      expect(run.records).toHaveLength(apiCalls);
      expect(reviewCreations(run.records)).toEqual([]);
      expect(run.summary).toContain('Review outcome unverified');
      expect(run.summary).not.toContain('Review completed');
    } finally {
      rmSync(run.directory, { recursive: true, force: true });
    }
  });

  it('fails the step when the incomplete-review notice cannot be posted', () => {
    // A silent no-post run whose notice also fails must surface as a failing
    // step — never a warning-only false success — with an honest summary.
    const run = runSummary({ exitCode: '0', verboseLog: 'no review', postFails: true });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stdout).toContain('Failed to post the incomplete-review notice');
      const creations = reviewCreations(run.records);
      expect(creations).toHaveLength(1);
      expectReviewPayload(creations[0], summarySha, '⚠️ \\*\\*Review incomplete\\*\\*');
      expect(run.outputs).toContain('review-status=incomplete');
      expect(run.summary).toContain('Review incomplete');
      expect(run.summary).not.toContain('✅');
    } finally {
      rmSync(run.directory, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: 'timeout notice',
      invocation: { exitCode: '124', verboseLog: 'no review', postFails: true },
      status: 'timed-out',
      bodyPrefix: '⏱️',
      diagnostic: 'Failed to post the timeout notice',
      summaryStatus: '⏱️ **Review timed out**',
    },
    {
      name: 'failure notice',
      invocation: { exitCode: '1', verboseLog: 'no review', postFails: true },
      status: 'failed',
      bodyPrefix: '❌',
      diagnostic: 'Failed to post the failure notice',
      summaryStatus: '❌ **Review failed**',
    },
  ])('fails the step when the $name cannot be posted', ({
    invocation,
    status,
    bodyPrefix,
    diagnostic,
    summaryStatus,
  }) => {
    // A no-post run whose fallback notice also fails must hard-fail like the
    // incomplete-notice path, while keeping the honest status and summary so
    // the completion reaction stays confused.
    const run = runSummary(invocation);
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stdout).toContain(diagnostic);
      const creations = reviewCreations(run.records);
      expect(creations).toHaveLength(1);
      expectReviewPayload(creations[0], summarySha, bodyPrefix);
      expect(run.outputs).toContain(`review-status=${status}`);
      expect(run.summary).toContain(summaryStatus);
      expect(run.summary).not.toContain('✅');
    } finally {
      rmSync(run.directory, { recursive: true, force: true });
    }
  });

  it('reports a coherent partial success when the timeout hit after this run posted', () => {
    const run = runSummary({ exitCode: '124', verboseLog: 'no review', reviews: [postedReview()] });
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.outputs).toContain('review-status=completed-with-warnings');
      expect(reviewCreations(run.records)).toEqual([]);
      expect(run.summary).toContain('Review completed with warnings');
      expect(run.summary).not.toContain('**Review timed out**');
    } finally {
      rmSync(run.directory, { recursive: true, force: true });
    }
  });

  it('does not inherit a poisoned PATH when executing the summary harness', () => {
    const poison = mkdtempSync(resolve(tmpdir(), 'docker-agent-poisoned-path-'));
    const previousPath = process.env.PATH;
    try {
      writeFileSync(resolve(poison, 'jq'), '#!/bin/sh\necho poisoned >&2\nexit 97\n');
      chmodSync(resolve(poison, 'jq'), 0o755);
      process.env.PATH = poison;

      const run = runSummary({ exitCode: '0', verboseLog: 'no review' });
      try {
        expect(run.result.status, run.result.stderr).toBe(0);
        expect(run.result.stderr).not.toContain('poisoned');
      } finally {
        rmSync(run.directory, { recursive: true, force: true });
      }
    } finally {
      process.env.PATH = previousPath;
      rmSync(poison, { recursive: true, force: true });
    }
  });

  it.each([
    ['', 'Selected PR head SHA is invalid'],
    ['g'.repeat(40), 'Selected PR head SHA is invalid'],
    ['a'.repeat(39), 'Selected PR head SHA is invalid'],
    ['a'.repeat(41), 'Selected PR head SHA is invalid'],
  ])('executes malformed SHA preflight %s without API access', (headSha, diagnostic) => {
    const run = runSummary({ exitCode: '124', verboseLog: 'no review', headSha });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain(diagnostic);
      expect(run.records).toEqual([]);
    } finally {
      rmSync(run.directory, { recursive: true, force: true });
    }
  });

  it.each([
    ['missing reference', undefined, 'does not contain exactly one'],
    [
      'retained template marker',
      'jq -n --arg commit_id "__PR_HEAD_SHA__"',
      'does not contain exactly one',
    ],
    [
      'retained shell marker',
      'jq -n --arg commit_id "$PR_HEAD_SHA"',
      'does not contain exactly one',
    ],
    ['zero commit argument', 'jq -n', 'does not contain exactly one'],
    [
      'multiple commit arguments',
      'jq -n --arg commit_id "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" --arg commit_id "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
      'does not contain exactly one',
    ],
    [
      'selected/rendered SHA mismatch',
      'jq -n --arg commit_id "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"',
      'does not contain exactly one',
    ],
    [
      'missing posting route',
      `jq -n --arg commit_id "${'a'.repeat(40)}"`,
      'does not route to exactly the trusted repository/PR',
    ],
    [
      'literal route placeholders',
      `jq -n --arg commit_id "${'a'.repeat(40)}" | gh api repos/{owner}/{repo}/pulls/{pr}/reviews --input -`,
      'does not route to exactly the trusted repository/PR',
    ],
    [
      'retained repository marker',
      `jq -n --arg commit_id "${'a'.repeat(40)}" | gh api "repos/__REPOSITORY__/pulls/88/reviews" --input -`,
      'does not route to exactly the trusted repository/PR',
    ],
    [
      'untrusted hardcoded route',
      `jq -n --arg commit_id "${'a'.repeat(40)}" | gh api "repos/evil/elsewhere/pulls/1/reviews" --input -`,
      'does not route to exactly the trusted repository/PR',
    ],
    [
      'duplicate posting routes',
      `jq -n --arg commit_id "${'a'.repeat(40)}"\ngh api "repos/docker/docker-agent-action/pulls/88/reviews" --input -\ngh api "repos/docker/docker-agent-action/pulls/88/reviews" --input -`,
      'does not route to exactly the trusted repository/PR',
    ],
    [
      'missing finalize-body invocation',
      `jq -n --arg commit_id "${'a'.repeat(40)}"\ngh api "repos/docker/docker-agent-action/pulls/88/reviews" --input -`,
      "does not carry exactly this run's finalize-body invocation",
    ],
    [
      'retained nonce placeholder',
      `node /tmp/review-assessment.js finalize-body /tmp/review_body.md __REVIEW_RUN_NONCE__ /tmp/review_comments.json\njq -n --arg commit_id "${'a'.repeat(40)}"\ngh api "repos/docker/docker-agent-action/pulls/88/reviews" --input -`,
      "does not carry exactly this run's finalize-body invocation",
    ],
    [
      'stale nonce in the finalize invocation',
      `node /tmp/review-assessment.js finalize-body /tmp/review_body.md ${'f'.repeat(32)} /tmp/review_comments.json\njq -n --arg commit_id "${'a'.repeat(40)}"\ngh api "repos/docker/docker-agent-action/pulls/88/reviews" --input -`,
      "does not carry exactly this run's finalize-body invocation",
    ],
    [
      'finalize invocation without the staged comments file',
      `node /tmp/review-assessment.js finalize-body /tmp/review_body.md ${TEST_NONCE}\njq -n --arg commit_id "${'a'.repeat(40)}"\ngh api "repos/docker/docker-agent-action/pulls/88/reviews" --input -`,
      "does not carry exactly this run's finalize-body invocation",
    ],
    [
      'duplicate finalize invocations',
      `node /tmp/review-assessment.js finalize-body /tmp/review_body.md ${TEST_NONCE} /tmp/review_comments.json\nnode /tmp/review-assessment.js finalize-body /tmp/review_body.md ${TEST_NONCE} /tmp/review_comments.json\njq -n --arg commit_id "${'a'.repeat(40)}"\ngh api "repos/docker/docker-agent-action/pulls/88/reviews" --input -`,
      "does not carry exactly this run's finalize-body invocation",
    ],
  ])('executes malformed posting reference %s without API access', (_name, content, diagnostic) => {
    const directory = mkdtempSync(resolve(tmpdir(), 'docker-agent-reference-'));
    const reference = resolve(directory, 'posting-format.md');
    if (content) writeFileSync(reference, content);
    const run = runSummary({
      exitCode: '124',
      verboseLog: 'no review',
      postingReference: reference,
    });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain(diagnostic);
      expect(run.records).toEqual([]);
    } finally {
      rmSync(run.directory, { recursive: true, force: true });
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('executes the concurrent-lock skip without requiring preflight inputs', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'docker-agent-skip-'));
    const run = runSummary({
      skipReason: 'concurrent',
      exitCode: '',
      headSha: '',
      postingReference: resolve(directory, 'missing'),
    });
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.summary).toContain('Review skipped');
      expect(run.outputs).toContain('review-status=skipped');
      expect(run.records).toEqual([]);
    } finally {
      rmSync(run.directory, { recursive: true, force: true });
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails the composite no-exit path as setup-failed instead of labeling it skipped', () => {
    // A setup step crashing before Run PR Review leaves EXIT_CODE empty with
    // no intentional skip recorded. That must surface as a failing step with
    // an honest non-skip status — never the neutral "skipped" (the mislabeled
    // setup-failure regression). Only the concurrent lock may report skipped.
    const directory = mkdtempSync(resolve(tmpdir(), 'docker-agent-setup-failed-'));
    const run = runSummary({
      exitCode: '',
      headSha: '',
      postingReference: resolve(directory, 'missing'),
    });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain('a setup step failed before the review');
      expect(run.outputs).toContain('review-status=setup-failed');
      expect(run.outputs).not.toContain('review-status=skipped');
      expect(run.summary).toContain('Review setup failed');
      expect(run.summary).not.toContain('Review skipped');
      expect(run.records).toEqual([]);
    } finally {
      rmSync(run.directory, { recursive: true, force: true });
      rmSync(directory, { recursive: true, force: true });
    }
  });

  const stagingTemplate = [
    'jq -n --arg commit_id "__PR_HEAD_SHA__"',
    'node /tmp/review-assessment.js finalize-body /tmp/review_body.md __REVIEW_RUN_NONCE__ /tmp/review_comments.json',
    'gh api "repos/__REPOSITORY__/pulls/__PR_NUMBER__/reviews" --input -',
  ].join('\n');

  it.each([
    { name: 'valid immutable SHA and trusted route', ok: true },
    { name: 'empty SHA', sha: '', ok: false },
    { name: 'non-hex SHA', sha: 'g'.repeat(40), ok: false },
    { name: 'short SHA', sha: 'a'.repeat(39), ok: false },
    { name: 'long SHA', sha: 'a'.repeat(41), ok: false },
    {
      name: 'unresolved template',
      template: stagingTemplate.replace('__PR_HEAD_SHA__', '$PR_HEAD_SHA'),
      ok: false,
    },
    {
      name: 'zero commit arguments',
      template: `jq -n --arg body "review"\ngh api "repos/__REPOSITORY__/pulls/__PR_NUMBER__/reviews" --input -`,
      ok: false,
    },
    {
      name: 'multiple commit arguments',
      template: `${stagingTemplate} --arg commit_id "x"`,
      ok: false,
    },
    {
      name: 'missing posting route',
      template: 'jq -n --arg commit_id "__PR_HEAD_SHA__"',
      ok: false,
    },
    {
      name: 'literal route placeholders',
      template:
        'jq -n --arg commit_id "__PR_HEAD_SHA__"\ngh api repos/{owner}/{repo}/pulls/{pr}/reviews --input -',
      ok: false,
    },
    {
      name: 'untrusted hardcoded route',
      template:
        'jq -n --arg commit_id "__PR_HEAD_SHA__"\ngh api "repos/evil/elsewhere/pulls/1/reviews" --input -',
      ok: false,
    },
    {
      name: 'duplicate posting routes',
      template: `${stagingTemplate}\ngh api "repos/__REPOSITORY__/pulls/__PR_NUMBER__/reviews" --input -`,
      ok: false,
    },
    {
      name: 'missing finalize-body invocation',
      template:
        'jq -n --arg commit_id "__PR_HEAD_SHA__"\ngh api "repos/__REPOSITORY__/pulls/__PR_NUMBER__/reviews" --input -',
      ok: false,
    },
    {
      name: 'finalize-body without the staged comments file',
      template:
        'jq -n --arg commit_id "__PR_HEAD_SHA__"\nnode /tmp/review-assessment.js finalize-body /tmp/review_body.md __REVIEW_RUN_NONCE__\ngh api "repos/__REPOSITORY__/pulls/__PR_NUMBER__/reviews" --input -',
      ok: false,
    },
    {
      name: 'duplicate finalize-body invocations',
      template: `node /tmp/review-assessment.js finalize-body /tmp/review_body.md __REVIEW_RUN_NONCE__ /tmp/review_comments.json\n${stagingTemplate}`,
      ok: false,
    },
    {
      name: 'hardcoded foreign nonce in the template',
      template: stagingTemplate.replace('__REVIEW_RUN_NONCE__', 'f'.repeat(32)),
      ok: false,
    },
    { name: 'repository without owner', repository: 'no-slash-repo', ok: false },
    { name: 'repository with sed metacharacters', repository: 'docker/repo|x', ok: false },
    { name: 'repository with replacement metacharacter', repository: 'docker/re&po', ok: false },
    { name: 'non-numeric PR number', prNumber: '88x', ok: false },
    { name: 'empty PR number', prNumber: '', ok: false },
    { name: 'empty run nonce', nonce: '', ok: false },
    { name: 'malformed run nonce', nonce: 'abc-123', ok: false },
    { name: 'uppercase run nonce', nonce: TEST_NONCE.toUpperCase(), ok: false },
  ])('executes Copy reference files staging preflight for $name', ({
    sha,
    template,
    repository,
    prNumber,
    nonce,
    ok,
  }) => {
    const headSha = sha ?? 'a'.repeat(40);
    const { result, rendered } = runCopyReference(
      headSha,
      template ?? stagingTemplate,
      repository,
      prNumber,
      nonce,
    );
    expect(result.status, result.stderr).toBe(ok ? 0 : 1);
    if (ok) {
      expect(rendered).toContain(`--arg commit_id "${headSha}"`);
      expect(rendered).toContain(
        'gh api "repos/docker/docker-agent-action/pulls/88/reviews" --input -',
      );
      expect(rendered).toContain(
        `finalize-body /tmp/review_body.md ${TEST_NONCE} /tmp/review_comments.json`,
      );
      expect(rendered).not.toMatch(
        /__PR_HEAD_SHA__|__REPOSITORY__|__PR_NUMBER__|__REVIEW_RUN_NONCE__|\{owner\}/,
      );
    }
  });

  it('renders the repository posting template with the trusted SHA, route, and nonce staged in', () => {
    const sha = 'a'.repeat(40);
    const { result, rendered } = runCopyReference(
      sha,
      readFileSync(resolve(root, 'review-pr/agents/refs/posting-format.md'), 'utf8'),
    );
    expect(result.status, result.stderr).toBe(0);
    expect(rendered).toContain(`--arg commit_id "${sha}"`);
    expect(rendered).toContain(
      '&& gh api "repos/docker/docker-agent-action/pulls/88/reviews" --input - < /tmp/review_payload.json',
    );
    // No trusted routing data is left for the model to substitute.
    expect(rendered).not.toMatch(
      /__PR_HEAD_SHA__|__REPOSITORY__|__PR_NUMBER__|__REVIEW_RUN_NONCE__|\{owner\}|\{repo\}|\{pr\}/,
    );
    // The review body is a heredoc-written file, validated and marker-stamped
    // by the trusted CLI — no REVIEW_BODY shell variable exists to bleed a
    // default assessment through, and the marker append is mechanical.
    expect(rendered).not.toMatch(/^REVIEW_BODY=/m);
    expect(rendered).not.toMatch(/\$REVIEW_BODY|\$\{REVIEW_BODY/);
    expect(rendered).toContain('test -s /tmp/review_body.md \\');
    expect(rendered).toContain(
      `&& node /tmp/review-assessment.js finalize-body /tmp/review_body.md ${TEST_NONCE} /tmp/review_comments.json \\`,
    );
    expect(rendered).toContain('--rawfile body /tmp/review_body.md');
    // The payload is staged to a trusted temp file and validated before gh
    // ever runs — a failed jq must not start the API call (the old `jq | gh`
    // pipe launched gh regardless of jq's fate).
    expect(rendered).toContain('> /tmp/review_payload.json \\');
    expect(rendered).toContain(
      `&& jq -e 'type == "object"' /tmp/review_payload.json > /dev/null \\`,
    );
    expect(rendered).not.toMatch(/\|\s*gh api/);
  });

  function extractPostingCommand(rendered: string): string {
    const lines = rendered.split('\n');
    const start = lines.findIndex((line) => line.startsWith('test -s /tmp/review_body.md'));
    const end = lines.findIndex(
      (line, index) => index > start && line.trimStart().startsWith('&& gh api '),
    );
    if (start === -1 || end === -1)
      throw new Error('chained posting command not found in rendered template');
    return lines.slice(start, end + 1).join('\n');
  }

  it('executes the rendered posting command: invalid bodies refuse, computed outcome posts with the marker', () => {
    const sha = 'a'.repeat(40);
    const { result, rendered } = runCopyReference(
      sha,
      readFileSync(resolve(root, 'review-pr/agents/refs/posting-format.md'), 'utf8'),
    );
    expect(result.status, result.stderr).toBe(0);
    const command = extractPostingCommand(rendered);
    const directory = mkdtempSync(resolve(tmpdir(), 'docker-agent-posting-guard-'));
    try {
      const recordsPath = resolve(directory, 'gh-records.jsonl');
      const comments = resolve(directory, 'review_comments.json');
      const body = resolve(directory, 'review_body.md');
      const payload = resolve(directory, 'review_payload.json');
      writeFileSync(resolve(directory, 'gh'), ghMock());
      chmodSync(resolve(directory, 'gh'), 0o755);
      const spawnPosting = (
        bodyContent: string | undefined,
        options: { comments?: string | null; env?: Record<string, string> } = {},
      ) => {
        writeFileSync(recordsPath, '');
        rmSync(body, { force: true });
        rmSync(comments, { force: true });
        rmSync(payload, { force: true });
        const commentsContent = options.comments === undefined ? '[]\n' : options.comments;
        if (commentsContent !== null) writeFileSync(comments, commentsContent);
        if (bodyContent !== undefined) writeFileSync(body, bodyContent);
        writeFileSync(
          resolve(directory, 'post.sh'),
          command
            .replaceAll('/tmp/review_comments.json', comments)
            .replaceAll('/tmp/review_body.md', body)
            .replaceAll('/tmp/review_payload.json', payload)
            .replaceAll('/tmp/review-assessment.js', reviewAssessmentCli),
        );
        return spawnSync('/bin/bash', ['--noprofile', '--norc', resolve(directory, 'post.sh')], {
          cwd: directory,
          env: testEnvironment({
            PATH: `${directory}${delimiter}${safePath}`,
            GH_RECORDS: recordsPath,
            ...options.env,
          }),
          encoding: 'utf8',
        });
      };
      const ghRecords = () =>
        readFileSync(recordsPath, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as GhRecord);

      // Missing and empty body files: `test -s` refuses before any gh call.
      for (const content of [undefined, '']) {
        const refused = spawnPosting(content);
        expect(refused.status, String(content)).not.toBe(0);
        expect(ghRecords()).toEqual([]);
      }

      // Forbidden approval wording, missing status line, and 🟢 NO FINDINGS
      // over findings sections: the trusted validator refuses posting.
      for (const [content, reason] of [
        ['### Assessment: 🟢 NO FINDINGS\n\nLGTM!\n', 'forbidden approval wording'],
        ['🟢 **No issues found** — all good.\n', 'forbidden approval wording'],
        ['looks good to me\n', 'no recognized status line'],
        ['### ⚠️ Review incomplete\n### Assessment: 🟢 NO FINDINGS\n', 'mixes an assessment line'],
        [
          '### Assessment: 🟢 NO FINDINGS\n\n#### Low-severity findings (not verified, not posted inline)\n- [low] a.go:1 — x\n',
          'cannot be combined with findings sections',
        ],
      ] as const) {
        const refused = spawnPosting(content);
        expect(refused.status, content).not.toBe(0);
        expect(refused.stderr, content).toContain(reason);
        expect(ghRecords()).toEqual([]);
      }

      // Missing, malformed, and non-array staged comments files: the trusted
      // validator refuses before jq or gh ever run.
      for (const [staged, reason] of [
        [null, 'missing or unreadable'],
        ['not json', 'not valid JSON'],
        ['{"body": "x"}', 'must be a JSON array'],
      ] as const) {
        const refused = spawnPosting('### Assessment: 🟡 NEEDS ATTENTION\n', { comments: staged });
        expect(refused.status, String(staged)).not.toBe(0);
        expect(refused.stderr, String(staged)).toContain(reason);
        expect(ghRecords()).toEqual([]);
      }

      // 🟢 NO FINDINGS over staged inline comments contradicts the label —
      // refused at runtime, zero gh calls.
      const contradicted = spawnPosting('### Assessment: 🟢 NO FINDINGS\n', {
        comments: '[{"path": "a.go", "line": 1, "body": "**[low] issue**"}]\n',
      });
      expect(contradicted.status).not.toBe(0);
      expect(contradicted.stderr).toContain('🟢 NO FINDINGS cannot be posted with 1 staged');
      expect(ghRecords()).toEqual([]);

      // Forced jq failure: payload staging fails, so gh is NEVER invoked —
      // the old `jq | gh` pipe started gh regardless of jq's fate and relied
      // on pipefail/API rejection to surface the error.
      const brokenTools = resolve(directory, 'broken-tools');
      mkdirSync(brokenTools, { recursive: true });
      writeFileSync(resolve(brokenTools, 'jq'), '#!/bin/sh\nexit 7\n');
      chmodSync(resolve(brokenTools, 'jq'), 0o755);
      const jqFailed = spawnPosting('### Assessment: 🟡 NEEDS ATTENTION\n', {
        env: { PATH: `${brokenTools}${delimiter}${directory}${delimiter}${safePath}` },
      });
      expect(jqFailed.status).not.toBe(0);
      expect(ghRecords()).toEqual([]);

      // gh itself failing propagates a nonzero chain exit.
      const ghFailed = spawnPosting('### Assessment: 🟡 NEEDS ATTENTION\n', {
        env: { GH_POST_FAILS: '1' },
      });
      expect(ghFailed.status).not.toBe(0);
      expect(ghRecords()).toHaveLength(1);

      // With the computed outcome written, the chain validates, appends the
      // run marker mechanically, and posts the exact hardcoded payload.
      const posted = spawnPosting('### Assessment: 🟡 NEEDS ATTENTION\n');
      expect(posted.status, posted.stderr).toBe(0);
      const records = ghRecords();
      expect(records).toHaveLength(1);
      expect(records[0].args).toBe(
        'api repos/docker/docker-agent-action/pulls/88/reviews --input -',
      );
      expect(JSON.parse(records[0].input)).toEqual({
        body: `### Assessment: 🟡 NEEDS ATTENTION\n\n${TEST_MARKER}\n`,
        event: 'COMMENT',
        commit_id: sha,
        comments: [],
      });

      // Staged inline comments ride along for non-NO-FINDINGS outcomes.
      const withComments = spawnPosting('### Assessment: 🟡 NEEDS ATTENTION\n', {
        comments: '[{"path": "a.go", "line": 1, "body": "**[low] issue**"}]\n',
      });
      expect(withComments.status, withComments.stderr).toBe(0);
      const commentRecords = ghRecords();
      expect(commentRecords).toHaveLength(1);
      expect(JSON.parse(commentRecords[0].input).comments).toEqual([
        { path: 'a.go', line: 1, body: '**[low] issue**' },
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function runBaseline(options: { reviews?: string; fetchFails?: boolean }): {
    result: ReturnType<typeof spawnSync>;
    outputs: string;
  } {
    const directory = mkdtempSync(resolve(tmpdir(), 'docker-agent-baseline-'));
    try {
      const output = resolve(directory, 'output');
      writeFileSync(output, '');
      writeFileSync(resolve(directory, 'gh-records.jsonl'), '');
      writeFileSync(resolve(directory, 'reviews.json'), options.reviews ?? '[]');
      writeFileSync(resolve(directory, 'baseline.sh'), actionStepRun('Capture review baseline'));
      writeFileSync(resolve(directory, 'gh'), ghMock());
      chmodSync(resolve(directory, 'gh'), 0o755);
      const result = spawnSync(
        '/bin/bash',
        ['--noprofile', '--norc', '-e', '-o', 'pipefail', resolve(directory, 'baseline.sh')],
        {
          cwd: directory,
          env: testEnvironment({
            PATH: `${directory}${delimiter}${safePath}`,
            GH_RECORDS: resolve(directory, 'gh-records.jsonl'),
            GH_REVIEWS_FILE: resolve(directory, 'reviews.json'),
            GH_REVIEWS_FETCH_FAILS: options.fetchFails ? '1' : '',
            GITHUB_OUTPUT: output,
            REPOSITORY: 'docker/docker-agent-action',
            PR_NUMBER: '88',
          }),
          encoding: 'utf8',
        },
      );
      return { result, outputs: readFileSync(output, 'utf8') };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it.each([
    { name: 'existing reviews', reviews: '[{"id": 7}, {"id": 12}]', max: '12' },
    { name: 'no reviews', reviews: '[]', max: '0' },
    { name: 'null review IDs', reviews: '[{"id": null}]', max: '0' },
  ])('executes the review baseline capture for $name', ({ reviews, max }) => {
    const { result, outputs } = runBaseline({ reviews });
    expect(result.status, result.stderr).toBe(0);
    expect(outputs).toContain(`max-review-id=${max}\n`);
  });

  it.each([
    { name: 'lookup failure', options: { fetchFails: true } },
    { name: 'non-JSON payload', options: { reviews: 'not json' } },
  ])('refuses to start an unverifiable review on baseline $name', ({ options }) => {
    const { result, outputs } = runBaseline(options);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('refusing to start an unverifiable review');
    expect(outputs).not.toContain('max-review-id=');
  });

  function runNonceGeneration(cliSource?: string): {
    result: ReturnType<typeof spawnSync>;
    outputs: string;
  } {
    const directory = mkdtempSync(resolve(tmpdir(), 'docker-agent-nonce-'));
    try {
      const actionPath = resolve(directory, 'action');
      mkdirSync(actionPath, { recursive: true });
      mkdirSync(resolve(directory, 'dist'), { recursive: true });
      if (cliSource === undefined) {
        cpSync(reviewAssessmentCli, resolve(directory, 'dist/review-assessment.js'));
      } else {
        writeFileSync(resolve(directory, 'dist/review-assessment.js'), cliSource);
      }
      const output = resolve(directory, 'output');
      writeFileSync(output, '');
      writeFileSync(
        resolve(directory, 'nonce.sh'),
        actionStepRun('Generate run attribution nonce'),
      );
      const result = spawnSync(
        '/bin/bash',
        ['--noprofile', '--norc', '-e', '-o', 'pipefail', resolve(directory, 'nonce.sh')],
        {
          env: testEnvironment({ ACTION_PATH: actionPath, GITHUB_OUTPUT: output }),
          encoding: 'utf8',
        },
      );
      return { result, outputs: readFileSync(output, 'utf8') };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it('executes the nonce generation step masking the nonce before any other output', () => {
    const { result, outputs } = runNonceGeneration();
    expect(result.status, result.stderr).toBe(0);
    const nonce = outputs.match(/^nonce=([0-9a-f]{32})$/m)?.[1];
    expect(nonce).toBeDefined();
    if (!nonce) throw new Error('nonce output missing');
    // The FIRST line the step prints is the ::add-mask:: workflow command, so
    // the runner masks the nonce before any later step (or this one) can echo
    // it into the public run log.
    const stdout = String(result.stdout);
    expect(stdout.split('\n')[0]).toBe(`::add-mask::${nonce}`);
    // Outside the masking command the nonce never appears in normal output.
    expect(stdout.replace(`::add-mask::${nonce}`, '')).not.toContain(nonce);
    expect(String(result.stderr)).not.toContain(nonce);
    // Static ordering: the run body masks immediately after generation, before
    // the validation guard and before the value reaches GITHUB_OUTPUT.
    const run = actionStepRun('Generate run attribution nonce');
    const mask = run.indexOf('echo "::add-mask::$RUN_NONCE"');
    expect(mask).toBeGreaterThan(run.indexOf('new-run-nonce'));
    expect(mask).toBeLessThan(run.indexOf('[[ "$RUN_NONCE" =~'));
    expect(mask).toBeLessThan(run.indexOf('GITHUB_OUTPUT'));
  });

  it('still masks and refuses staging when the generated nonce is malformed', () => {
    const { result, outputs } = runNonceGeneration('process.stdout.write("not-a-nonce\\n");\n');
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('nonce is malformed');
    expect(outputs).not.toContain('nonce=');
    expect(String(result.stdout).split('\n')[0]).toBe('::add-mask::not-a-nonce');
  });

  function runReaction(reviewStatus: string): {
    result: ReturnType<typeof spawnSync>;
    records: GhRecord[];
  } {
    const directory = mkdtempSync(resolve(tmpdir(), 'docker-agent-reaction-'));
    try {
      const recordsPath = resolve(directory, 'gh-records.jsonl');
      writeFileSync(recordsPath, '');
      writeFileSync(resolve(directory, 'reaction.sh'), actionStepRun('Add completion reaction'));
      writeFileSync(resolve(directory, 'gh'), ghMock());
      chmodSync(resolve(directory, 'gh'), 0o755);
      const result = spawnSync(
        '/bin/bash',
        ['--noprofile', '--norc', '-e', '-o', 'pipefail', resolve(directory, 'reaction.sh')],
        {
          cwd: directory,
          env: testEnvironment({
            PATH: `${directory}${delimiter}${safePath}`,
            GH_RECORDS: recordsPath,
            REVIEW_STATUS: reviewStatus,
            REPO: 'docker/docker-agent-action',
            COMMENT_ID: '55',
          }),
          encoding: 'utf8',
        },
      );
      const records = readFileSync(recordsPath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as GhRecord);
      return { result, records };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it.each([
    ['completed', '+1'],
    ['completed-with-warnings', '+1'],
    ['incomplete', 'confused'],
    ['inconclusive', 'confused'],
    ['failed', 'confused'],
    ['timed-out', 'confused'],
    ['skipped', 'confused'],
    ['setup-failed', 'confused'],
    ['unverified', 'confused'],
    ['', 'confused'],
  ])('executes the completion reaction for review-status %j as %s', (status, reaction) => {
    // An exit-0 run that posted nothing carries review-status=incomplete and
    // must react confused — never 👍 (the false-success reaction regression).
    const run = runReaction(status);
    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.records).toHaveLength(1);
    expect(run.records[0].args).toBe(
      `api repos/docker/docker-agent-action/issues/comments/55/reactions -X POST -f content=${reaction}`,
    );
  });

  function runEnforceOutcome(
    reviewStatus: string,
    stepOutcome: string,
  ): ReturnType<typeof spawnSync> {
    const directory = mkdtempSync(resolve(tmpdir(), 'docker-agent-enforce-'));
    try {
      const body = step('review', 'Enforce review outcome').run;
      if (!body) throw new Error('Expected an Enforce review outcome run body');
      writeFileSync(resolve(directory, 'enforce.sh'), body);
      return spawnSync(
        '/bin/bash',
        ['--noprofile', '--norc', '-e', '-o', 'pipefail', resolve(directory, 'enforce.sh')],
        {
          env: testEnvironment({ REVIEW_STATUS: reviewStatus, RUN_REVIEW_OUTCOME: stepOutcome }),
          encoding: 'utf8',
        },
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it.each([
    // Only a verified completion or an intentional skip leaves the job green.
    ['completed', 'success', 0],
    ['completed-with-warnings', 'success', 0],
    ['skipped', 'success', 0],
    // The review step never ran: a pre-review guard (draft, auth, rate
    // anomaly, non-/review comment) filtered the event — an expected skip.
    ['', 'skipped', 0],
    // A missing status from a step that ran means the composite crashed
    // before the summary — never a green outcome.
    ['', 'success', 1],
    ['', 'failure', 1],
    // A skipped status from a FAILED composite is a contradiction — the
    // failure wins (a mislabeled setup failure must never look intentional).
    ['skipped', 'failure', 1],
    // continue-on-error masks these from job.status; the gate restores them.
    ['incomplete', 'success', 1],
    ['inconclusive', 'success', 1],
    ['failed', 'success', 1],
    ['timed-out', 'success', 1],
    ['setup-failed', 'failure', 1],
    ['unverified', 'failure', 1],
  ] as [
    string,
    string,
    number,
  ][])('executes the review outcome enforcement for status %j (step outcome %j) with exit %i', (status, outcome, exit) => {
    const result = runEnforceOutcome(status, outcome);
    expect(result.status, result.stdout + result.stderr).toBe(exit);
    if (exit !== 0) {
      expect(result.stdout + result.stderr).toContain('failing the review job');
    }
  });

  it('runs the outcome enforcement gate last, on every path, off the review-status output', () => {
    const enforce = step('review', 'Enforce review outcome');
    expect(enforce.if).toBe('always()');
    expect(enforce.env?.REVIEW_STATUS).toBe('${' + '{ steps.run-review.outputs.review-status }}');
    expect(enforce.env?.RUN_REVIEW_OUTCOME).toBe('${' + '{ steps.run-review.outcome }}');
    // Last step of the job: the cleanup/check-update steps run before the
    // gate can fail the job.
    const steps = job('review').steps ?? [];
    expect(steps[steps.length - 1]?.name).toBe('Enforce review outcome');
    expect(stepIndex('review', 'Enforce review outcome')).toBeGreaterThan(
      stepIndex('review', 'Update check run'),
    );
    // The reusable workflow re-exposes the API-verified status to callers.
    expect(job('review').outputs?.['review-status']).toBe(
      '${' + '{ steps.run-review.outputs.review-status }}',
    );
    const workflowCall = workflow.on?.workflow_call as {
      outputs?: Record<string, { value?: string }>;
    };
    expect(workflowCall.outputs?.['review-status']?.value).toBe(
      '${' + '{ jobs.review.outputs.review-status }}',
    );
  });

  it('executes the check-run conclusion script keyed on the API-verified review-status', async () => {
    const check = step('review', 'Update check run');
    expect(check.if).toBe("always() && steps.create-check.outputs.check-id != ''");
    expect(check.env?.REVIEW_STATUS).toBe('${' + '{ steps.run-review.outputs.review-status }}');
    expect(check.env?.RUN_REVIEW_OUTCOME).toBe('${' + '{ steps.run-review.outcome }}');
    const script = check.with?.script;
    if (!script) throw new Error('Expected an Update check run script');
    const AsyncFunction = (async () => {}).constructor as new (
      ...args: string[]
    ) => (github: unknown, context: unknown, core: unknown) => Promise<void>;
    const runScript = new AsyncFunction('github', 'context', 'core', script);
    const envKeys = ['CHECK_ID', 'JOB_STATUS', 'REVIEW_STATUS', 'RUN_REVIEW_OUTCOME'] as const;

    const conclusionFor = async (env: Record<string, string>): Promise<unknown> => {
      const updates: Array<Record<string, unknown>> = [];
      const github = {
        rest: {
          checks: {
            update: async (args: Record<string, unknown>) => {
              updates.push(args);
            },
          },
        },
      };
      const saved = envKeys.map((key) => [key, process.env[key]] as const);
      Object.assign(process.env, {
        CHECK_ID: '7',
        JOB_STATUS: 'success',
        REVIEW_STATUS: '',
        RUN_REVIEW_OUTCOME: '',
        ...env,
      });
      try {
        await runScript(
          github,
          { repo: { owner: 'docker', repo: 'docker-agent-action' } },
          { warning: () => {} },
        );
      } finally {
        for (const [key, value] of saved) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
      expect(updates).toHaveLength(1);
      expect(updates[0].check_run_id).toBe(7);
      expect(updates[0].status).toBe('completed');
      return updates[0].conclusion;
    };

    expect(await conclusionFor({ JOB_STATUS: 'cancelled' })).toBe('cancelled');
    expect(await conclusionFor({ REVIEW_STATUS: 'completed' })).toBe('success');
    expect(await conclusionFor({ REVIEW_STATUS: 'completed-with-warnings' })).toBe('success');
    // Intentional skips stay neutral — including the guard-skipped step — but
    // ONLY when the composite itself did not fail: a failed step claiming
    // skipped must never yield a neutral check.
    expect(await conclusionFor({ REVIEW_STATUS: 'skipped' })).toBe('neutral');
    expect(await conclusionFor({ REVIEW_STATUS: 'skipped', RUN_REVIEW_OUTCOME: 'success' })).toBe(
      'neutral',
    );
    expect(await conclusionFor({ REVIEW_STATUS: 'skipped', RUN_REVIEW_OUTCOME: 'failure' })).toBe(
      'failure',
    );
    expect(await conclusionFor({ RUN_REVIEW_OUTCOME: 'skipped' })).toBe('neutral');
    // Everything else — non-success statuses and a missing status from a
    // crashed composite — is red, even though continue-on-error keeps
    // job.status green (the misleading-green regression).
    for (const status of [
      'incomplete',
      'inconclusive',
      'failed',
      'timed-out',
      'setup-failed',
      'unverified',
    ]) {
      expect(await conclusionFor({ REVIEW_STATUS: status }), status).toBe('failure');
    }
    expect(await conclusionFor({ RUN_REVIEW_OUTCOME: 'success' })).toBe('failure');
  });

  it('captures the API review baseline before the agent runs and keys the reaction on review-status', () => {
    const names = reviewActionSteps().map((candidate) => candidate.name);
    const baseline = names.indexOf('Capture review baseline');
    expect(baseline).toBeGreaterThan(names.indexOf('Fetch existing review comments'));
    expect(baseline).toBeLessThan(names.indexOf('Run PR Review'));
    expect(reviewActionStep('Capture review baseline').if).toBe(
      "steps.lock-check.outputs.skip != 'true'",
    );
    // The attribution nonce is generated in a trusted step before the posting
    // template is staged, and both the staging step and the summary consume
    // exactly that output — never a user-controllable value.
    const nonce = names.indexOf('Generate run attribution nonce');
    expect(nonce).toBeGreaterThan(-1);
    expect(nonce).toBeLessThan(names.indexOf('Copy reference files'));
    expect(reviewActionStep('Generate run attribution nonce').if).toBe(
      "steps.lock-check.outputs.skip != 'true'",
    );
    expect(reviewActionStep('Copy reference files').env?.RUN_NONCE).toBe(
      '${' + '{ steps.run-nonce.outputs.nonce }}',
    );
    const summary = reviewActionStep('Post clean summary');
    expect(summary.env?.BASELINE_MAX_REVIEW_ID).toBe(
      '${' + '{ steps.review-baseline.outputs.max-review-id }}',
    );
    expect(summary.env?.RUN_NONCE).toBe('${' + '{ steps.run-nonce.outputs.nonce }}');
    // Post-run attribution runs through the bundled review-assessment CLI
    // (exact marker + selected SHA + baseline), not inline jq identity
    // filters — the same logic the unit tests pin.
    expect(summary.run).toContain('dist/review-assessment.js" classify-run');
    expect(summary.run).toContain('"$PR_HEAD_SHA" "$BASELINE_MAX_REVIEW_ID" "$RUN_NONCE"');
    expect(summary.run).not.toContain('AGENT_REVIEWS_ON_SHA');
    const reaction = reviewActionStep('Add completion reaction');
    expect(reaction.env?.REVIEW_STATUS).toBe(
      '${' + '{ steps.post-summary.outputs.review-status }}',
    );
    // The reaction must key on the API-verified status, never the exit code.
    expect(reaction.env?.EXIT_CODE).toBeUndefined();
    expect(reaction.run).not.toContain('EXIT_CODE');
  });

  it('binds immutable review inputs before the snapshot and derives posting from its output', () => {
    const action = readFileSync(resolve(root, 'review-pr/action.yml'), 'utf8');
    const snapshot = action.slice(
      action.indexOf('- name: Prepare immutable PR snapshot'),
      action.indexOf('- name: Compute incremental review range'),
    );
    const summary = action.slice(action.indexOf('- name: Post clean summary'));
    expect(snapshot).toContain(`PR_HEAD_SHA: ${'${'}{ inputs.pr-head-sha }}`);
    expect(snapshot).toContain(`PR_BASE_SHA: ${'${'}{ inputs.pr-base-sha }}`);
    expect(snapshot).not.toContain('steps.pr-info.outputs.head-sha');
    expect(snapshot).not.toContain('POSTING_REFERENCE');
    expect(summary).toContain(`PR_HEAD_SHA: ${'${'}{ steps.pr-info.outputs.head-sha }}`);
  });

  it('keeps the review action free of synthesized approvals and low-finding suppression', () => {
    const action = readFileSync(resolve(root, 'review-pr/action.yml'), 'utf8');
    // The prompt must not tell the agent to report only verified findings —
    // that wording suppressed unverified low findings (docker/gordon #1814).
    expect(action).not.toContain(
      'Only report CONFIRMED and LIKELY findings. Always post as COMMENT',
    );
    expect(action).toContain(
      'Surviving low-severity findings skip verification but MUST still be surfaced',
    );
    // The prompt pins the COMMENT event and the neutral zero-findings label;
    // no fallback may pass an approving event to the Reviews API.
    expect(action).toContain('Always post as COMMENT (never APPROVE or REQUEST_CHANGES)');
    expect(action).toContain('--arg event "COMMENT"');
    expect(action).not.toMatch(/--arg event "(?:APPROVE|REQUEST_CHANGES)"/);
    expect(action).not.toContain('🟢 APPROVE');
    // No code path may synthesize an LGTM/no-issues review body.
    expect(action).not.toContain('LGTM!');
    expect(action).not.toContain('🟢 **No issues found**');
  });

  it('keeps resolver output names body-free and shell expressions out of run bodies', () => {
    const outputs = resolverOutputNames();
    expect(outputs).toContain('comment-in-reply-to-id');
    expect(outputs).not.toContain('comment-body');
    expect(JSON.stringify(workflow)).not.toContain('steps.read.outputs.comment-body');
    expect(JSON.stringify(workflow)).not.toContain('needs.resolve-context.outputs.comment-body');

    for (const jobName of ['resolve-context', 'review', 'reply-to-feedback', 'reply-to-mention']) {
      for (const candidate of job(jobName).steps ?? []) {
        if (!candidate.run) continue;
        expect(
          candidate.run,
          `${jobName}/${candidate.name ?? 'unnamed'} must use env for expressions`,
        ).not.toContain('${{');
      }
    }
  });

  it('does not run privileged E2E jobs from workflow_run', () => {
    expect(e2e.on?.workflow_run).toBeUndefined();
    expect(JSON.stringify(e2e)).not.toContain('test-e2e-trigger.yml');
  });

  it('gates every workflow-run route on the canonical resolver result', () => {
    for (const route of ['review', 'reply-to-feedback', 'reply-to-mention']) {
      expect(job(route).if).toContain(canonicalGate);
    }
    expect(job('review').if).toContain("trigger-route == 'review'");
    const resolvePr = step('review', 'Resolve PR number');
    expect(resolvePr.run).toContain(
      `PR_SNAPSHOT=$(gh api "repos/\${GITHUB_REPOSITORY}/pulls/$PR_NUMBER")`,
    );
    expect(resolvePr.run).toContain(
      'PR_HEAD_SHA=$(jq -r \'.head.sha // empty\' <<<"$PR_SNAPSHOT")',
    );
    expect(resolvePr.run).toContain(
      'PR_BASE_SHA=$(jq -r \'.base.sha // empty\' <<<"$PR_SNAPSHOT")',
    );
    expect(resolvePr.run).not.toContain('PR_BASE_SHA=${PR_BASE_SHA:-$(gh api');
    expect(job('reply-to-feedback').if).toContain("trigger-route == 'feedback'");
    expect(job('reply-to-mention').if).toContain("trigger-route == 'mention'");
    expect(job('reply-to-feedback').if).toContain(artifactGate);
    expect(job('reply-to-mention').if).toContain(artifactGate);
  });

  it('stages, guards, and transfers canonical context through private runner-temp directories', () => {
    const resolver = step('resolve-context', 'Resolve trusted trigger context');
    const locator = step('resolve-context', 'Create trigger context directory');
    const locatorGuard = step('resolve-context', 'Guard trigger context directory');
    const uploadGuard = step('resolve-context', 'Guard canonical trigger context before upload');
    const upload = step('resolve-context', 'Upload canonical trigger context');
    expect(locator.env?.RUNNER_TEMP).toBe('${' + '{ runner.temp }}');
    expect(locator.run).toContain('RUN_ATTEMPT');
    expect(stepIndex('resolve-context', locator.name ?? '')).toBeLessThan(
      stepIndex('resolve-context', 'Download trigger context'),
    );
    expect(step('resolve-context', 'Download trigger context').with?.path).toBe(
      '${' + '{ steps.trigger-context-directory.outputs.path }}',
    );
    expect(resolver.env?.TRIGGER_ARTIFACT_DIRECTORY).toBe(
      '${' + '{ steps.trigger-context-directory.outputs.path }}',
    );
    expect(locatorGuard.run).toContain('realpath');
    expect(locatorGuard.run).toContain("stat -c '%a'");
    expect(stepIndex('resolve-context', locatorGuard.name ?? '')).toBeLessThan(
      stepIndex('resolve-context', resolver.name ?? ''),
    );
    expect(uploadGuard.run).toContain('canonical-trigger-context.json');
    expect(uploadGuard.run).toContain('[ -f');
    expect(uploadGuard.run).toContain('[ ! -L');
    expect(uploadGuard.run).toContain('realpath');
    expect(uploadGuard.run).toContain("stat -c '%a'");
    expect(stepIndex('resolve-context', resolver.name ?? '')).toBeLessThan(
      stepIndex('resolve-context', uploadGuard.name ?? ''),
    );
    expect(stepIndex('resolve-context', uploadGuard.name ?? '')).toBeLessThan(
      stepIndex('resolve-context', upload.name ?? ''),
    );
    expect(upload.with?.path).toBe('${' + '{ steps.read.outputs.canonical-context-path }}');
    expect(JSON.stringify(workflow)).not.toContain('/tmp/context');

    for (const [route, directory] of [
      ['reply-to-feedback', 'feedback-context-directory'],
      ['reply-to-mention', 'mention-context-directory'],
    ] as const) {
      const createDirectory = step(
        route,
        route === 'reply-to-feedback'
          ? 'Create feedback context directory'
          : 'Create mention context directory',
      );
      const download = step(route, 'Download canonical trigger context');
      const guard = step(
        route,
        route === 'reply-to-feedback'
          ? 'Guard downloaded feedback context'
          : 'Guard downloaded mention context',
      );
      expect(createDirectory.if).toBeUndefined();
      expect(createDirectory.env?.RUNNER_TEMP).toBe('${' + '{ runner.temp }}');
      expect(createDirectory.run).toContain('RUN_ATTEMPT');
      expect(createDirectory.run).toContain('mktemp');
      expect(createDirectory.run).toContain('chmod 600');
      expect(download.with?.path).toBe(`\${{ steps.${directory}.outputs.canonical }}`);
      expect(guard.run).toContain('realpath');
      expect(guard.run).toContain('[ ! -L');
      expect(guard.run).toContain("stat -c '%a'");
      expect(stepIndex(route, createDirectory.name ?? '')).toBeLessThan(
        stepIndex(route, download.name ?? ''),
      );
      expect(stepIndex(route, download.name ?? '')).toBeLessThan(
        stepIndex(route, guard.name ?? ''),
      );
    }

    expect(step('reply-to-feedback', 'Parse comment context').env?.CANONICAL_CONTEXT).toBe(
      '${' +
        '{ steps.feedback-context-directory.outputs.canonical }}/canonical-trigger-context.json',
    );
    expect(
      step('reply-to-mention', 'Synthesize mention-reply event context').env?.CANONICAL_CONTEXT,
    ).toBe(
      '${' +
        '{ steps.mention-context-directory.outputs.canonical }}/canonical-trigger-context.json',
    );
  });

  it('selects the canonical artifact by ID, validates it, and only then uses it', () => {
    for (const route of ['reply-to-feedback', 'reply-to-mention']) {
      const validate = step(route, 'Validate canonical context artifact ID');
      const download = step(route, 'Download canonical trigger context');
      expect(validate.if).toContain(triggerRoute);
      expect(validate.if).toContain(canonicalGate);
      expect(validate.if).toContain(artifactGate);
      expect(download.if).toContain(triggerRoute);
      expect(download.if).toContain("steps.canonical-artifact.outputs.valid == 'true'");
      expect(download.with?.['artifact-ids']).toBe(artifactIdExpression);
      expect(download.with?.name).toBeUndefined();
      expect(download.with?.['digest-mismatch']).toBe('error');
      expect(stepIndex(route, validate.name ?? '')).toBeLessThan(
        stepIndex(route, download.name ?? ''),
      );
    }
    const feedbackParse = step('reply-to-feedback', 'Parse comment context');
    const mentionSynthesis = step('reply-to-mention', 'Synthesize mention-reply event context');
    expect(feedbackParse.run).toContain('CANONICAL_CONTEXT');
    expect(mentionSynthesis.if).toContain(triggerRoute);
    expect(mentionSynthesis.run).toContain('CANONICAL_CONTEXT');
    expect(step('reply-to-mention', 'Guard downloaded mention context').run).toContain(
      'canonical-trigger-context.json',
    );
  });

  it('uses resolved immutable SHAs and never checks out mutable pull refs', () => {
    const reviewCheckout = step('review', 'Checkout PR head');
    const feedbackCheckout = step('reply-to-feedback', 'Checkout PR head');
    expect(reviewCheckout.with?.ref).toBe(reviewShaExpression);
    expect(feedbackCheckout.with?.ref).toBe(feedbackShaExpression);
    expect(JSON.stringify(workflow)).not.toContain('refs/pull/');
  });

  it('makes feedback context fetching work with the direct-route token before conditional credentials', () => {
    const feedback = job('reply-to-feedback');
    const parse = step('reply-to-feedback', 'Parse comment context');
    const check = step('reply-to-feedback', 'Check if reply is to agent comment');
    const credentials = step('reply-to-feedback', 'Setup credentials');
    expect(parse.env?.GH_TOKEN).toBe(githubTokenExpression);
    expect(stepIndex('reply-to-feedback', parse.name ?? '')).toBeLessThan(
      stepIndex('reply-to-feedback', check.name ?? ''),
    );
    expect(stepIndex('reply-to-feedback', check.name ?? '')).toBeLessThan(
      stepIndex('reply-to-feedback', credentials.name ?? ''),
    );
    expect(credentials.if).toBe("steps.check.outputs.is_agent == 'true'");
    expect(feedback.permissions?.['pull-requests']).toBe('write');
  });

  it('uses canonical event data for workflow-run mentions and direct event data otherwise', () => {
    const mention = job('reply-to-mention');
    const synthesize = step('reply-to-mention', 'Synthesize mention-reply event context');
    const resolveEvent = step('reply-to-mention', 'Resolve event context for mention-reply action');
    const credentials = step('reply-to-mention', 'Setup credentials');
    const handler = step('reply-to-mention', 'Run mention-reply handler');
    const completionReaction = step('reply-to-mention', 'Add completion reaction');
    expect(synthesize.if).toContain(triggerRoute);
    expect(synthesize.run).toContain('TRIGGER_RUN_ID');
    expect(synthesize.run).not.toContain('${{');
    expect(resolveEvent.run).toContain('if [ -n "$TRIGGER_RUN_ID" ]');
    expect(resolveEvent.run).toContain('path=$GITHUB_EVENT_PATH');
    expect(credentials.if).toBe("steps.resolve-event.outputs.path != ''");
    expect(handler.if).toBe("steps.resolve-event.outputs.path != ''");
    expect(completionReaction.env?.EVENT_NAME).toBe('${' + '{ steps.resolve-event.outputs.name }}');
    expect(completionReaction.env?.EVENT_NAME).not.toContain('github.event_name');
    expect(completionReaction.env?.EVENT_PATH).toBe('${' + '{ steps.resolve-event.outputs.path }}');
    expect(completionReaction.run).toContain('jq -r \'.comment.id // empty\' "$EVENT_PATH"');
    expect(completionReaction.run).toContain(
      'if [ "$EVENT_NAME" = "pull_request_review_comment" ]; then',
    );
    expect(completionReaction.run).toContain('repos/$REPO/pulls/comments/$COMMENT_ID/reactions');
    expect(completionReaction.run).toContain('repos/$REPO/issues/comments/$COMMENT_ID/reactions');
    expect(stepIndex('reply-to-mention', resolveEvent.name ?? '')).toBeLessThan(
      stepIndex('reply-to-mention', credentials.name ?? ''),
    );
    expect(stepIndex('reply-to-mention', credentials.name ?? '')).toBeLessThan(
      stepIndex('reply-to-mention', handler.name ?? ''),
    );
    expect(mention.if).toContain("trigger-route == 'mention'");
  });

  it('uses an attempt-unique, same-run artifact name without selecting artifacts by name', () => {
    const upload = step('resolve-context', 'Upload canonical trigger context');
    expect(upload.with?.name).toBe(uploadName);
    for (const route of ['reply-to-feedback', 'reply-to-mention']) {
      expect(step(route, 'Download canonical trigger context').with?.name).toBeUndefined();
    }
  });
});
