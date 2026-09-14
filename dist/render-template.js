import { createRequire } from 'node:module'; var require = createRequire(import.meta.url);

// src/render-template/index.ts
import { readFileSync, writeFileSync } from "fs";

// src/render-template/render-template.ts
var TemplateValidationError = class extends Error {
};
var SHA_PATTERN = /^[0-9a-fA-F]{40}$/;
var PR_NUMBER_PATTERN = /^[0-9]+$/;
function renderPostingTemplate(template, opts) {
  const { prHeadSha, prNumber } = opts;
  if (!SHA_PATTERN.test(prHeadSha)) {
    throw new TemplateValidationError(
      "Selected PR head SHA is invalid; refusing to stage review posting"
    );
  }
  if (!PR_NUMBER_PATTERN.test(prNumber)) {
    throw new TemplateValidationError(
      "Resolved PR number is invalid; refusing to stage review posting"
    );
  }
  const rendered = template.split("__PR_HEAD_SHA__").join(prHeadSha).split("{pr}").join(prNumber);
  if (rendered.includes("__PR_HEAD_SHA__") || rendered.includes("$PR_HEAD_SHA")) {
    throw new TemplateValidationError(
      "Rendered posting template failed validation (unreplaced SHA placeholder)"
    );
  }
  if (rendered.includes("{pr}")) {
    throw new TemplateValidationError(
      "Rendered posting template failed validation (unreplaced {pr} placeholder)"
    );
  }
  const commitIdCount = (rendered.match(/--arg commit_id/g) ?? []).length;
  if (commitIdCount !== 1) {
    throw new TemplateValidationError(
      "Rendered posting template failed validation (expected exactly one commit_id argument)"
    );
  }
  if (!rendered.includes(`--arg commit_id "${prHeadSha}"`)) {
    throw new TemplateValidationError(
      "Rendered posting template failed validation (commit_id does not match selected SHA)"
    );
  }
  return rendered;
}
function renderReplyTemplate(template, prNumber) {
  if (!PR_NUMBER_PATTERN.test(prNumber)) {
    throw new TemplateValidationError(
      "Resolved PR number is invalid; refusing to stage reply posting"
    );
  }
  const rendered = template.split("{pr}").join(prNumber);
  if (rendered.includes("{pr}")) {
    throw new TemplateValidationError(
      "Rendered reply template failed validation (unreplaced {pr} placeholder)"
    );
  }
  return rendered;
}

// src/render-template/index.ts
function usageError() {
  process.stderr.write(
    "Usage:\n  render-template posting <templatePath> <outputPath> <prHeadSha> <prNumber>\n  render-template reply <templatePath> <outputPath> <prNumber>\n"
  );
  process.exit(1);
}
var [, , mode, templatePath, outputPath, ...rest] = process.argv;
if (!mode || !templatePath || !outputPath) usageError();
try {
  const template = readFileSync(templatePath, "utf8");
  let rendered;
  if (mode === "posting") {
    const [prHeadSha, prNumber] = rest;
    if (!prHeadSha || !prNumber) usageError();
    rendered = renderPostingTemplate(template, { prHeadSha, prNumber });
  } else if (mode === "reply") {
    const [prNumber] = rest;
    if (!prNumber) usageError();
    rendered = renderReplyTemplate(template, prNumber);
  } else {
    usageError();
  }
  writeFileSync(outputPath, rendered);
} catch (err) {
  if (err instanceof TemplateValidationError) {
    process.stderr.write(`::error::${err.message}
`);
  } else {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}
`);
  }
  process.exit(1);
}
