// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { Octokit } from '@octokit/rest';
import { createSignedCommit } from './signed-commit.js';

interface ParsedArgs {
  repo?: string;
  branch?: string;
  message?: string;
  body?: string;
  baseRef?: string;
  force: boolean;
  adds: string[];
  deletes: string[];
  addFromStdin: boolean;
  deleteFromStdin: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = {
    force: false,
    adds: [],
    deletes: [],
    addFromStdin: false,
    deleteFromStdin: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--repo') {
      result.repo = args[++i];
    } else if (arg === '--branch') {
      result.branch = args[++i];
    } else if (arg === '--message') {
      result.message = args[++i];
    } else if (arg === '--body') {
      result.body = args[++i];
    } else if (arg === '--base-ref') {
      result.baseRef = args[++i];
    } else if (arg === '--force') {
      result.force = true;
    } else if (arg === '--add-stdin') {
      result.addFromStdin = true;
    } else if (arg === '--delete-stdin') {
      result.deleteFromStdin = true;
    } else if (arg === '--add') {
      const val = args[++i];
      if (val === undefined) throw new Error('--add requires a file path argument');
      result.adds.push(val);
    } else if (arg === '--delete') {
      const val = args[++i];
      if (val === undefined) throw new Error('--delete requires a file path argument');
      result.deletes.push(val);
    }
  }

  return result;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.repo) throw new Error('--repo is required');
  if (!args.branch) throw new Error('--branch is required');
  if (!args.message) throw new Error('--message is required');

  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN environment variable is required');

  /**
   * Guard against absolute paths being used as git file paths.
   * The GitHub createCommitOnBranch GraphQL API requires paths relative to the
   * repository root (e.g. `dist/main.js`, not `/home/runner/.../dist/main.js`).
   * Absolute paths cause a cryptic GitHub API error:
   *   "A path was requested for deletion which does not exist as of commit oid …"
   * Catch this early so callers get a useful message instead.
   */
  function assertRelativePath(filePath: string, flag: string): void {
    if (isAbsolute(filePath)) {
      throw new Error(
        `${flag} received an absolute path: "${filePath}". ` +
          'Git file paths must be relative to the repository root. ' +
          'Hint: use `find dist/ -type f` instead of `find "$GITHUB_WORKSPACE/dist/" -type f`.',
      );
    }
  }

  const additions = args.adds.map((filePath) => {
    assertRelativePath(filePath, '--add');
    return {
      path: filePath,
      contents: readFileSync(filePath).toString('base64'),
    };
  });

  const deletions = args.deletes.map((filePath) => {
    assertRelativePath(filePath, '--delete');
    return { path: filePath };
  });

  if (args.addFromStdin && args.deleteFromStdin) {
    throw new Error(
      '--add-stdin and --delete-stdin cannot be used together (stdin can only be read once)',
    );
  }

  if (args.addFromStdin) {
    if (process.stdin.isTTY) {
      throw new Error('--add-stdin requires piped input (stdin is a TTY)');
    }
    const input = readFileSync('/dev/stdin', 'utf-8');
    const paths = input
      .split('\n')
      .map((p) => p.trim())
      .filter(Boolean);
    for (const p of paths) {
      assertRelativePath(p, '--add-stdin');
      additions.push({
        path: p,
        contents: readFileSync(p).toString('base64'),
      });
    }
  }

  if (args.deleteFromStdin) {
    if (process.stdin.isTTY) {
      throw new Error('--delete-stdin requires piped input (stdin is a TTY)');
    }
    const input = readFileSync('/dev/stdin', 'utf-8');
    const paths = input
      .split('\n')
      .map((p) => p.trim())
      .filter(Boolean);
    for (const p of paths) {
      assertRelativePath(p, '--delete-stdin');
      deletions.push({ path: p });
    }
  }

  const octokit = new Octokit({ auth: token });

  const oid = await createSignedCommit(octokit, {
    repo: args.repo,
    branch: args.branch,
    message: args.message,
    body: args.body,
    baseRef: args.baseRef,
    force: args.force,
    additions,
    deletions,
  });

  process.stdout.write(`${oid}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
