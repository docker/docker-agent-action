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
import { delimiter, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { resolverOutputs } from '../index.js';
import type { CanonicalComment, CanonicalTriggerContext } from '../resolve-trigger-context.js';

const root = resolve(import.meta.dirname, '../../..');
const safePath = '/usr/bin:/bin';

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

function actionStepRun(name: string): string {
  const action = parseDocument(
    readFileSync(resolve(root, 'review-pr/action.yml'), 'utf8'),
  ).toJS() as Action;
  const matches = action.runs?.steps?.filter((candidate) => candidate.name === name) ?? [];
  if (matches.length !== 1 || !matches[0].run) throw new Error(`Expected one ${name} run body`);
  return matches[0].run;
}

function summaryRun(): string {
  return actionStepRun('Post clean summary');
}

function runCopyReference(
  headSha: string,
  template: string,
  prNumber = '5929',
): ReturnType<typeof spawnSync> {
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
    const result = spawnSync(
      '/bin/bash',
      ['--noprofile', '--norc', '-e', '-o', 'pipefail', resolve(directory, 'run.sh')],
      {
        env: testEnvironment({
          ACTION_PATH: actionPath,
          PR_HEAD_SHA: headSha,
          PR_NUMBER: prNumber,
          GITHUB_OUTPUT: output,
        }),
        encoding: 'utf8',
      },
    );
    if (result.status === 0)
      expect(readFileSync(output, 'utf8')).toContain(
        'posting-reference=/tmp/refs/posting-format.md',
      );
    return result;
  } finally {
    rmSync(originalRefs, { recursive: true, force: true });
    if (existsSync(backupRefs))
      cpSync(backupRefs, originalRefs, { recursive: true, dereference: false });
    rmSync(directory, { recursive: true, force: true });
  }
}

function replyActionStepRun(name: string): string {
  const action = parseDocument(
    readFileSync(resolve(root, 'review-pr/reply/action.yml'), 'utf8'),
  ).toJS() as Action;
  const matches = action.runs?.steps?.filter((candidate) => candidate.name === name) ?? [];
  if (matches.length !== 1 || !matches[0].run) throw new Error(`Expected one ${name} run body`);
  return matches[0].run;
}

function runStageReplyAgent(
  prNumber: string,
  template: string,
): { result: ReturnType<typeof spawnSync>; staged: string | null } {
  const directory = mkdtempSync(resolve(tmpdir(), 'docker-agent-stage-reply-'));
  // ACTION_PATH is the reply action dir; the step references $ACTION_PATH/../agents/
  const actionPath = resolve(directory, 'reply');
  const agentsDir = resolve(directory, 'agents');
  const stagedPath = '/tmp/pr-review-reply.yaml';
  const backupPath = resolve(directory, 'pr-review-reply.yaml.bak');
  try {
    mkdirSync(actionPath, { recursive: true });
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(resolve(agentsDir, 'pr-review-reply.yaml'), template);
    writeFileSync(resolve(directory, 'run.sh'), replyActionStepRun('Stage reply agent'));
    if (existsSync(stagedPath)) cpSync(stagedPath, backupPath);
    const result = spawnSync(
      '/bin/bash',
      ['--noprofile', '--norc', '-e', '-o', 'pipefail', resolve(directory, 'run.sh')],
      {
        env: testEnvironment({
          ACTION_PATH: actionPath,
          PR_NUMBER: prNumber,
        }),
        encoding: 'utf8',
      },
    );
    const staged = existsSync(stagedPath) ? readFileSync(stagedPath, 'utf8') : null;
    return { result, staged };
  } finally {
    if (existsSync(backupPath)) cpSync(backupPath, stagedPath);
    else if (existsSync(stagedPath)) rmSync(stagedPath);
    rmSync(directory, { recursive: true, force: true });
  }
}

type SummaryInvocation = {
  skipReason?: string;
  exitCode?: string;
  verboseLog?: string;
  chunkCount?: string;
  headSha?: string;
  postingReference?: string;
  dedupCounts?: [number, number];
};

type GhRecord = { args: string; input: string };

