import type { App } from "@slack/bolt";
import type { ChildProcess } from "node:child_process";
import { config } from "../config.js";
import {
  spawnDiscussCli,
  compactCliSession,
  type DiscussCliResult,
} from "./claude-cli.js";

const SLACK_MAX_LENGTH = 39000;
const CONTEXT_WARN_TOKENS = 150_000;
const CONTEXT_MAX_TOKENS = 200_000;

interface ActiveDiscussion {
  channelId: string;
  threadTs: string;
  cliSessionId: string | null;
  cliChild: ChildProcess | null;
  isProcessing: boolean;
}

const discussions = new Map<string, ActiveDiscussion>();

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return `${n}`;
}

function buildUsageFooter(result: DiscussCliResult): string {
  const parts: string[] = [];

  if (result.inputTokens != null) {
    const pct = Math.round((result.inputTokens / CONTEXT_MAX_TOKENS) * 100);
    parts.push(`context: ${formatTokens(result.inputTokens)} (${pct}%)`);
  }

  if (result.costUsd != null) {
    parts.push(`cost: $${result.costUsd.toFixed(4)}`);
  }

  if (result.numTurns != null) {
    parts.push(`turns: ${result.numTurns}`);
  }

  if (parts.length === 0) return "";

  let footer = `\n\n---\n_${parts.join(" | ")}_`;

  if (result.inputTokens != null && result.inputTokens >= CONTEXT_WARN_TOKENS) {
    footer += `\n_context getting full — use \`!compact\` to reset_`;
  }

  return footer;
}

function truncateResponse(text: string): string {
  if (text.length <= SLACK_MAX_LENGTH) return text;
  return text.slice(0, SLACK_MAX_LENGTH) + "\n\n... (truncated)";
}

function stripMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, "").trim();
}

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min === 0) return `${sec}s`;
  return `${min}m ${sec}s`;
}

async function runDiscussCliWithHeartbeat(
  app: App,
  discussion: ActiveDiscussion,
  threadTs: string,
  thinkingTs: string | undefined,
  child: ChildProcess,
  done: Promise<DiscussCliResult>
): Promise<void> {
  const startTime = Date.now();

  // Heartbeat: update "Thinking..." with elapsed time
  const heartbeatInterval = thinkingTs
    ? setInterval(async () => {
        const elapsed = formatElapsed(Date.now() - startTime);
        try {
          await app.client.chat.update({
            channel: discussion.channelId,
            ts: thinkingTs,
            text: `Thinking... (${elapsed})`,
          });
        } catch {}
      }, config.discussHeartbeatIntervalMs)
    : null;

  // Timeout: kill CLI if it runs too long
  let timedOut = false;
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, config.discussCliTimeoutMs);

  try {
    const result = await done;

    discussion.cliChild = null;
    discussion.isProcessing = false;

    if (result.sessionId) {
      discussion.cliSessionId = result.sessionId;
    }

    let displayText: string;
    if (timedOut) {
      const mins = Math.round(config.discussCliTimeoutMs / 60000);
      displayText = `CLI session timed out after ${mins} minutes. Use \`!exit\` and try again.`;
      console.log(`[Discuss] CLI timed out for thread ${threadTs} after ${mins}m`);
    } else if (result.exitCode !== 0 && !result.response) {
      displayText = `CLI exited with error (code: ${result.exitCode}). Use \`!exit\` and try again.`;
      console.log(`[Discuss] CLI error for thread ${threadTs} (exit: ${result.exitCode})`);
    } else {
      const response = result.response || "No response from Claude CLI.";
      displayText = truncateResponse(response + buildUsageFooter(result));
      console.log(
        `[Discuss] CLI done for thread ${threadTs} ` +
          `(exit: ${result.exitCode}, session: ${result.sessionId || "none"})`
      );
    }

    try {
      if (thinkingTs) {
        await app.client.chat.update({
          channel: discussion.channelId,
          ts: thinkingTs,
          text: displayText,
        });
      } else {
        await app.client.chat.postMessage({
          channel: discussion.channelId,
          thread_ts: threadTs,
          text: displayText,
        });
      }
    } catch (err) {
      console.error(`[Discuss] Failed to post response:`, err);
    }
  } finally {
    clearTimeout(timeoutTimer);
    if (heartbeatInterval) clearInterval(heartbeatInterval);
  }
}

export async function startDiscussSession(
  app: App,
  channelId: string,
  messageTs: string,
  text: string
): Promise<void> {
  if (discussions.has(messageTs)) return;

  const cleanText = stripMention(text);
  if (!cleanText) return;

  const discussion: ActiveDiscussion = {
    channelId,
    threadTs: messageTs,
    cliSessionId: null,
    cliChild: null,
    isProcessing: true,
  };
  discussions.set(messageTs, discussion);

  console.log(`[Discuss] New session in ${channelId}, thread ${messageTs}`);

  let thinkingTs: string | undefined;
  try {
    const res = await app.client.chat.postMessage({
      channel: channelId,
      thread_ts: messageTs,
      text: "Thinking...",
    });
    thinkingTs = res.ts || undefined;
  } catch (err) {
    console.error(`[Discuss] Failed to post thinking indicator:`, err);
  }

  const { child, done } = spawnDiscussCli(cleanText, config.paymentsRepoPath, {
    model: config.discussModel,
  });
  discussion.cliChild = child;

  // Fire-and-forget: heartbeat + timeout + response handling
  runDiscussCliWithHeartbeat(app, discussion, messageTs, thinkingTs, child, done);
}

