import type { App } from "@slack/bolt";
import { config } from "../config.js";
import {
  startDiscussSession,
  handleDiscussReply,
  handleDiscussCompact,
  handleDiscussExit,
  getActiveDiscussion,
} from "../services/discuss-workflow.js";
import { getActiveWorkflow } from "../services/alert-workflow.js";
import { getActiveDelayWorkflow } from "../services/delay-alert-workflow.js";
import { spawnDiscussCli, detectAndLoadSkill } from "../services/claude-cli.js";
import {
  downloadSlackFiles,
  buildFilePromptPrefix,
  type SlackFile,
} from "../services/slack-files.js";

function stripMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, "").trim();
}

async function extractFilePrefix(
  files: SlackFile[] | undefined
): Promise<string> {
  if (!files || files.length === 0) return "";
  const paths = await downloadSlackFiles(files, config.slackBotToken);
  return buildFilePromptPrefix(paths);
}

/**
 * Fetch thread messages since lastSeenTs, formatted as context for Claude.
 * Returns non-bot messages as "<@user>: text" lines.
 */
async function fetchThreadContext(
  app: App,
  channelId: string,
  threadTs: string,
  lastSeenTs: string | null,
  botUserId: string
): Promise<string> {
  try {
    const res = await app.client.conversations.replies({
      channel: channelId,
      ts: threadTs,
      oldest: lastSeenTs || undefined,
    });

    const messages = (res.messages || [])
      .filter((m) => {
        if (m.bot_id || m.user === botUserId) return false;
        if (m.ts === threadTs && !lastSeenTs) return false; // skip root if starting fresh
        if (lastSeenTs && m.ts && m.ts <= lastSeenTs) return false;
        return true;
      })
      .map((m) => `<@${m.user}>: ${m.text || ""}`.trim());

    if (messages.length === 0) return "";
    return "Thread context (messages from other users):\n" + messages.join("\n") + "\n\n";
  } catch (err) {
    console.error("[Message] Failed to fetch thread context:", err);
    return "";
  }
}

/**
 * Handle one-shot DM: spawn CLI, wait for result, post response.
 */
async function handleDm(
  app: App,
  channelId: string,
  text: string,
  files?: SlackFile[]
): Promise<void> {
  const filePrefix = await extractFilePrefix(files);
  const cleanText = stripMention(text);
  if (!cleanText && !filePrefix) return;

  let thinkingTs: string | undefined;
  try {
    const res = await app.client.chat.postMessage({
      channel: channelId,
      text: "Thinking...",
    });
    thinkingTs = res.ts || undefined;
  } catch (err) {
    console.error("[Message] Failed to post thinking indicator:", err);
  }

  try {
    const prompt = filePrefix + cleanText;
    const skillContext = detectAndLoadSkill(cleanText) ?? undefined;
    const { done } = spawnDiscussCli(prompt, config.paymentsRepoPath, {
      model: config.discussModel,
      skillContext,
    });
    const result = await done;

    const response = result.response || "No response from Claude CLI.";

    if (thinkingTs) {
      await app.client.chat.update({
        channel: channelId,
        ts: thinkingTs,
        text: response,
      });
    } else {
      await app.client.chat.postMessage({
        channel: channelId,
        text: response,
      });
    }
  } catch (err) {
    console.error("[Message] DM CLI error:", err);
    if (thinkingTs) {
      await app.client.chat.update({
        channel: channelId,
        ts: thinkingTs,
        text: "Sorry, something went wrong. Please try again.",
      }).catch(() => {});
    }
  }
}

export function registerHandlers(
  app: App,
  botUserId: string,
  ownerUserId: string
): void {
  app.message(async ({ message }) => {
    const raw = message as Record<string, any>;

    // Support edited messages (subtype: message_changed)
    const isEdit = raw.subtype === "message_changed";
    const msg = isEdit ? { ...raw, ...raw.message, channel: raw.channel, channel_type: raw.channel_type } : raw;

    // Ignore bot messages and other subtypes (joins, etc.)
    if (msg.bot_id || msg.user === botUserId) return;
    if (raw.subtype && !isEdit) return;

    // Skip edits for messages that already have an active discuss session
    if (isEdit) {
      const editThreadTs = (msg.thread_ts || msg.ts) as string;
      if (getActiveDiscussion(editThreadTs)) return;
    }

    const isDm = msg.channel_type === "im";
    const text: string = msg.text || "";
    const userId: string = msg.user || "";
    const isOwner = userId === ownerUserId;
    const hasMention = text.includes(`<@${botUserId}>`);

    // Non-owner: only respond if they @mention the bot, with a polite decline
    if (!isOwner) {
      if (hasMention) {
        const threadTs = (msg.thread_ts || msg.ts) as string;
        await app.client.chat.postMessage({
          channel: msg.channel,
          ...(isDm ? {} : { thread_ts: threadTs }),
          text: `To save Claude tokens, I only reply for <@${ownerUserId}>.`,
        });
      }
      return;
    }

    // Owner + DM → one-shot Claude CLI
    if (isDm) {
      await handleDm(app, msg.channel, text, msg.files as SlackFile[] | undefined);
      return;
    }

    // Owner + channel — only respond to @mentions
    if (!hasMention) return;

    const threadTs = (msg.thread_ts || msg.ts) as string;
    const cleanText = stripMention(text);
    if (!cleanText) return;

    // Skip if thread has active alert or delay-alert workflow
    if (getActiveWorkflow(threadTs) || getActiveDelayWorkflow(threadTs)) return;

    // Handle discuss commands
    const cmd = cleanText.toLowerCase();
    const activeDiscussion = getActiveDiscussion(threadTs);

    if (cmd === "!compact" && activeDiscussion) {
      await handleDiscussCompact(app, threadTs);
      return;
    }

    if (cmd === "!exit" && activeDiscussion) {
      await handleDiscussExit(app, threadTs);
      return;
    }

    const filePrefix = await extractFilePrefix(msg.files as SlackFile[] | undefined);

    // Active discussion → follow-up with thread context
    if (activeDiscussion) {
      const context = await fetchThreadContext(
        app,
        msg.channel,
        threadTs,
        activeDiscussion.lastSeenTs,
        botUserId
      );
      const prompt = filePrefix + context + cleanText;
      await handleDiscussReply(app, threadTs, prompt);
      return;
    }

    // No active session → start new discuss session with thread context
    const context = await fetchThreadContext(app, msg.channel, threadTs, null, botUserId);
    const prompt = filePrefix + context + cleanText;
    await startDiscussSession(app, msg.channel, threadTs, prompt);
  });
}
