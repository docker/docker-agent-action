import { createRequire } from 'node:module'; var require = createRequire(import.meta.url);

// src/sync-caller-permissions/sync-caller-permissions.ts
import { readFileSync as readFileSync2, writeFileSync } from "fs";

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

// src/sync-caller-permissions/sync-caller-permissions.ts
var REUSABLE_WORKFLOW_REF = "docker/docker-agent-action/.github/workflows/review-pr.yml@";
var LEVEL_RANK2 = { none: 0, read: 1, write: 2 };
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function significantLines2(rawLines) {
  const out = [];
  for (let i = 0; i < rawLines.length; i++) {
    const noCr = rawLines[i].endsWith("\r") ? rawLines[i].slice(0, -1) : rawLines[i];
    const text = noCr.trim();
    if (text === "" || text.startsWith("#")) continue;
    out.push({ indent: noCr.length - noCr.trimStart().length, text, idx: i });
  }
  return out;
}
function stripTrailingComment2(text) {
  return text.replace(/(?:^|\s)#.*$/, "").trim();
}
var KEY_RE2 = /^([A-Za-z_][A-Za-z0-9_-]*):(?:\s+(.*))?$/;
function matchKey2(text) {
  const m = text.match(KEY_RE2);
  if (!m) return null;
  return { key: m[1], rest: stripTrailingComment2(m[2] ?? "") };
}
function parseAccessLevel2(token, lineIdx) {
  const unquoted = token.replace(/^(['"])(.*)\1$/, "$2");
  if (unquoted === "none" || unquoted === "read" || unquoted === "write") return unquoted;
  throw new Error(
    `Unrecognized permission level "${token}" at line ${lineIdx + 1} (expected none, read, or write)`
  );
}
function parseInlineEntries(value, lineIdx) {
  const inner = value.slice(1, -1).trim();
  if (inner === "") return [];
  return inner.split(",").map((part) => {
    const m = part.trim().match(/^(['"]?)([A-Za-z][A-Za-z0-9_-]*)\1:\s*(\S+)$/);
    if (!m) {
      throw new Error(`Malformed inline permissions entry "${part.trim()}" at line ${lineIdx + 1}`);
    }
    return { scope: m[2], level: parseAccessLevel2(m[3], lineIdx) };
  });
}
function parseBlockAt(lines, keyPos, inlineValue, owner) {
  const keyLine = lines[keyPos];
  const base = {
    owner,
    keyLineIdx: keyLine.idx,
    entries: [],
    entryIndent: keyLine.indent + 2
  };
  if (inlineValue !== "") {
    if (inlineValue === "read-all") {
      return {
        block: { ...base, kind: "read-all", map: { [ALL_SCOPES]: "read" } },
        nextPos: keyPos + 1
      };
    }
    if (inlineValue === "write-all") {
      return {
        block: { ...base, kind: "write-all", map: { [ALL_SCOPES]: "write" } },
        nextPos: keyPos + 1
      };
    }
    if (inlineValue.startsWith("{") && inlineValue.endsWith("}")) {
      const map2 = {};
      for (const { scope, level } of parseInlineEntries(inlineValue, keyLine.idx)) {
        map2[scope] = level;
      }
      return { block: { ...base, kind: "inline-map", map: map2 }, nextPos: keyPos + 1 };
    }
    throw new Error(`Unrecognized permissions value "${inlineValue}" at line ${keyLine.idx + 1}`);
  }
  const entries = [];
  const map = {};
  let i = keyPos + 1;
  while (i < lines.length && lines[i].indent > keyLine.indent) {
    const entry = stripTrailingComment2(lines[i].text);
    const m = entry.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(\S+)$/);
    if (!m) {
      throw new Error(
        `Malformed permissions entry at line ${lines[i].idx + 1}: "${lines[i].text}"`
      );
    }
    const level = parseAccessLevel2(m[2], lines[i].idx);
    entries.push({ lineIdx: lines[i].idx, scope: m[1], level });
    map[m[1]] = level;
    i++;
  }
  const entryIndent = entries.length > 0 ? lines[i - entries.length].indent : keyLine.indent + 2;
  return {
    block: { ...base, kind: "block-map", entries, entryIndent, map },
    nextPos: i
  };
}
function scanJobBody(lines, start, jobIndent, job) {
  let i = start;
  let childIndent = -1;
  while (i < lines.length && lines[i].indent > jobIndent) {
    const line = lines[i];
    if (childIndent === -1) childIndent = line.indent;
    if (line.indent === childIndent) {
      const m = matchKey2(line.text);
      if (m?.key === "permissions") {
        const parsed = parseBlockAt(lines, i, m.rest, `job:${job.id}`);
        job.block = parsed.block;
        i = parsed.nextPos;
        continue;
      }
      if (m?.key === "uses" && m.rest.includes(REUSABLE_WORKFLOW_REF)) {
        job.callsReusable = true;
      }
    }
    i++;
  }
  return i;
}
function scanJobs(lines, start, out) {
  let i = start;
  let jobIndent = -1;
  while (i < lines.length && lines[i].indent > 0) {
    const line = lines[i];
    if (jobIndent === -1) jobIndent = line.indent;
    if (line.indent === jobIndent) {
      const m = matchKey2(line.text);
      if (m) {
        const job = { id: m.key, callsReusable: false, block: void 0 };
        out.push(job);
        i = scanJobBody(lines, i + 1, jobIndent, job);
        continue;
      }
    }
    i++;
  }
  return i;
}
function scanConsumer(rawLines) {
  const lines = significantLines2(rawLines);
  let workflowBlock;
  const jobs = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent === 0) {
      const m = matchKey2(line.text);
      if (m?.key === "permissions") {
        const parsed = parseBlockAt(lines, i, m.rest, "workflow");
        workflowBlock = parsed.block;
        i = parsed.nextPos;
        continue;
      }
      if (m?.key === "jobs") {
        i = scanJobs(lines, i + 1, jobs);
        continue;
      }
    }
    i++;
  }
  return { workflowBlock, jobs };
}
function effectiveGrant(map, scope) {
  const direct = map[scope] ?? "none";
  if (scope === ALL_SCOPES) return direct;
  const wildcard = map[ALL_SCOPES] ?? "none";
  return LEVEL_RANK2[direct] >= LEVEL_RANK2[wildcard] ? direct : wildcard;
}
function upgradeEntryLine(line, scope, to) {
  const re = new RegExp(
    `^(\\s*${escapeRegExp(scope)}:\\s*)(['"]?)(?:none|read|write)\\2((?:\\s+#.*)?\\s*)$`
  );
  const m = line.match(re);
  if (!m) return null;
  return `${m[1]}${m[2]}${to}${m[2]}${m[3]}`;
}
function editInlineLine(line, lineIdx, upgrades, additions) {
  const m = line.match(/^(\s*permissions:\s*)(\{[^}]*\})((?:\s+#.*)?\s*)$/);
  if (!m) return null;
  const entries = parseInlineEntries(m[2], lineIdx).map(({ scope, level }) => ({
    scope,
    level: upgrades.get(scope) ?? level
  }));
  entries.push(...additions);
  const inner = entries.map(({ scope, level }) => `${scope}: ${level}`).join(", ");
  return `${m[1]}{${inner}}${m[3]}`;
}
function syncCallerPermissions(source, required) {
  const rawLines = source.split("\n");
  const { workflowBlock, jobs } = scanConsumer(rawLines);
  const callers = jobs.filter((job) => job.callsReusable);
  const applied = [];
  const manual = [];
  const requiredScopes = Object.keys(required).sort();
  if (callers.length === 0 || requiredScopes.length === 0) {
    return { content: source, changed: false, applied, manual };
  }
  const blocks = /* @__PURE__ */ new Map();
  for (const job of callers) {
    const block = job.block ?? workflowBlock;
    if (block === void 0) {
      for (const scope of requiredScopes) {
        manual.push({ block: `job:${job.id}`, scope, from: "unknown", to: required[scope] });
      }
      continue;
    }
    blocks.set(block.keyLineIdx, block);
  }
  const lineEdits = /* @__PURE__ */ new Map();
  const insertions = [];
  for (const block of blocks.values()) {
    const needs = requiredScopes.map((scope) => ({ scope, from: effectiveGrant(block.map, scope), to: required[scope] })).filter(({ from, to }) => LEVEL_RANK2[to] > LEVEL_RANK2[from]);
    if (needs.length === 0) continue;
    if (block.kind === "read-all" || block.kind === "write-all") {
      for (const need of needs) manual.push({ block: block.owner, ...need });
      continue;
    }
    const editable = needs.filter((need) => need.scope !== ALL_SCOPES);
    for (const need of needs) {
      if (need.scope === ALL_SCOPES) manual.push({ block: block.owner, ...need });
    }
    if (block.kind === "inline-map") {
      const upgrades = /* @__PURE__ */ new Map();
      const additions = [];
      for (const need of editable) {
        if (need.scope in block.map) upgrades.set(need.scope, need.to);
        else additions.push({ scope: need.scope, level: need.to });
      }
      const raw = rawLines[block.keyLineIdx];
      const hasCR = raw.endsWith("\r");
      const edited = editInlineLine(
        hasCR ? raw.slice(0, -1) : raw,
        block.keyLineIdx,
        upgrades,
        additions
      );
      if (edited === null) {
        for (const need of editable) manual.push({ block: block.owner, ...need });
        continue;
      }
      lineEdits.set(block.keyLineIdx, hasCR ? `${edited}\r` : edited);
      for (const need of editable) applied.push({ block: block.owner, ...need });
      continue;
    }
    const insertAfter = block.entries.length > 0 ? block.entries[block.entries.length - 1].lineIdx : block.keyLineIdx;
    const anchorHasCR = rawLines[insertAfter].endsWith("\r");
    for (const need of editable) {
      const entry = block.entries.find((e) => e.scope === need.scope);
      if (entry === void 0) {
        const text = `${" ".repeat(block.entryIndent)}${need.scope}: ${need.to}`;
        insertions.push({ afterIdx: insertAfter, text: anchorHasCR ? `${text}\r` : text });
        applied.push({ block: block.owner, ...need });
        continue;
      }
      const raw = rawLines[entry.lineIdx];
      const hasCR = raw.endsWith("\r");
      const edited = upgradeEntryLine(hasCR ? raw.slice(0, -1) : raw, need.scope, need.to);
      if (edited === null) {
        manual.push({ block: block.owner, ...need });
        continue;
      }
      lineEdits.set(entry.lineIdx, hasCR ? `${edited}\r` : edited);
      applied.push({ block: block.owner, ...need });
    }
  }
  const out = [];
  for (let i = 0; i < rawLines.length; i++) {
    out.push(lineEdits.get(i) ?? rawLines[i]);
    for (const ins of insertions) {
      if (ins.afterIdx === i) out.push(ins.text);
    }
  }
  const content = out.join("\n");
  return { content, changed: content !== source, applied, manual };
}
function applySync(reusablePath2, consumerPath2) {
  const required = computeCallerRequirement(
    parseWorkflowPermissions(readFileSync2(reusablePath2, "utf-8"))
  );
  const consumerSource = readFileSync2(consumerPath2, "utf-8");
  const result = syncCallerPermissions(consumerSource, required);
  if (result.changed) {
    writeFileSync(consumerPath2, result.content, "utf-8");
    for (const inc of result.applied) {
      process.stderr.write(
        `\u2705 ${consumerPath2}: ${inc.scope}: ${inc.from} \u2192 ${inc.to} (${inc.block})
`
      );
    }
  } else {
    process.stderr.write(`\u2139\uFE0F  ${consumerPath2}: caller permissions already sufficient
`);
  }
  for (const inc of result.manual) {
    process.stderr.write(
      `\u26A0\uFE0F  ${consumerPath2}: ${inc.scope} needs ${inc.to} but could not be edited (${inc.block}, currently ${inc.from})
`
    );
  }
  return { changed: result.changed, applied: result.applied, manual: result.manual };
}

// src/sync-caller-permissions/index.ts
var args = process.argv.slice(2);
var reusablePath;
var positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--reusable") {
    reusablePath = args[++i];
  } else {
    positional.push(args[i]);
  }
}
var consumerPath = positional[0];
if (!reusablePath || !consumerPath || positional.length > 1) {
  process.stderr.write(
    "Usage: sync-caller-permissions --reusable <reviewPrWorkflowPath> <consumerWorkflowPath>\n"
  );
  process.exit(1);
}
try {
  const result = applySync(reusablePath, consumerPath);
  for (const inc of result.applied) {
    process.stdout.write(`changed ${inc.block} ${inc.scope} ${inc.from} ${inc.to}
`);
  }
  for (const inc of result.manual) {
    process.stdout.write(`manual ${inc.block} ${inc.scope} ${inc.from} ${inc.to}
`);
  }
} catch (err) {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}
`);
  process.exit(1);
}
