import { spawn, type ChildProcess } from "node:child_process";
import { config } from "../config.js";
import { getMcpConfigPath } from "./mcp-config.js";

export interface CliRunResult {
  exitCode: number | null;
  costUsd?: number;
  response?: string;
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

export function spawnClaudeCli(
  prompt: string,
  cwd: string,
  options?: { signal?: AbortSignal }
): SpawnResult {
  const args = ["-p", prompt, "--verbose", "--model", config.alertModel, "--dangerously-skip-permissions", "--output-format", "stream-json"];

  const mcpOverride = getMcpConfigPath();
  if (mcpOverride) {
    args.push("--mcp-config", mcpOverride);
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
    let assistantText = "";
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
          if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
            for (const block of obj.message.content) {
              if (block.type === "text" && typeof block.text === "string") {
                assistantText = block.text;
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
      resolve({ exitCode: null, costUsd, response });
    });

    child.on("close", (code) => {
      if (!response && assistantText) {
        console.log(`[ClaudeCLI] Using assistant text fallback (${assistantText.length} chars)`);
        response = assistantText;
      }
      if (costUsd !== undefined) {
        console.log(`[ClaudeCLI] Done. Cost: $${costUsd.toFixed(4)}`);
      }
      resolve({ exitCode: code, costUsd, response });
    });
  });

  return { child, done };
}

export function spawnDiscussCli(
  prompt: string,
  cwd: string,
  options?: { resumeSessionId?: string; model?: string; signal?: AbortSignal }
): { child: ChildProcess; done: Promise<DiscussCliResult> } {
  const args: string[] = [];

  if (options?.resumeSessionId) {
    args.push("--resume", options.resumeSessionId);
  }

  args.push(
    "-p", prompt,
    "--verbose",
    "--model", options?.model || config.alertModel,
    "--dangerously-skip-permissions",
    "--output-format", "stream-json"
  );

  const mcpOverride = getMcpConfigPath();
  if (mcpOverride) {
    args.push("--mcp-config", mcpOverride);
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
    child.kill("SIGTERM");
  }, 120_000);
  done.then(() => clearTimeout(timeout));

  return { child, done };
}