function runSummary(invocation: SummaryInvocation): {
  result: ReturnType<typeof spawnSync>;
  records: GhRecord[];
  summary: string;
  directory: string;
} {
  const directory = mkdtempSync(resolve(tmpdir(), 'docker-agent-summary-'));
  const output = resolve(directory, 'output');
  const summary = resolve(directory, 'summary');
  const recordsPath = resolve(directory, 'gh-records.jsonl');
  writeFileSync(recordsPath, '');
  writeFileSync(output, '');
  writeFileSync(summary, '');
  const reference = invocation.postingReference ?? resolve(directory, 'posting-format.md');
  const sha = invocation.headSha ?? 'a'.repeat(40);
  writeFileSync(resolve(directory, 'summary.sh'), summaryRun());
  if (!invocation.postingReference) {
    writeFileSync(reference, `jq -n --arg commit_id "${sha}" '{commit_id: $commit_id}'`);
  }
  if (invocation.verboseLog !== undefined)
    writeFileSync(resolve(directory, 'verbose.log'), invocation.verboseLog);
  writeFileSync(
    resolve(directory, 'gh'),
    `#!/usr/bin/env bash
set -euo pipefail
args="$*"
input=""
if [[ "$args" == *" --input -" ]]; then input=$(cat); fi
printf '%s\\n' "$(jq -cn --arg args "$args" --arg input "$input" '{args: $args, input: $input}')" >> "$GH_RECORDS"
if [[ "$args" == *"/reviews --jq "* ]]; then
  if [[ "$args" == *"/issues/"* ]]; then printf '%s\\n' "${invocation.dedupCounts?.[1] ?? 0}"; else printf '%s\\n' "${invocation.dedupCounts?.[0] ?? 0}"; fi
fi
`,
  );
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
        ACTION_PATH: directory,
        PR_HEAD_SHA: sha,
        POSTING_REFERENCE: reference,
      }),
      encoding: 'utf8',
    },
  );
  const records = readFileSync(recordsPath, 'utf8', { flag: 'a+' })
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as GhRecord);
  return { result, records, summary: readFileSync(summary, 'utf8'), directory };
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

  it.each([
    {
      name: 'normal agent-posted success',
      exitCode: '0',
      verboseLog: 'pullrequestreview-1',
      reads: 0,
      body: undefined,
    },
    {
      name: 'zero-findings already posted',
      exitCode: '0',
      verboseLog: 'no review',
      dedupCounts: [1, 0],
      reads: 2,
      body: undefined,
    },
    {
      name: 'timeout with unknown chunks',
      exitCode: '124',
      verboseLog: 'no review',
      chunkCount: '',
      reads: 0,
      body: '⏱️',
    },
    {
      name: 'timeout with one chunk',
      exitCode: '124',
      verboseLog: 'no review',
      chunkCount: '1',
      reads: 0,
      body: '⏱️',
    },
    {
      name: 'timeout with many chunks',
      exitCode: '124',
      verboseLog: 'no review',
      chunkCount: '2',
      reads: 0,
      body: '⏱️',
    },
    { name: 'non-124 failure', exitCode: '1', verboseLog: 'no review', reads: 0, body: '❌' },
    {
      name: 'failure with prior review',
      exitCode: '1',
      verboseLog: 'pullrequestreview-1',
      reads: 0,
      body: undefined,
    },
    {
      name: 'incomplete-run notice',
      exitCode: '0',
      verboseLog: 'no review',
      dedupCounts: [0, 0],
      reads: 2,
      body: '⚠️',
    },
    { name: 'success without log', exitCode: '0', reads: 0, body: undefined },
  ])('executes the summary $name vector with exact review payload behavior', (vector) => {
    const sha = 'a'.repeat(40);
    const run = runSummary(vector);
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      const creations = reviewCreations(run.records);
      expect(run.records.filter((record) => record.args.includes(' --jq '))).toHaveLength(
        vector.reads,
      );
      expect(creations).toHaveLength(vector.body ? 1 : 0);
      if (vector.body) expectReviewPayload(creations[0], sha, vector.body);
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
    ['missing reference', undefined],
    ['retained template marker', 'jq -n --arg commit_id "__PR_HEAD_SHA__"'],
    ['retained shell marker', 'jq -n --arg commit_id "$PR_HEAD_SHA"'],
    ['zero commit argument', 'jq -n'],
    [
      'multiple commit arguments',
      'jq -n --arg commit_id "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" --arg commit_id "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
    ],
    [
      'selected/rendered SHA mismatch',
      'jq -n --arg commit_id "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"',
    ],
  ])('executes malformed posting reference %s without API access', (_name, content) => {
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
      expect(run.result.stderr).toContain(
        'Rendered posting reference does not contain exactly one',
      );
      expect(run.records).toEqual([]);
    } finally {
      rmSync(run.directory, { recursive: true, force: true });
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { skipReason: 'concurrent' },
    { exitCode: '' },
  ])('executes benign skip states without requiring preflight inputs', (vector) => {
    const directory = mkdtempSync(resolve(tmpdir(), 'docker-agent-skip-'));
    const run = runSummary({
      ...vector,
      headSha: '',
      postingReference: resolve(directory, 'missing'),
    });
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.summary).toContain('Review skipped');
      expect(run.records).toEqual([]);
    } finally {
      rmSync(run.directory, { recursive: true, force: true });
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ['valid immutable SHA', 'a'.repeat(40), 'jq -n --arg commit_id "__PR_HEAD_SHA__"', '5929'],
    ['empty SHA', '', 'jq -n --arg commit_id "__PR_HEAD_SHA__"', '5929'],
    ['non-hex SHA', 'g'.repeat(40), 'jq -n --arg commit_id "__PR_HEAD_SHA__"', '5929'],
    ['short SHA', 'a'.repeat(39), 'jq -n --arg commit_id "__PR_HEAD_SHA__"', '5929'],
    ['long SHA', 'a'.repeat(41), 'jq -n --arg commit_id "__PR_HEAD_SHA__"', '5929'],
    ['unresolved template', 'a'.repeat(40), 'jq -n --arg commit_id "$PR_HEAD_SHA"', '5929'],
    ['zero commit arguments', 'a'.repeat(40), 'jq -n --arg body "review"', '5929'],
    [
      'multiple commit arguments',
      'a'.repeat(40),
      'jq -n --arg commit_id "__PR_HEAD_SHA__" --arg commit_id "x"',
      '5929',
    ],
    ['empty PR number', 'a'.repeat(40), 'jq -n --arg commit_id "__PR_HEAD_SHA__"', ''],
    ['non-numeric PR number', 'a'.repeat(40), 'jq -n --arg commit_id "__PR_HEAD_SHA__"', 'abc'],
    [
      'PR number with shell metacharacters',
      'a'.repeat(40),
      'jq -n --arg commit_id "__PR_HEAD_SHA__"',
      '111; echo INJECTED',
    ],
  ])('executes Copy reference files staging preflight for %s', (_name, sha, template, prNumber) => {
    const result = runCopyReference(sha, template, prNumber);
    const validSha = /^[a-f0-9]{40}$/i.test(sha);
    const validPr = /^[0-9]+$/.test(prNumber);
    const validTemplate = template === 'jq -n --arg commit_id "__PR_HEAD_SHA__"';
    expect(result.status, result.stderr).toBe(validSha && validPr && validTemplate ? 0 : 1);
  });

  it.each([
    ['valid PR number', '5929', 'gh api repos/{owner}/{repo}/pulls/{pr}/comments --input -'],
    ['empty PR number', '', 'gh api repos/{owner}/{repo}/pulls/{pr}/comments --input -'],
    ['non-numeric PR number', 'abc', 'gh api repos/{owner}/{repo}/pulls/{pr}/comments --input -'],
    [
      'PR number with shell metacharacters',
      '111; echo INJECTED',
      'gh api repos/{owner}/{repo}/pulls/{pr}/comments --input -',
    ],
  ])('stages reply agent with {pr} substitution for %s', (_name, prNumber, template) => {
    const { result, staged } = runStageReplyAgent(prNumber, template);
    const validPr = /^[0-9]+$/.test(prNumber);
    if (validPr) {
      expect(result.status, result.stderr).toBe(0);
      expect(staged).not.toBeNull();
      expect(staged).not.toContain('{pr}');
      expect(staged).toContain(prNumber);
    } else {
      // Invalid PR number: step exits 0 with a warning, copies unrendered template
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/warning/i);
    }
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
