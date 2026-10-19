import { createRequire } from 'node:module'; var require = createRequire(import.meta.url);

// src/caller-permissions/caller-permissions.ts
import { readFileSync } from "fs";
var ALL_SCOPES = "*";
var LEVEL_RANK = { none: 0, read: 1, write: 2 };
function significantLines(source) {
  const out = [];
  const rawLines = source.split("\n");
  for (let i = 0; i < rawLines.length; i++) {
    const noCr = rawLines[i].endsWith("\r") ? rawLines[i].slice(0, -1) : rawLines[i];
    const text = noCr.trim();
    if (text === "" || text.startsWith("#")) continue;
    out.push({ indent: noCr.length - noCr.trimStart().length, text, lineNo: i + 1 });
  }
  return out;
}
function stripTrailingComment(text) {
  return text.replace(/(?:^|\s)#.*$/, "").trim();
}
var KEY_RE = /^([A-Za-z_][A-Za-z0-9_-]*):(?:\s+(.*))?$/;
function matchKey(text) {
  const m = text.match(KEY_RE);
  if (!m) return null;
  return { key: m[1], rest: stripTrailingComment(m[2] ?? "") };
}
function parseAccessLevel(token, lineNo) {
  const unquoted = token.replace(/^(['"])(.*)\1$/, "$2");
  if (unquoted === "none" || unquoted === "read" || unquoted === "write") return unquoted;
  throw new Error(
    `Unrecognized permission level "${token}" at line ${lineNo} (expected none, read, or write)`
  );
}
function parseInlinePermissions(value, lineNo) {
  if (value === "read-all") return { [ALL_SCOPES]: "read" };
  if (value === "write-all") return { [ALL_SCOPES]: "write" };
  if (value.startsWith("{") && value.endsWith("}")) {
    const inner = value.slice(1, -1).trim();
    if (inner === "") return {};
    const permissions = {};
    for (const part of inner.split(",")) {
      const m = part.trim().match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(\S+)$/);
      if (!m) {
        throw new Error(`Malformed inline permissions entry "${part.trim()}" at line ${lineNo}`);
      }
      permissions[m[1]] = parseAccessLevel(m[2], lineNo);
    }
    return permissions;
  }
  throw new Error(`Unrecognized permissions value "${value}" at line ${lineNo}`);
}
function parsePermissionsValue(lines, keyIdx, inlineValue) {
  const keyLine = lines[keyIdx];
  if (inlineValue !== "") {
    return {
      permissions: parseInlinePermissions(inlineValue, keyLine.lineNo),
      nextIdx: keyIdx + 1
    };
  }
  const permissions = {};
  let i = keyIdx + 1;
  while (i < lines.length && lines[i].indent > keyLine.indent) {
    const entry = stripTrailingComment(lines[i].text);
    const m = entry.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(\S+)$/);
    if (!m) {
      throw new Error(`Malformed permissions entry at line ${lines[i].lineNo}: "${lines[i].text}"`);
    }
    permissions[m[1]] = parseAccessLevel(m[2], lines[i].lineNo);
    i++;
  }
  return { permissions, nextIdx: i };
}
function parseJobBody(lines, start, jobIndent, job) {
  let i = start;
  let childIndent = -1;
  while (i < lines.length && lines[i].indent > jobIndent) {
    const line = lines[i];
    if (childIndent === -1) childIndent = line.indent;
    if (line.indent === childIndent) {
      const m = matchKey(line.text);
      if (m?.key === "permissions") {
        const parsed = parsePermissionsValue(lines, i, m.rest);
        job.permissions = parsed.permissions;
        i = parsed.nextIdx;
        continue;
      }
    }
    i++;
  }
  return i;
}
function parseJobsSection(lines, start, out) {
  let i = start;
  let jobIndent = -1;
  while (i < lines.length && lines[i].indent > 0) {
    const line = lines[i];
    if (jobIndent === -1) jobIndent = line.indent;
    if (line.indent === jobIndent) {
      const m = matchKey(line.text);
      if (m) {
        const job = { id: m.key, permissions: void 0 };
        out.push(job);
        i = parseJobBody(lines, i + 1, jobIndent, job);
        continue;
      }
    }
    i++;
  }
  return i;
}
function parseWorkflowPermissions(source) {
  const lines = significantLines(source);
  let workflow;
  const jobs = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent === 0) {
      const m = matchKey(line.text);
      if (m?.key === "permissions") {
        const parsed = parsePermissionsValue(lines, i, m.rest);
        workflow = parsed.permissions;
        i = parsed.nextIdx;
        continue;
      }
      if (m?.key === "jobs") {
        i = parseJobsSection(lines, i + 1, jobs);
        continue;
      }
    }
    i++;
  }
  return { workflow, jobs };
}
function computeCallerRequirement(wf) {
  const blocks = wf.jobs.map((job) => job.permissions ?? wf.workflow);
  const effectiveBlocks = blocks.length > 0 ? blocks : [wf.workflow];
  const requirement = {};
  for (const block of effectiveBlocks) {
    if (block === void 0) continue;
    for (const [scope, level] of Object.entries(block)) {
      const current = requirement[scope] ?? "none";
      if (LEVEL_RANK[level] > LEVEL_RANK[current]) requirement[scope] = level;
    }
  }
  for (const [scope, level] of Object.entries(requirement)) {
    if (level === "none") delete requirement[scope];
  }
  return requirement;
}
function diffCallerRequirements(previous, current) {
  const effective = (req, scope) => {
    const direct = req[scope] ?? "none";
    if (scope === ALL_SCOPES) return direct;
    const wildcard = req[ALL_SCOPES] ?? "none";
    return LEVEL_RANK[direct] >= LEVEL_RANK[wildcard] ? direct : wildcard;
  };
  const scopes = [.../* @__PURE__ */ new Set([...Object.keys(previous), ...Object.keys(current)])].sort();
  const increases = [];
  for (const scope of scopes) {
    const from = effective(previous, scope);
    const to = effective(current, scope);
    if (LEVEL_RANK[to] > LEVEL_RANK[from]) increases.push({ scope, from, to });
  }
  return increases;
}
var SETUP_DOCS_URL = "https://github.com/docker/docker-agent-action/blob/main/review-pr/README.md#quick-start";
function renderBreakingChangeWarning(increases) {
  if (increases.length === 0) return "";
  const bullets = increases.map((inc) => {
    const scope = inc.scope === ALL_SCOPES ? "all scopes" : `\`${inc.scope}\``;
    const from = inc.from === "none" ? "not previously required" : `\`${inc.from}\``;
    return `- ${scope}: ${from} \u2192 \`${inc.to}\``;
  }).join("\n");
  return [
    "## \u26A0\uFE0F Breaking change: callers of the PR-review workflow must grant more permissions",
    "",
    "This release increases the GitHub token permissions that the reusable PR-review workflow (`.github/workflows/review-pr.yml`) requests from its caller:",
    "",
    bullets,
    "",
    `A called workflow cannot elevate the permissions granted by its caller, so calling jobs that still grant the previous level fail GitHub's workflow validation at startup \u2014 before any job runs. Update the \`permissions:\` block on every job that calls this workflow **before** upgrading. See the [PR review setup docs](${SETUP_DOCS_URL}) for the full recommended block.`
  ].join("\n");
}
function generateCallerPermissionsWarning(previousPath2, currentPath2) {
  const currentSource = readFileSync(currentPath2, "utf-8");
  let previousSource;
  try {
    previousSource = readFileSync(previousPath2, "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") {
      process.stderr.write(`\u2139\uFE0F  No previous workflow at ${previousPath2} \u2014 nothing to compare
`);
      return "";
    }
    throw err;
  }
  const previous = computeCallerRequirement(parseWorkflowPermissions(previousSource));
  const current = computeCallerRequirement(parseWorkflowPermissions(currentSource));
  const increases = diffCallerRequirements(previous, current);
  if (increases.length === 0) {
    process.stderr.write("\u2705 No caller-facing permission increases\n");
    return "";
  }
  for (const inc of increases) {
    process.stderr.write(`\u26A0\uFE0F  Caller permission increased: ${inc.scope}: ${inc.from} \u2192 ${inc.to}
`);
  }
  return renderBreakingChangeWarning(increases);
}

// src/caller-permissions/index.ts
var [, , previousPath, currentPath] = process.argv;
if (!previousPath || !currentPath) {
  process.stderr.write("Usage: caller-permissions <previousWorkflowPath> <currentWorkflowPath>\n");
  process.exit(1);
}
try {
  const warning = generateCallerPermissionsWarning(previousPath, currentPath);
  if (warning !== "") process.stdout.write(`${warning}
`);
} catch (err) {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}
`);
  process.exit(1);
}
