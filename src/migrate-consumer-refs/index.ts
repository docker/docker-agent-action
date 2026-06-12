/**
 * migrate-consumer-refs CLI entrypoint.
 *
 * Rewrites `docker/cagent-action` references to `docker/docker-agent-action`
 * in one or more files, in-place.
 *
 * Usage:
 *   node dist/migrate-consumer-refs.js [--sha <40-hex> --version <vX.Y.Z>] <file> [<file> ...]
 *
 * Flags:
 *   --sha <sha>          Re-pin every `uses:` ref to this commit SHA.
 *   --version <version>  Trailing `# version` comment used with --sha.
 *
 * Without --sha, existing refs are preserved (slug-only mode).
 *
 * Output (stdout): one line per changed file:  `changed <path>`
 * Progress/diagnostics go to stderr.
 *
 * Exit codes:
 *   0  all files processed (whether or not anything changed)
 *   1  at least one file failed to read/write, or bad arguments.
 *      Per-file failures do NOT abort the loop — every file is attempted —
 *      but the non-zero exit tells callers the run is incomplete so they
 *      must not commit a partial migration.
 */
import { applyMigration } from './migrate-refs.js';

interface ParsedArgs {
  sha?: string;
  version?: string;
  files: string[];
}

function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = { files: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--sha') {
      const val = args[++i];
      if (val === undefined) throw new Error('--sha requires a value');
      result.sha = val;
    } else if (arg === '--version') {
      const val = args[++i];
      if (val === undefined) throw new Error('--version requires a value');
      result.version = val;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      result.files.push(arg);
    }
  }
  return result;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (args.files.length === 0) {
    process.stderr.write(
      'Usage: migrate-consumer-refs [--sha <40-hex> --version <vX.Y.Z>] <file> [<file> ...]\n',
    );
    process.exit(1);
  }

  if (args.version !== undefined && args.sha === undefined) {
    throw new Error('--version requires --sha');
  }

  const { changedFiles, errors } = applyMigration(args.files, {
    newSha: args.sha,
    newVersion: args.version,
  });

  for (const file of changedFiles) {
    process.stdout.write(`changed ${file}\n`);
  }

  process.stderr.write(`Done: ${changedFiles.length}/${args.files.length} file(s) changed\n`);

  if (errors.length > 0) {
    process.stderr.write(
      `Error: ${errors.length} file(s) could not be processed — failing so callers do not commit a partial migration\n`,
    );
    process.exit(1);
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
