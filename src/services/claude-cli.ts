import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, existsSync, globSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { getMcpConfigPath } from "./mcp-config.js";

export interface CliRunResult {
  exitCode: number | null;
  costUsd?: number;
  response?: string;
  /** The longest assistant text block (typically the detailed report) */
  fullReport?: string;
  inputTokens?: number;
  outputTokens?: number;
  sessionId?: string;
}

export interface DiscussCliResult {
  exitCode: number | null;
  costUsd?: number;
  response?: string;
  sessionId?: string;
  inputTokens?: number;
  outputTokens?: number;
  numTurns?: number;
}

export interface CompactResult {
  success: boolean;
  inputTokens?: number;
  costUsd?: number;
}

export interface SpawnResult {
  child: ChildProcess;
  done: Promise<CliRunResult>;
}

const SLACK_MAX_LENGTH = 3500;

/** Detect known API error patterns in CLI responses and rewrite them as friendly messages.
 *  Only matches when the response starts with the error pattern (not buried in normal text). */
export function rewriteApiError(response: string): string | null {
  // Only match if the response itself IS an API error (anchored to start, optional whitespace)
  const match = response.match(/^\s*API Error:\s*(\d+)\s*([\s\S]*)/);
  if (!match) return null;

  const statusCode = match[1];
  const body = match[2];

  if (body.includes("Could not process image")) {
    return (
      "The session context contained stale image data that the API could not process. " +
      "Session has been reset — please send your message again."
    );
  }

  // Generic API error fallback
  return `Something went wrong (API error ${statusCode}). Session has been reset — please try again.`;
}

/** Split a long response into Slack-safe chunks, breaking at paragraph/line boundaries */
export function chunkResponse(text: string, maxLength = SLACK_MAX_LENGTH): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n\n", maxLength);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt <= 0) splitAt = maxLength;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, "");
  }
  return chunks;
}

/** Convert standard Markdown to Slack mrkdwn format.
 *  Splits on fenced code blocks — only transforms non-code segments. */
export function markdownToSlackMrkdwn(text: string): string {
  // Split on fenced code blocks (```...```)
  const parts = text.split(/(```[\s\S]*?```)/);
  return parts
    .map((part, i) => {
      // Odd indices are code blocks — leave untouched
      if (i % 2 === 1) return part;
      return convertSegment(part);
    })
    .join("");
}

function convertSegment(text: string): string {
  // 1. Images: ![alt](url) → <url|alt>
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "<$2|$1>");

  // 2. Links: [text](url) → <url|text>
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

  // 3. Headings: ^#{1,6} text → *text* (bold, strip any ** inside)
  text = text.replace(/^#{1,6}\s+(.+)$/gm, (_match, heading: string) => {
    return `*${heading.replace(/\*\*/g, "")}*`;
  });

  // 4. Bold: **text** → *text*
  text = text.replace(/\*\*(.+?)\*\*/g, "*$1*");

  // 5. Strikethrough: ~~text~~ → ~text~
  text = text.replace(/~~(.+?)~~/g, "~$1~");

  // 6. Tables: consecutive |...| lines → wrapped in ``` code block (separator rows removed)
  text = text.replace(
    /(?:^[ \t]*\|.+\|[ \t]*$\n?){2,}/gm,
    (tableBlock: string) => {
      const lines = tableBlock
        .split("\n")
        .filter((line) => line.trim() !== "")
        // Remove separator rows like |---|---|
        .filter((line) => !/^\s*\|[\s:|-]+\|\s*$/.test(line));
      return "```\n" + lines.join("\n") + "\n```\n";
    }
  );

  // 7. Emoji shortcodes: fix common ones Claude generates that Slack doesn't recognize
  text = text.replace(/:green_circle:/g, ":large_green_circle:");
  text = text.replace(/:red_circle:/g, ":red_circle:");
  text = text.replace(/:orange_circle:/g, ":large_orange_circle:");
  text = text.replace(/:yellow_circle:/g, ":large_yellow_circle:");

  return text;
}

const STREAM_LOG_TEXT_LIMIT = 200;

