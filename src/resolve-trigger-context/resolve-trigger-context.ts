// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Octokit } from '@octokit/rest';

export interface TriggerContextInputs {
  triggerRunId: string;
  repository: string;
  repoToken: string;
  artifactDirectory: string;
}

type WorkflowRun = Awaited<ReturnType<Octokit['rest']['actions']['getWorkflowRun']>>['data'];
type WorkflowRunPullRequest = NonNullable<WorkflowRun['pull_requests']>[number];
type PullRequest = Awaited<ReturnType<Octokit['rest']['pulls']['get']>>['data'];
type ReviewComment = Awaited<ReturnType<Octokit['rest']['pulls']['getReviewComment']>>['data'];

export type { PullRequest, ReviewComment, WorkflowRun, WorkflowRunPullRequest };
export type TriggerRoute = 'review' | 'feedback' | 'mention' | 'none';

export interface CanonicalPullRequest {
  number: number;
  headSha: string;
  baseSha: string;
  baseRef: string;
  author: string;
}

export interface CanonicalComment {
  id: number;
  author: string;
  authorType: string;
  body: string;
  inReplyToId: number | null;
  pullRequestUrl: string;
  path: string | null;
  line: number | null;
  originalLine: number | null;
  side: string | null;
  startLine: number | null;
  startSide: string | null;
  diffHunk: string | null;
  commitId: string | null;
  originalCommitId: string | null;
}

export interface CanonicalTriggerContext {
  event: 'pull_request' | 'pull_request_review_comment';
  runId: number;
  runHeadSha: string;
  headAdvanced: boolean;
  actor: string;
  pullRequest: CanonicalPullRequest;
  comment: CanonicalComment | null;
}

function parseRepository(repository: string): [string, string] {
  const parts = repository.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1])
    throw new Error(`Invalid base repository: '${repository}'`);
  return [parts[0], parts[1]];
}

function requireRunId(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`Invalid trigger run ID: '${value}'`);
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`Invalid trigger run ID: '${value}'`);
  return id;
}

function requireSha(value: string | null | undefined, label: string): string {
  if (!value || !/^[a-f0-9]{40}$/i.test(value))
    throw new Error(`Invalid ${label}: '${value ?? ''}'`);
  return value;
}

function nullableSha(value: string | null | undefined, label: string): string | null {
  return value == null ? null : requireSha(value, label);
}

