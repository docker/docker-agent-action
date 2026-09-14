// Copyright The Docker Agent Action authors
// SPDX-License-Identifier: Apache-2.0

/**
 * render-template CLI entrypoint.
 *
 * Usage:
 *   node dist/render-template.js posting <templatePath> <outputPath> <prHeadSha> <prNumber>
 *   node dist/render-template.js reply <templatePath> <outputPath> <prNumber>
 *
 * Reads templatePath, renders it (see render-template.ts for the
 * substitution + validation rules), and writes the result to outputPath.
 * Exits 1 with an `::error::`-annotated message on any validation failure —
 * callers must treat a non-zero exit as "do not stage/post this template".
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  renderPostingTemplate,
  renderReplyTemplate,
  TemplateValidationError,
} from './render-template.js';

function usageError(): never {
  process.stderr.write(
    'Usage:\n' +
      '  render-template posting <templatePath> <outputPath> <prHeadSha> <prNumber>\n' +
      '  render-template reply <templatePath> <outputPath> <prNumber>\n',
  );
  process.exit(1);
}

const [, , mode, templatePath, outputPath, ...rest] = process.argv;

if (!mode || !templatePath || !outputPath) usageError();

try {
  const template = readFileSync(templatePath, 'utf8');
  let rendered: string;
  if (mode === 'posting') {
    const [prHeadSha, prNumber] = rest;
    if (!prHeadSha || !prNumber) usageError();
    rendered = renderPostingTemplate(template, { prHeadSha, prNumber });
  } else if (mode === 'reply') {
    const [prNumber] = rest;
    if (!prNumber) usageError();
    rendered = renderReplyTemplate(template, prNumber);
  } else {
    usageError();
  }
  writeFileSync(outputPath, rendered);
} catch (err) {
  if (err instanceof TemplateValidationError) {
    process.stderr.write(`::error::${err.message}\n`);
  } else {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  process.exit(1);
}
