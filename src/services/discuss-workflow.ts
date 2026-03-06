import type { App } from "@slack/bolt";
import type { ChildProcess } from "node:child_process";
import { config } from "../config.js";
import {
  spawnDiscussCli,
  compactCliSession,
  safeKill,
  chunkResponse,
  markdownToSlackMrkdwn,
  rewriteApiError,
  detectAndLoadSkill,
  type DiscussCliResult,
  type SkillContext,
} from "./claude-cli.js";
import { insertWorkflow, updateWorkflowCliSession, updateWorkflowLastSeenTs, deleteWorkflow, getWorkflowsByType } from "./database.js";

const CONTEXT_WARN_TOKENS = 150_000;
const CONTEXT_MAX_TOKENS = 200_000;

export interface ActiveDiscussion {
  channelId: string;
  threadTs: string;
  cliSessionId: string | null;
  cliChild: ChildProcess | null;
  isProcessing: boolean;
  lastSeenTs: string | null;
}

const discussions = new Map<string, ActiveDiscussion>();

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return `${n}`;
}

function buildUsageFooter(result: DiscussCliResult): string {
  const parts: string[] = [];

  parts.push(`model: ${config.discussModel}`);

  if (result.inputTokens != null) {
    const pct = Math.round((result.inputTokens / CONTEXT_MAX_TOKENS) * 100);
    parts.push(`context: ${formatTokens(result.inputTokens)} (${pct}%)`);
  }

  if (parts.length === 0) return "";

  let footer = `\n\n---\n_${parts.join(" | ")}_`;

  if (result.inputTokens != null && result.inputTokens >= CONTEXT_WARN_TOKENS) {
    footer += `\n_context getting full — use \`!compact\` to reset_`;
  }

  return footer;
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
    safeKill(child);
  }, config.discussCliTimeoutMs);

  try {
    const result = await done;

    discussion.cliChild = null;
    discussion.isProcessing = false;

    // Check for API errors first, before persisting the (potentially corrupted) session ID
    const rawResponse = result.response || "";
    const friendlyError = rawResponse ? rewriteApiError(rawResponse) : null;

    if (friendlyError) {
      // API error detected — do NOT save the corrupted session ID; reset instead
      console.warn(`[Discuss] API error in thread ${threadTs}, resetting session: ${rawResponse.slice(0, 200)}`);
      discussion.cliSessionId = null;
      updateWorkflowCliSession(discussion.threadTs, "");
    } else if (result.sessionId) {
      discussion.cliSessionId = result.sessionId;
      updateWorkflowCliSession(discussion.threadTs, result.sessionId);
    }

    let fullText: string;
    if (timedOut) {
      const mins = Math.round(config.discussCliTimeoutMs / 60000);
      fullText = `CLI session timed out after ${mins} minutes. Use \`!exit\` and try again.`;
      console.log(`[Discuss] CLI timed out for thread ${threadTs} after ${mins}m`);
    } else if (friendlyError) {
      fullText = friendlyError;
    } else if (result.exitCode !== 0 && !result.response) {
      fullText = `CLI exited with error (code: ${result.exitCode}). Use \`!exit\` and try again.`;
      console.log(`[Discuss] CLI error for thread ${threadTs} (exit: ${result.exitCode})`);
    } else {
      const response = rawResponse || "No response from Claude CLI.";
      fullText = markdownToSlackMrkdwn(response) + buildUsageFooter(result);
    }
    console.log(
      `[Discuss] CLI done for thread ${threadTs} ` +
        `(exit: ${result.exitCode}, session: ${discussion.cliSessionId || "none"})`
    );

    try {
      const chunks = chunkResponse(fullText);

      // First chunk: update the "Thinking..." message or post new
      if (thinkingTs) {
        try {
          await app.client.chat.update({
            channel: discussion.channelId,
            ts: thinkingTs,
            text: chunks[0],
          });
        } catch (updateErr: any) {
          if (updateErr?.data?.error === "msg_too_long") {
            console.warn(`[Discuss] msg_too_long on update, truncating (${chunks[0].length} chars)`);
            await app.client.chat.update({
              channel: discussion.channelId,
              ts: thinkingTs,
              text: chunks[0].slice(0, 3800) + "\n\n_(truncated)_",
            });
          } else {
            throw updateErr;
          }
        }
        discussion.lastSeenTs = thinkingTs;
      } else {
        try {
          const posted = await app.client.chat.postMessage({
            channel: discussion.channelId,
            thread_ts: threadTs,
            text: chunks[0],
          });
          if (posted.ts) discussion.lastSeenTs = posted.ts;
        } catch (postErr: any) {
          if (postErr?.data?.error === "msg_too_long") {
            console.warn(`[Discuss] msg_too_long on post, truncating (${chunks[0].length} chars)`);
            const posted = await app.client.chat.postMessage({
              channel: discussion.channelId,
              thread_ts: threadTs,
              text: chunks[0].slice(0, 3800) + "\n\n_(truncated)_",
            });
            if (posted.ts) discussion.lastSeenTs = posted.ts;
          } else {
            throw postErr;
          }
        }
      }

      // Remaining chunks as thread replies
      for (let i = 1; i < chunks.length; i++) {
        try {
          const reply = await app.client.chat.postMessage({
            channel: discussion.channelId,
            thread_ts: threadTs,
            text: chunks[i],
          });
          if (reply.ts) discussion.lastSeenTs = reply.ts;
        } catch (postErr: any) {
          if (postErr?.data?.error === "msg_too_long") {
            console.warn(`[Discuss] msg_too_long on chunk ${i}, truncating (${chunks[i].length} chars)`);
            const reply = await app.client.chat.postMessage({
              channel: discussion.channelId,
              thread_ts: threadTs,
              text: chunks[i].slice(0, 3800) + "\n\n_(truncated)_",
            });
            if (reply.ts) discussion.lastSeenTs = reply.ts;
          } else {
            throw postErr;
          }
        }
      }
    } catch (err) {
      console.error(`[Discuss] Failed to post response:`, err);
      // Last resort: post a short fallback so the user knows something went wrong
      try {
        const fallbackText = fullText.slice(0, 3500) + "\n\n_(response truncated due to posting error)_";
        if (thinkingTs) {
          await app.client.chat.update({
            channel: discussion.channelId,
            ts: thinkingTs,
            text: fallbackText,
          });
        } else {
          await app.client.chat.postMessage({
            channel: discussion.channelId,
            thread_ts: threadTs,
            text: fallbackText,
          });
        }
      } catch {
        // Give up silently — the error is already logged above
      }
    }
  } finally {
    clearTimeout(timeoutTimer);
    if (heartbeatInterval) clearInterval(heartbeatInterval);

    // Persist lastSeenTs to DB so it survives restarts
    if (discussion.lastSeenTs) {
      updateWorkflowLastSeenTs(discussion.threadTs, discussion.lastSeenTs);
    }
  }
}