function logStreamContent(tag: string, content: unknown[]): void {
  for (const block of content) {
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") {
      const preview = b.text.length > STREAM_LOG_TEXT_LIMIT
        ? b.text.slice(0, STREAM_LOG_TEXT_LIMIT) + "..."
        : b.text;
      console.log(`[${tag}] text: ${preview}`);
    } else if (b.type === "tool_use" && typeof b.name === "string") {
      console.log(`[${tag}] tool_use: ${b.name}`);
    }
  }
}

export function safeKill(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): boolean {
  try {
    return child.kill(signal);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    console.warn(`[ClaudeCLI] kill failed (${code}), process may already be dead (pid: ${child.pid})`);
    return false;
  }
}

export interface SkillContext {
  skillName: string;
  skillContent: string;
  skillArgs: string;
  skillDir: string;
}

/**
 * Search project-level then user-level plugin cache for a skill's SKILL.md.
 * Returns { skillDir, skillPath } or null if not found.
 */
function resolveSkillPath(skillName: string, cwd: string): { skillDir: string; skillPath: string } | null {
  // 1. Project-level: <cwd>/.claude/skills/<skillName>/SKILL.md
  const projectSkillDir = path.join(cwd, ".claude", "skills", skillName);
  const projectSkillPath = path.join(projectSkillDir, "SKILL.md");
  if (existsSync(projectSkillPath)) {
    return { skillDir: projectSkillDir, skillPath: projectSkillPath };
  }

  // 2. User-level plugin cache: ~/.claude/plugins/cache/*/*/*/skills/<skillName>/SKILL.md
  const cachePattern = path.join(os.homedir(), ".claude", "plugins", "cache", "*", "*", "*", "skills", skillName, "SKILL.md");
  const matches = globSync(cachePattern);
  if (matches.length > 0) {
    const skillPath = matches[0];
    const skillDir = path.dirname(skillPath);
    return { skillDir, skillPath };
  }

  return null;
}

/**
 * Detect skill patterns like "one:pay-ops-build staging" or "skill pay-ops-build staging"
 * in user text, load the SKILL.md, and return context for injection.
 */
export function detectAndLoadSkill(text: string, cwd: string): SkillContext | null {
  // Match "one:<skill-name>" or "skill <skill-name>" patterns
  const match = text.match(/(?:one:|skill\s+)([a-z][a-z0-9-]*)/i);
  if (!match) return null;

  const skillName = match[1];
  const resolved = resolveSkillPath(skillName, cwd);
  if (!resolved) {
    console.log(`[ClaudeCLI] Skill pattern "${skillName}" found but no SKILL.md in project or plugin cache`);
    return null;
  }

  const skillContent = readFileSync(resolved.skillPath, "utf-8");
  // Extract args: everything after the matched skill pattern
  const fullMatch = match[0];
  const afterSkill = text.slice(text.indexOf(fullMatch) + fullMatch.length).trim();
  console.log(`[ClaudeCLI] Detected skill "${skillName}" from ${resolved.skillPath} (args: "${afterSkill || "(none)"}")`);
  return { skillName, skillContent, skillArgs: afterSkill, skillDir: resolved.skillDir };
}

const PROMPT_LOG_LIMIT = 500;

/** Shared system prompt enforcing strict sequential skill execution */
const SKILL_SYSTEM_PROMPT =
  "CRITICAL RULES FOR SKILL EXECUTION:\n" +
  "1. When executing skills, you MUST complete EVERY step in the EXACT sequential order defined in the skill workflow. NEVER skip, reorder, or omit any step.\n" +
  "2. Many skills have infrastructure prerequisites (SSO login, VPN tunnels via sshuttle, browser authorization). These MUST complete before any API/MCP tool calls. If you skip tunnel setup, API calls WILL timeout because servers are behind a VPN.\n" +
  "3. Do not check or use the current git branch unless the skill explicitly instructs you to.\n" +
  "4. If a step fails, report the failure — do NOT skip ahead to later steps.\n" +
  "5. Your final response MUST be the investigation report itself — do NOT follow the report with a brief summary. The report IS the final output.\n" +
  "6. Do NOT post or write messages to Slack. Your job is to investigate and return the report as your final text response. The bot will handle posting the report to the correct Slack thread. You MAY use Slack MCP tools to READ messages and threads for investigation.";

