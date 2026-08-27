// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * sync-caller-permissions CLI entrypoint.
 *
 * Usage:
 *   node dist/sync-caller-permissions.js --reusable <reviewPrWorkflowPath> <consumerWorkflowPath>
 *
 * Raises the `permissions:` grants in a consumer caller workflow to what the
 * reusable PR-review workflow at <reviewPrWorkflowPath> (the file as of the
 * version being pinned) requires from its caller. The consumer file is edited
 * in place, only when a grant is insufficient (issue #72: v2.0.3 raised
 * `actions` from read to write and broke callers granting only read).
 *
 * stdout is a machine-readable report, one line per increase:
 *
 *   changed <block> <scope> <from> <to>   — edited into the file
 *   manual <block> <scope> <from> <to>    — required but not editable safely
 *
 * where <block> is `workflow` or `job:<id>`, and <from> is `unknown` when the
 * consumer has no explicit permissions block (the repo default applies).
 * Prints nothing when the grants are already sufficient. Progress messages go
 * to stderr. Exits non-zero on unreadable/unparseable input so the calling
 * workflow can tell "nothing to do" apart from "could not check".
 *
 * See sync-caller-permissions.ts for the scanning and rewrite logic.
 */
import { applySync } from './sync-caller-permissions.js';

const args = process.argv.slice(2);
let reusablePath: string | undefined;
const positional: string[] = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--reusable') {
    reusablePath = args[++i];
  } else {
    positional.push(args[i]);
  }
}

const consumerPath = positional[0];
if (!reusablePath || !consumerPath || positional.length > 1) {
  process.stderr.write(
    'Usage: sync-caller-permissions --reusable <reviewPrWorkflowPath> <consumerWorkflowPath>\n',
  );
  process.exit(1);
}

try {
  const result = applySync(reusablePath, consumerPath);
  for (const inc of result.applied) {
    process.stdout.write(`changed ${inc.block} ${inc.scope} ${inc.from} ${inc.to}\n`);
  }
  for (const inc of result.manual) {
    process.stdout.write(`manual ${inc.block} ${inc.scope} ${inc.from} ${inc.to}\n`);
  }
} catch (err) {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