/** Create a discuss session from a completed alert/delay workflow (no DB insert — caller updates workflow_type) */
export function createDiscussFromWorkflow(
  channelId: string,
  threadTs: string,
  cliSessionId: string,
  lastSeenTs: string | null
): void {
  const discussion: ActiveDiscussion = {
    channelId,
    threadTs,
    cliSessionId,
    cliChild: null,
    isProcessing: false,
    lastSeenTs,
  };
  discussions.set(threadTs, discussion);
  console.log(`[Discuss] Created session from workflow conversion (thread: ${threadTs}, session: ${cliSessionId})`);
}

export async function startDiscussSession(
  app: App,
  channelId: string,
  messageTs: string,
  text: string,
  predetectedSkill?: SkillContext
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
    lastSeenTs: null,
  };
  discussions.set(messageTs, discussion);
  insertWorkflow(messageTs, "discuss", channelId);

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

  // Only use skills explicitly detected from the user's message (not from thread context).
  // Callers pre-detect skills on the user's actual text before calling us.
  const skillContext = predetectedSkill;
  const { child, done } = spawnDiscussCli(cleanText, config.paymentsRepoPath, {
    model: config.discussModel,
    skillContext,
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

  discussion.isProcessing = true;

  // If session was reset (e.g. API error), start fresh with just the user's prompt.
  // Do NOT include thread context or detect skills — thread history may contain
  // skill invocations that would re-execute if passed as a new prompt.
  const isResume = !!discussion.cliSessionId;

  // Detect skills in follow-up messages (the Skill tool doesn't work in CLI subprocess mode,
  // so we inject the SKILL.md content directly into the prompt).
  // Skip skill detection for fresh sessions after reset to avoid re-executing thread skills.
  const skillContext = isResume ? (detectAndLoadSkill(cleanText, config.paymentsRepoPath) ?? undefined) : undefined;

  console.log(`[Discuss] ${isResume ? "Follow-up" : "Fresh session (after reset)"} in thread ${threadTs}`);

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
    resumeSessionId: discussion.cliSessionId || undefined,
    skillContext,
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
    safeKill(discussion.cliChild);
    discussion.cliChild = null;
  }

  discussions.delete(threadTs);
  deleteWorkflow(threadTs);

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

export function getAllDiscussions(): Array<{
  threadTs: string;
  channelId: string;
  cliSessionId: string | null;
  isProcessing: boolean;
  hasCliChild: boolean;
  lastSeenTs: string | null;
}> {
  return Array.from(discussions.entries()).map(([threadTs, d]) => ({
    threadTs,
    channelId: d.channelId,
    cliSessionId: d.cliSessionId,
    isProcessing: d.isProcessing,
    hasCliChild: d.cliChild !== null,
    lastSeenTs: d.lastSeenTs,
  }));
}

export function killDiscussSession(threadTs: string): boolean {
  const discussion = discussions.get(threadTs);
  if (!discussion) return false;
  if (discussion.cliChild) {
    safeKill(discussion.cliChild);
    discussion.cliChild = null;
  }
  discussions.delete(threadTs);
  deleteWorkflow(threadTs);
  console.log(`[Discuss] Killed session for thread ${threadTs} via API`);
  return true;
}

export function killAllDiscussWorkflows(): void {
  let killed = 0;
  for (const [key, discussion] of discussions) {
    if (discussion.cliChild) {
      safeKill(discussion.cliChild);
      discussion.cliChild = null;
      killed++;
    }
    // Don't delete from DB — sessions should survive restarts so follow-ups
    // can resume via --resume instead of re-executing skills from scratch.
    discussions.delete(key);
  }
  if (killed > 0) {
    console.log(`[Discuss] Killed ${killed} active discussions`);
  }
}

/** Restore persisted discuss sessions from DB on startup */
export function restoreDiscussions(): void {
  const rows = getWorkflowsByType("discuss");
  for (const row of rows) {
    const discussion: ActiveDiscussion = {
      channelId: row.channel_id,
      threadTs: row.thread_ts,
      cliSessionId: row.cli_session_id,
      cliChild: null,
      isProcessing: false,
      lastSeenTs: row.last_seen_ts,
    };
    discussions.set(row.thread_ts, discussion);
  }
  if (rows.length > 0) {
    console.log(`[Discuss] Restored ${rows.length} sessions`);
  }
}