/** Build the effective prompt with full SKILL.md content injected */
function buildSkillPrompt(skillContext: SkillContext, fallbackPrompt: string, cwd: string): string {
  const { skillName, skillContent, skillArgs, skillDir } = skillContext;

  // Recursively load all referenced files and sub-skills
  const ctx: LoadCtx = {
    visitedFiles: new Set(),
    visitedSkills: new Set([skillName]), // mark primary skill as visited
    totalSize: Buffer.byteLength(skillContent, "utf-8"),
  };
  const { refs, subSkills } = loadReferencesRecursive(skillContent, skillDir, cwd, ctx);
  const loaded: LoadedReferences = { primaryRefs: refs, subSkills, totalSize: ctx.totalSize };
  const refsOutput = formatReferences(loaded);

  const refCount = loaded.primaryRefs.length;
  const subCount = loaded.subSkills.length;
  const sizeKB = (loaded.totalSize / 1024).toFixed(1);
  console.log(`[ClaudeCLI] Skill "${skillName}" loaded ${refCount} reference files, ${subCount} sub-skills (total: ${sizeKB}KB)`);

  return (
    `Execute skill "${skillName}" with arguments "${skillArgs}".\n\n` +
    `<skill>\n${skillContent}\n</skill>${refsOutput}\n\n` +
    `IMPORTANT: Follow every step in the skill workflow exactly in order. ` +
    `Do NOT skip any step. Many steps have infrastructure prerequisites ` +
    `(SSO login, VPN tunnels via sshuttle, browser authorization) that MUST ` +
    `complete before any API/MCP tool calls.`
  );
}


// ── Recursive skill reference loading ──────────────────────────────────────

const MAX_SKILL_REFERENCES_SIZE = 512 * 1024; // 512KB

/** File extensions we load from skill references */
const REF_EXT = "md|sql|txt|yaml|yml|json";

/**
 * Extract relative file paths referenced in skill content via 4 patterns:
 *  - `Load: path`
 *  - `` Read `path` ``
 *  - `[text](path)` (non-http markdown links)
 *  - `` `references/...|workflows/...` `` backtick paths
 */
export function extractFileReferences(content: string): string[] {
  const seen = new Set<string>();
  const exts = REF_EXT;

  // 1. Load: directive
  for (const m of content.matchAll(
    new RegExp(`^\\s*Load:\\s*(\\S+\\.(?:${exts}))`, "gm")
  )) {
    seen.add(m[1]);
  }

  // 2. Read `path`
  for (const m of content.matchAll(
    new RegExp(`Read\\s+\`([^\`]+\\.(?:${exts}))\``, "g")
  )) {
    seen.add(m[1]);
  }

  // 3. Markdown link (exclude http(s) URLs)
  for (const m of content.matchAll(
    new RegExp(`\\[[^\\]]+\\]\\((?!https?:\\/\\/)([^)]+\\.(?:${exts}))\\)`, "g")
  )) {
    seen.add(m[1]);
  }

  // 4. Backtick paths starting with references/ or workflows/
  for (const m of content.matchAll(
    new RegExp(`\`((?:references|workflows)\\/[^\`]+\\.(?:${exts}))\``, "g")
  )) {
    seen.add(m[1]);
  }

  return [...seen];
}

interface LoadedReference {
  /** Display path (relative to skill dir) */
  displayPath: string;
  content: string;
}

interface LoadedSubSkill {
  name: string;
  skillContent: string;
  references: LoadedReference[];
}

interface LoadedReferences {
  primaryRefs: LoadedReference[];
  subSkills: LoadedSubSkill[];
  totalSize: number;
}

interface LoadCtx {
  visitedFiles: Set<string>;
  visitedSkills: Set<string>;
  totalSize: number;
}

/**
 * Recursively load file references from skill content and cross-referenced sub-skills.
 * Prevents cycles (visitedFiles / visitedSkills) and enforces a size cap.
 */
