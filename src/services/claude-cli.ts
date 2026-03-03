import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
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

const SLACK_MAX_LENGTH = 3900;

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
}

/**
 * Detect skill patterns like "one:pay-ops-build staging" or "/pay-ops-build staging"
 * in user text, load the SKILL.md, and return context for injection.
 */
export function detectAndLoadSkill(text: string): SkillContext | null {
  // Match "one:<skill-name>" or "/<skill-name>" patterns
  const match = text.match(/(?:one:|(\/))([a-z][a-z0-9-]*)/i);
  if (!match) return null;

  const skillName = match[2];
  const skillDir = path.join(config.skillsDir, skillName);
  const skillPath = path.join(skillDir, "SKILL.md");

  try {
    const skillContent = readFileSync(skillPath, "utf-8");
    // Extract args: everything after the matched skill pattern
    const fullMatch = match[0];
    const afterSkill = text.slice(text.indexOf(fullMatch) + fullMatch.length).trim();
    console.log(`[ClaudeCLI] Detected skill "${skillName}" (args: "${afterSkill || "(none)"}")`);
    return { skillName, skillContent, skillArgs: afterSkill };
  } catch {
    console.log(`[ClaudeCLI] Skill pattern "${skillName}" found but no SKILL.md at ${skillPath}`);
    return null;
  }
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
function buildSkillPrompt(skillContext: SkillContext, fallbackPrompt: string): string {
  const { skillName, skillContent, skillArgs } = skillContext;
  return (
    `Execute skill "${skillName}" with arguments "${skillArgs}".\n\n` +
    `<skill>\n${skillContent}\n</skill>\n\n` +
    `IMPORTANT: Follow every step in the skill workflow exactly in order. ` +
    `Do NOT skip any step. Many steps have infrastructure prerequisites ` +
    `(SSO login, VPN tunnels via sshuttle, browser authorization) that MUST ` +
    `complete before any API/MCP tool calls.`
  );
}

export function spawnClaudeCli(
  prompt: string,
  cwd: string,
  options?: { signal?: AbortSignal; skillContext?: SkillContext }
): SpawnResult {
  // If skill context is provided, inject full SKILL.md content into the prompt
  const effectivePrompt = options?.skillContext
    ? buildSkillPrompt(options.skillContext, prompt)
    : prompt;

  const args = ["-p", effectivePrompt, "--verbose", "--model", config.alertModel, "--dangerously-skip-permissions", "--output-format", "stream-json"];

  // Append system prompt enforcing strict skill execution
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
      resolve({ exitCode: null, costUsd, response, fullReport, inputTokens, outputTokens });
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
      resolve({ exitCode: code, costUsd, response, fullReport, inputTokens, outputTokens });
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
    ? buildSkillPrompt(options.skillContext, prompt)
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