function readArtifactHint(artifactDirectory: string, filename: string): string {
  try {
    return readFileSync(join(artifactDirectory, filename), 'utf8').trim();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

function readCommentId(artifactDirectory: string): number {
  const direct = readArtifactHint(artifactDirectory, 'comment_id.txt');
  const legacy =
    direct ||
    (() => {
      const raw = readArtifactHint(artifactDirectory, 'comment.json');
      if (!raw) return '';
      try {
        return String((JSON.parse(raw) as { id?: unknown }).id ?? '');
      } catch {
        throw new Error('Legacy comment.json is malformed');
      }
    })();
  if (!/^\d+$/.test(legacy) || Number(legacy) <= 0) {
    throw new Error('A positive numeric comment ID is required for review-comment triggers');
  }
  return Number(legacy);
}

function assertArtifactEvent(artifactDirectory: string, event: string): void {
  const hint = readArtifactHint(artifactDirectory, 'event_name.txt');
  if (hint && hint !== event)
    throw new Error(`Artifact event '${hint}' does not match workflow run event '${event}'`);
}

function assertPrUrl(url: string, repository: string): [string, number] {
  const match = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/.exec(url);
  if (!match || `${match[1]}/${match[2]}` !== repository) {
    throw new Error(
      'Review comment belongs to a different repository or has an invalid pull request URL',
    );
  }
  return [match[1], Number(match[3])];
}

function canonicalPullRequest(pr: PullRequest): CanonicalPullRequest {
  return {
    number: pr.number,
    headSha: requireSha(pr.head.sha, 'PR head SHA'),
    baseSha: requireSha(pr.base.sha, 'PR base SHA'),
    baseRef: pr.base.ref,
    author: pr.user?.login ?? '',
  };
}

function repositoryIdentityMatches(
  association: WorkflowRunPullRequest,
  run: WorkflowRun,
  repository: string,
): boolean {
  const base = association.base?.repo;
  if (!base) return false;
  const expectedUrl = `https://api.github.com/repos/${repository}`;
  return (
    (typeof base.id === 'number' && base.id === run.repository?.id) || base.url === expectedUrl
  );
}

function findAssociatedPr(run: WorkflowRun, repository: string): number | null {
  const prs = run.pull_requests ?? [];
  if (prs.length > 1) throw new Error('Workflow run is associated with multiple pull requests');
  const pr = prs[0];
  if (!pr) return null;
  if (
    !Number.isSafeInteger(pr.number) ||
    pr.number <= 0 ||
    !repositoryIdentityMatches(pr, run, repository)
  ) {
    throw new Error('Workflow run pull request metadata does not match the trusted run');
  }
  return pr.number;
}

function canonicalComment(comment: ReviewComment): CanonicalComment {
  return {
    id: comment.id,
    author: comment.user?.login ?? '',
    authorType: comment.user?.type ?? '',
    body: comment.body,
    inReplyToId: comment.in_reply_to_id ?? null,
    pullRequestUrl: comment.pull_request_url,
    path: comment.path ?? null,
    line: comment.line ?? null,
    originalLine: comment.original_line ?? null,
    side: comment.side ?? null,
    startLine: comment.start_line ?? null,
    startSide: comment.start_side ?? null,
    diffHunk: comment.diff_hunk ?? null,
    commitId: nullableSha(comment.commit_id, 'review comment commit SHA'),
    originalCommitId: nullableSha(comment.original_commit_id, 'review comment original commit SHA'),
  };
}

export function triggerRoute(
  context: Pick<CanonicalTriggerContext, 'event' | 'comment'>,
): TriggerRoute {
  if (context.event === 'pull_request') return 'review';
  const comment = context.comment;
  if (!comment) return 'none';
  if (comment.inReplyToId !== null) return 'feedback';
  if (/@docker-agent(?=[^a-zA-Z0-9_-]|$)/.test(comment.body) && !comment.body.startsWith('/review'))
    return 'mention';
  return 'none';
}

async function findForkPr(
  octokit: Octokit,
  run: WorkflowRun,
  owner: string,
  repo: string,
): Promise<number> {
  const headRepository = run.head_repository?.full_name;
  const headOwner = run.head_repository?.owner?.login;
  const headBranch = run.head_branch;
  if (!headRepository || !headOwner || !headBranch)
    throw new Error('Workflow run has no pull request locator');
  const candidates = await octokit.paginate(octokit.rest.pulls.list, {
    owner,
    repo,
    head: `${headOwner}:${headBranch}`,
    state: 'open',
    per_page: 100,
  });
  const matches = candidates.filter(
    (candidate) => candidate.head.repo?.full_name === headRepository,
  );
  if (matches.length !== 1)
    throw new Error('Workflow run pull request lookup was ambiguous or empty');
  return matches[0].number;
}

export async function resolveTriggerContext(
  inputs: TriggerContextInputs,
): Promise<CanonicalTriggerContext> {
  if (!inputs.artifactDirectory) throw new Error('TRIGGER_ARTIFACT_DIRECTORY is not set');
  const runId = requireRunId(inputs.triggerRunId);
  const [owner, repo] = parseRepository(inputs.repository);
  const octokit = new Octokit({ auth: inputs.repoToken });
  const { data: run } = await octokit.rest.actions.getWorkflowRun({ owner, repo, run_id: runId });
  if (run.repository?.full_name !== inputs.repository)
    throw new Error('Workflow run belongs to a different repository');
  if (run.status !== 'completed' || run.conclusion !== 'success')
    throw new Error('Workflow run did not complete successfully');
  if (run.event !== 'pull_request' && run.event !== 'pull_request_review_comment')
    throw new Error(`Unsupported workflow run event: '${run.event ?? ''}'`);
  const event = run.event;
  assertArtifactEvent(inputs.artifactDirectory, event);
  const runHeadSha = requireSha(run.head_sha, 'workflow run head SHA');
  const actor = run.actor?.login ?? '';
  if (!actor) throw new Error('Workflow run has no original actor');

  if (event === 'pull_request') {
    const associatedPr = findAssociatedPr(run, inputs.repository);
    const prNumber = associatedPr ?? (await findForkPr(octokit, run, owner, repo));
    const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
    const pullRequest = canonicalPullRequest(pr);
    return {
      event,
      runId,
      runHeadSha,
      headAdvanced: pullRequest.headSha !== runHeadSha,
      actor,
      pullRequest,
      comment: null,
    };
  }

  const commentId = readCommentId(inputs.artifactDirectory);
  const { data: reviewComment } = await octokit.rest.pulls.getReviewComment({
    owner,
    repo,
    comment_id: commentId,
  });
  if (reviewComment.user?.login !== actor)
    throw new Error('Live review comment author does not match original workflow run actor');
  const [, prNumber] = assertPrUrl(reviewComment.pull_request_url, inputs.repository);
  const associatedPr = findAssociatedPr(run, inputs.repository);
  if (associatedPr !== null && associatedPr !== prNumber)
    throw new Error('Review comment PR does not match workflow run PR');
  const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  const pullRequest = canonicalPullRequest(pr);
  return {
    event,
    runId,
    runHeadSha,
    headAdvanced: pullRequest.headSha !== runHeadSha,
    actor,
    pullRequest,
    comment: canonicalComment(reviewComment),
  };
}