function loadReferencesRecursive(
  content: string,
  skillDir: string,
  cwd: string,
  ctx: LoadCtx,
): { refs: LoadedReference[]; subSkills: LoadedSubSkill[] } {
  const refs: LoadedReference[] = [];
  const subSkills: LoadedSubSkill[] = [];

  // ── Load file references ────────────────────────────────────────────────
  const filePaths = extractFileReferences(content);
  for (const relPath of filePaths) {
    if (ctx.totalSize >= MAX_SKILL_REFERENCES_SIZE) break;

    const absPath = path.resolve(skillDir, relPath);

    // Security: reject paths that escape the skill directory
    if (!absPath.startsWith(skillDir + path.sep) && absPath !== skillDir) continue;
    if (ctx.visitedFiles.has(absPath)) continue;
    ctx.visitedFiles.add(absPath);

    if (!existsSync(absPath)) {
      console.log(`[ClaudeCLI] Skill reference not found, skipping: ${relPath}`);
      continue;
    }

    try {
      const fileContent = readFileSync(absPath, "utf-8");
      const size = Buffer.byteLength(fileContent, "utf-8");
      if (ctx.totalSize + size > MAX_SKILL_REFERENCES_SIZE) {
        console.log(`[ClaudeCLI] Skill references size cap reached (${ctx.totalSize} + ${size} > ${MAX_SKILL_REFERENCES_SIZE}), skipping: ${relPath}`);
        break;
      }
      ctx.totalSize += size;
      refs.push({ displayPath: relPath, content: fileContent });

      // Recurse into loaded file for further references
      const nested = loadReferencesRecursive(fileContent, skillDir, cwd, ctx);
      refs.push(...nested.refs);
      subSkills.push(...nested.subSkills);
    } catch (err) {
      console.log(`[ClaudeCLI] Failed to read skill reference ${relPath}: ${(err as Error).message}`);
    }
  }

  // ── Load cross-skill references (Skill(one:xxx)) ───────────────────────
  const skillPattern = /Skill\(one:([a-z][a-z0-9-]*)/gi;
  let skillMatch;
  while ((skillMatch = skillPattern.exec(content)) !== null) {
    if (ctx.totalSize >= MAX_SKILL_REFERENCES_SIZE) break;

    const subName = skillMatch[1];
    if (ctx.visitedSkills.has(subName)) continue;
    ctx.visitedSkills.add(subName);

    const resolved = resolveSkillPath(subName, cwd);
    if (!resolved) {
      console.log(`[ClaudeCLI] Sub-skill "${subName}" not found in project or plugin cache, skipping`);
      continue;
    }

    try {
      const subContent = readFileSync(resolved.skillPath, "utf-8");
      const size = Buffer.byteLength(subContent, "utf-8");
      if (ctx.totalSize + size > MAX_SKILL_REFERENCES_SIZE) {
        console.log(`[ClaudeCLI] Skill references size cap reached, skipping sub-skill: ${subName}`);
        break;
      }
      ctx.totalSize += size;

      // Recurse into sub-skill for its own file references and further sub-skills
      const nested = loadReferencesRecursive(subContent, resolved.skillDir, cwd, ctx);

      subSkills.push({
        name: subName,
        skillContent: subContent,
        references: nested.refs,
      });
      // Propagate any sub-sub-skills discovered during recursion
      subSkills.push(...nested.subSkills);

      console.log(`[ClaudeCLI] Loaded sub-skill reference: ${subName} from ${resolved.skillPath} (${nested.refs.length} refs)`);
    } catch (err) {
      console.log(`[ClaudeCLI] Failed to read sub-skill ${subName}: ${(err as Error).message}`);
    }
  }

  return { refs, subSkills };
}

/** Format loaded references into XML sections for prompt injection */
function formatReferences(loaded: LoadedReferences): string {
  let out = "";

  // Primary skill file references
  if (loaded.primaryRefs.length > 0) {
    out += "\n\n<skill-references>\n";
    for (const ref of loaded.primaryRefs) {
      out += `<reference path="${ref.displayPath}">\n${ref.content}\n</reference>\n`;
    }
    out += "</skill-references>";
  }

  // Sub-skill references
  if (loaded.subSkills.length > 0) {
    out +=
      "\n\n<sub-skill-references>\n" +
      "The following skills are referenced in the workflow above. " +
      "Use their schema knowledge and query patterns when making Athena queries directly.\n\n";

    for (const sub of loaded.subSkills) {
      out += `<skill-reference name="${sub.name}">\n${sub.skillContent}\n</skill-reference>\n`;

      if (sub.references.length > 0) {
        out += `\n<skill-reference-files name="${sub.name}">\n`;
        for (const ref of sub.references) {
          out += `<reference path="${ref.displayPath}">\n${ref.content}\n</reference>\n`;
        }
        out += `</skill-reference-files>\n`;
      }

      out += "\n";
    }

    out += "</sub-skill-references>";
  }

  return out;
}

export function spawnClaudeCli(
  prompt: string,
  cwd: string,
  options?: { signal?: AbortSignal; skillContext?: SkillContext }
): SpawnResult {
  // If skill context is provided, inject full SKILL.md content into the prompt
  const effectivePrompt = options?.skillContext
    ? buildSkillPrompt(options.skillContext, prompt, cwd)
    : prompt;

  const args = ["-p", effectivePrompt, "--verbose", "--model", config.alertModel, "--dangerously-skip-permissions", "--output-format", "stream-json"];

  // Append system prompt enforcing strict skill execution
  let systemPrompt: string | undefined;
  if (options?.skillContext) {
    systemPrompt = SKILL_SYSTEM_PROMPT;
    args.push("--append-system-prompt", systemPrompt);
    // Hard-block Slack write tools — the model can ignore system prompt rules,
    // but --disallowedTools is enforced by the CLI runtime.
    args.push(
      "--disallowedTools",
      "mcp__slack__conversations_add_message",
      "mcp__claude_ai_Slack__slack_post_message",
    );
  }

  const mcpOverride = getMcpConfigPath();
  if (mcpOverride) {
    args.push("--mcp-config", mcpOverride);
  }

  const promptPreview = effectivePrompt.length > PROMPT_LOG_LIMIT ? effectivePrompt.slice(0, PROMPT_LOG_LIMIT) + "..." : effectivePrompt;
  console.log(`[ClaudeCLI] Spawning with prompt: ${promptPreview}`);
  console.log(`[ClaudeCLI] Args: ${JSON.stringify(args.filter(a => a !== effectivePrompt && a !== systemPrompt))}`);
  if (systemPrompt) {
    console.log(`[ClaudeCLI] System prompt: ${systemPrompt.slice(0, 200)}...`);
  }

  const child = spawn(
    "claude",
    args,
    {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      signal: options?.signal,
    }
  );

  const done = new Promise<CliRunResult>((resolve) => {
    let costUsd: number | undefined;
    let response: string | undefined;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let sessionId: string | undefined;
    let assistantText = "";
    let longestAssistantText = "";
    let stdout = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      // Parse newline-delimited JSON for cost info
      const lines = stdout.split("\n");
      stdout = lines.pop() || ""; // keep incomplete last line
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.type === "assistant") {
            // Track token usage from assistant messages
            const usage = obj.message?.usage;
            if (usage) {
              const base = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
              const cacheCreation = typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : 0;
              const cacheRead = typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0;
              inputTokens = base + cacheCreation + cacheRead;
              if (typeof usage.output_tokens === "number") outputTokens = usage.output_tokens;
            }
            if (Array.isArray(obj.message?.content)) {
              logStreamContent("ClaudeCLI", obj.message.content);
              for (const block of obj.message.content) {
                if (block.type === "text" && typeof block.text === "string") {
                  assistantText = block.text;
                  if (block.text.length > longestAssistantText.length) {
                    longestAssistantText = block.text;
                  }
                }
              }
            }
          }
          if (obj.type === "result") {
            if (typeof obj.total_cost_usd === "number") costUsd = obj.total_cost_usd;
            if (typeof obj.session_id === "string") sessionId = obj.session_id;
            if (typeof obj.result === "string" && obj.result) {
              response = obj.result;
            } else if (Array.isArray(obj.result)) {
              const texts = obj.result
                .filter((b: any) => b.type === "text" && typeof b.text === "string")
                .map((b: any) => b.text);
              if (texts.length > 0) response = texts.join("\n");
            }
            if (!response) {
              console.warn(`[ClaudeCLI] result field empty or unexpected type: ${typeof obj.result}`,
                JSON.stringify(obj.result)?.slice(0, 200));
            }
          }
        } catch {
          // not JSON, ignore
        }
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) console.error(`[ClaudeCLI stderr] ${text}`);
    });

    child.on("error", (err) => {
      console.error(`[ClaudeCLI] spawn error:`, err.message);
      const fullReport = longestAssistantText || undefined;
      resolve({ exitCode: null, costUsd, response, fullReport, inputTokens, outputTokens, sessionId });
    });

    child.on("close", (code) => {
      if (!response && assistantText) {
        console.log(`[ClaudeCLI] Using assistant text fallback (${assistantText.length} chars)`);
        response = assistantText;
      }
      const fullReport = longestAssistantText || undefined;
      if (fullReport) {
        console.log(`[ClaudeCLI] Longest assistant text: ${fullReport.length} chars`);
      }
      if (costUsd !== undefined) {
        console.log(`[ClaudeCLI] Done. Cost: $${costUsd.toFixed(4)}`);
      }
      resolve({ exitCode: code, costUsd, response, fullReport, inputTokens, outputTokens, sessionId });
    });
  });

  return { child, done };
}