export async function handleDiscussReply(
  app: App,
  threadTs: string,
  text: string
): Promise<void> {
  const discussion = discussions.get(threadTs);
  if (!discussion) return;

  const cleanText = stripMention(text);
  if (!cleanText) return;

  if (discussion.isProcessing) {
    try {
      await app.client.chat.postMessage({
        channel: discussion.channelId,
        thread_ts: threadTs,
        text: "Still thinking on your previous message... hang tight.",
      });
    } catch {}
    return;
  }

  if (!discussion.cliSessionId) {
    try {
      await app.client.chat.postMessage({
        channel: discussion.channelId,
        thread_ts: threadTs,
        text: "No active CLI session. Start a new conversation with a top-level message.",
      });
    } catch {}
    return;
  }

  discussion.isProcessing = true;

  console.log(`[Discuss] Follow-up in thread ${threadTs}`);

  let thinkingTs: string | undefined;
  try {
    const res = await app.client.chat.postMessage({
      channel: discussion.channelId,
      thread_ts: threadTs,
      text: "Thinking...",
    });
    thinkingTs = res.ts || undefined;
  } catch {}

  const { child, done } = spawnDiscussCli(cleanText, config.paymentsRepoPath, {
    model: config.discussModel,
    resumeSessionId: discussion.cliSessionId,
  });
  discussion.cliChild = child;

  // Fire-and-forget: heartbeat + timeout + response handling
  runDiscussCliWithHeartbeat(app, discussion, threadTs, thinkingTs, child, done);
}

export async function handleDiscussCompact(
  app: App,
  threadTs: string
): Promise<void> {
  const discussion = discussions.get(threadTs);
  if (!discussion) return;

  if (discussion.isProcessing) {
    try {
      await app.client.chat.postMessage({
        channel: discussion.channelId,
        thread_ts: threadTs,
        text: "Can't compact while still processing. Wait for the current response.",
      });
    } catch {}
    return;
  }

  if (!discussion.cliSessionId) {
    try {
      await app.client.chat.postMessage({
        channel: discussion.channelId,
        thread_ts: threadTs,
        text: "No active session to compact.",
      });
    } catch {}
    return;
  }

  discussion.isProcessing = true;

  console.log(`[Discuss] Compacting session ${discussion.cliSessionId} for thread ${threadTs}`);

  let thinkingTs: string | undefined;
  try {
    const res = await app.client.chat.postMessage({
      channel: discussion.channelId,
      thread_ts: threadTs,
      text: "Compacting...",
    });
    thinkingTs = res.ts || undefined;
  } catch {}

  // Real /compact — pipes the command to the CLI's interactive stdin.
  // Compacts the session in-place (same session ID, smaller context).
  const { child, done } = compactCliSession(
    discussion.cliSessionId,
    config.paymentsRepoPath,
    { model: config.discussModel }
  );
  discussion.cliChild = child;

  const result = await done;
  discussion.cliChild = null;
  discussion.isProcessing = false;

  let message: string;
  if (result.success) {
    const parts = ["Session compacted."];
    if (result.inputTokens != null) {
      const pct = Math.round((result.inputTokens / CONTEXT_MAX_TOKENS) * 100);
      parts.push(`Context now: ${formatTokens(result.inputTokens)} (${pct}%)`);
    }
    if (result.costUsd != null) {
      parts.push(`Cost: $${result.costUsd.toFixed(4)}`);
    }
    message = parts.join(" | ");
  } else {
    message = "Compact failed. You can use `!exit` to end the session and start fresh.";
  }

  try {
    if (thinkingTs) {
      await app.client.chat.update({
        channel: discussion.channelId,
        ts: thinkingTs,
        text: message,
      });
    } else {
      await app.client.chat.postMessage({
        channel: discussion.channelId,
        thread_ts: threadTs,
        text: message,
      });
    }
  } catch {}
}

export async function handleDiscussExit(
  app: App,
  threadTs: string
): Promise<void> {
  const discussion = discussions.get(threadTs);
  if (!discussion) return;

  // Kill any running CLI
  if (discussion.cliChild) {
    discussion.cliChild.kill("SIGTERM");
    discussion.cliChild = null;
  }

  discussions.delete(threadTs);

  console.log(`[Discuss] Session ended for thread ${threadTs}`);

  try {
    await app.client.chat.postMessage({
      channel: discussion.channelId,
      thread_ts: threadTs,
      text: "Session ended. Start a new conversation with a top-level message.",
    });
  } catch {}
}

export function getActiveDiscussion(
  threadTs: string
): ActiveDiscussion | undefined {
  return discussions.get(threadTs);
}

export function killAllDiscussWorkflows(): void {
  let killed = 0;
  for (const [key, discussion] of discussions) {
    if (discussion.cliChild) {
      discussion.cliChild.kill("SIGTERM");
      discussion.cliChild = null;
      killed++;
    }
    discussions.delete(key);
  }
  if (killed > 0) {
    console.log(`[Discuss] Killed ${killed} active discussions`);
  }
}