export function spawnDiscussCli(
  prompt: string,
  cwd: string,
  options?: { resumeSessionId?: string; model?: string; signal?: AbortSignal; skillContext?: SkillContext }
): { child: ChildProcess; done: Promise<DiscussCliResult> } {
  // If skill context is provided, inject full SKILL.md content into the prompt
  const effectivePrompt = options?.skillContext
    ? buildSkillPrompt(options.skillContext, prompt, cwd)
    : prompt;

  const args: string[] = [];

  if (options?.resumeSessionId) {
    args.push("--resume", options.resumeSessionId);
  }

  args.push(
    "-p", effectivePrompt,
    "--verbose",
    "--model", options?.model || config.alertModel,
    "--dangerously-skip-permissions",
    "--output-format", "stream-json"
  );

  let systemPrompt: string | undefined;
  if (options?.skillContext) {
    systemPrompt = SKILL_SYSTEM_PROMPT;
    args.push("--append-system-prompt", systemPrompt);
  }

  const mcpOverride = getMcpConfigPath();
  if (mcpOverride) {
    args.push("--mcp-config", mcpOverride);
  }

  const promptPreview = effectivePrompt.length > PROMPT_LOG_LIMIT ? effectivePrompt.slice(0, PROMPT_LOG_LIMIT) + "..." : effectivePrompt;
  console.log(`[DiscussCLI] Spawning with prompt: ${promptPreview}`);
  console.log(`[DiscussCLI] Args: ${JSON.stringify(args.filter(a => a !== effectivePrompt && a !== systemPrompt))}`);
  if (systemPrompt) {
    console.log(`[DiscussCLI] System prompt: ${systemPrompt.slice(0, 200)}...`);
  }

  const child = spawn("claude", args, {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    signal: options?.signal,
  });

  const done = new Promise<DiscussCliResult>((resolve) => {
    let costUsd: number | undefined;
    let response: string | undefined;
    let sessionId: string | undefined;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let numTurns: number | undefined;
    let assistantText = "";
    let stdout = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const lines = stdout.split("\n");
      stdout = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.type === "assistant") {
            // Track token usage from assistant messages (last one = current context size)
            // With prompt caching, total context = input_tokens + cache_creation + cache_read
            const usage = obj.message?.usage;
            if (usage) {
              const base = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
              const cacheCreation = typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : 0;
              const cacheRead = typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0;
              inputTokens = base + cacheCreation + cacheRead;
              if (typeof usage.output_tokens === "number") outputTokens = usage.output_tokens;
            }
            // Track assistant text as fallback for empty result field
            if (Array.isArray(obj.message?.content)) {
              logStreamContent("DiscussCLI", obj.message.content);
              for (const block of obj.message.content) {
                if (block.type === "text" && typeof block.text === "string") {
                  assistantText = block.text;
                }
              }
            }
          }
          if (obj.type === "result") {
            if (typeof obj.total_cost_usd === "number") costUsd = obj.total_cost_usd;
            if (typeof obj.result === "string" && obj.result) {
              response = obj.result;
            } else if (Array.isArray(obj.result)) {
              const texts = obj.result
                .filter((b: any) => b.type === "text" && typeof b.text === "string")
                .map((b: any) => b.text);
              if (texts.length > 0) response = texts.join("\n");
            }
            if (typeof obj.session_id === "string") sessionId = obj.session_id;
            if (typeof obj.num_turns === "number") numTurns = obj.num_turns;
            if (!response) {
              console.warn(`[DiscussCLI] result field empty or unexpected type: ${typeof obj.result}`,
                JSON.stringify(obj.result)?.slice(0, 200));
            }
          }
        } catch {
          // not JSON, ignore
        }
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) console.error(`[DiscussCLI stderr] ${text}`);
    });

    child.on("error", (err) => {
      console.error(`[DiscussCLI] spawn error:`, err.message);
      resolve({ exitCode: null, costUsd, response, sessionId, inputTokens, outputTokens, numTurns });
    });

    child.on("close", (code) => {
      if (!response && assistantText) {
        console.log(`[DiscussCLI] Using assistant text fallback (${assistantText.length} chars)`);
        response = assistantText;
      }
      if (costUsd !== undefined) {
        console.log(`[DiscussCLI] Done. Cost: $${costUsd.toFixed(4)}`);
      }
      resolve({ exitCode: code, costUsd, response, sessionId, inputTokens, outputTokens, numTurns });
    });
  });

  return { child, done };
}

/**
 * Compact a CLI session by piping /compact to interactive mode.
 * The CLI compacts the session in-place (same session ID, smaller context).
 * stdin: write "/compact\n" then close — CLI processes compact, then exits on EOF.
 */
export function compactCliSession(
  sessionId: string,
  cwd: string,
  options?: { model?: string }
): { child: ChildProcess; done: Promise<CompactResult> } {
  const args = [
    "--resume", sessionId,
    "--output-format", "stream-json",
    "--model", options?.model || config.alertModel,
    "--dangerously-skip-permissions",
  ];

  const mcpOverride = getMcpConfigPath();
  if (mcpOverride) {
    args.push("--mcp-config", mcpOverride);
  }

  const child = spawn("claude", args, {
    cwd,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Send /compact then close stdin — CLI will process compact, then exit on EOF
  child.stdin?.write("/compact\n");
  child.stdin?.end();

  const done = new Promise<CompactResult>((resolve) => {
    let inputTokens: number | undefined;
    let costUsd: number | undefined;
    let stdout = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const lines = stdout.split("\n");
      stdout = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.type === "assistant") {
            if (Array.isArray(obj.message?.content)) {
              logStreamContent("DiscussCLI compact", obj.message.content);
            }
            const usage = obj.message?.usage;
            if (usage) {
              const base = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
              const cacheCreation = typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : 0;
              const cacheRead = typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0;
              inputTokens = base + cacheCreation + cacheRead;
            }
          }
          if (obj.type === "result") {
            if (typeof obj.total_cost_usd === "number") costUsd = obj.total_cost_usd;
          }
        } catch {}
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) console.error(`[DiscussCLI compact stderr] ${text}`);
    });

    child.on("close", (code) => {
      console.log(`[DiscussCLI] Compact done (exit: ${code})`);
      resolve({ success: code === 0, inputTokens, costUsd });
    });

    child.on("error", (err) => {
      console.error(`[DiscussCLI] compact error:`, err.message);
      resolve({ success: false });
    });
  });

  // Safety timeout: kill if compact takes too long (2 min)
  const timeout = setTimeout(() => {
    safeKill(child);
  }, 120_000);
  done.then(() => clearTimeout(timeout));

  return { child, done };
}
