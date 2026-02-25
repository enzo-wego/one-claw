import type { App } from "@slack/bolt";
import {
  getActiveSession,
  getSessionById,
  createSession,
  archiveSession,
  activateSession,
  saveMessage,
  getMessages,
} from "../services/database.js";
import { isProcessing, lock, unlock } from "../services/session.js";
import { askAgent } from "../services/agent.js";
import { config } from "../config.js";
import { isDiscussChannel } from "./discuss-monitor.js";

function stripMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, "").trim();
}

async function handleCommand(
  app: App,
  channelId: string,
  sessionKey: string,
  text: string,
  replyThreadTs?: string
): Promise<boolean> {
  const threadOpts = replyThreadTs ? { thread_ts: replyThreadTs } : {};
  const lower = text.toLowerCase();

  if (lower === "!new") {
    archiveSession(sessionKey);
    await app.client.chat.postMessage({
      channel: channelId,
      ...threadOpts,
      text: "Session archived. Send a message to start a new conversation.",
    });
    return true;
  }

  if (lower.startsWith("!resume ")) {
    const targetId = text.slice(8).trim();
    const target = getSessionById(targetId);
    if (!target) {
      await app.client.chat.postMessage({
        channel: channelId,
        ...threadOpts,
        text: `Session \`${targetId}\` not found.`,
      });
      return true;
    }
    if (target.thread_ts) {
      await app.client.chat.postMessage({
        channel: channelId,
        ...threadOpts,
        text: `Session \`${targetId}\` is already active.`,
      });
      return true;
    }
    // Archive current, activate target
    archiveSession(sessionKey);
    activateSession(targetId, sessionKey);
    const msgs = getMessages(targetId);
    await app.client.chat.postMessage({
      channel: channelId,
      ...threadOpts,
      text: `Resumed session \`${targetId}\` (${msgs.length} messages). Continue the conversation.`,
    });
    return true;
  }

  return false;
}

async function handleMessage(
  app: App,
  channelId: string,
  sessionKey: string,
  messageTs: string,
  userId: string,
  rawText: string,
  replyThreadTs?: string
): Promise<void> {
  const text = stripMention(rawText);
  if (!text) return;

  const threadOpts = replyThreadTs ? { thread_ts: replyThreadTs } : {};

  // Handle commands
  if (await handleCommand(app, channelId, sessionKey, text, replyThreadTs)) return;

  // Check processing lock
  if (isProcessing(sessionKey)) {
    await app.client.chat.postMessage({
      channel: channelId,
      ...threadOpts,
      text: "Still thinking on your previous message... hang tight.",
    });
    return;
  }

  // Ensure session exists, lock it
  let session = getActiveSession(sessionKey);
  if (!session) {
    session = createSession(sessionKey, channelId, userId);
  }
  lock(session.session_id);

  // Post thinking indicator
  const thinking = await app.client.chat.postMessage({
    channel: channelId,
    ...threadOpts,
    text: "Thinking...",
  });

  try {
    // Save user message
    saveMessage(session.session_id, messageTs, userId, "user", text);

    const history = getMessages(session.session_id);
    const response = await askAgent(text, history, config.agentModel);

    // Update thinking indicator with actual response
    if (thinking.ts) {
      await app.client.chat.update({
        channel: channelId,
        ts: thinking.ts,
        text: response,
      });
      saveMessage(session.session_id, thinking.ts, "bot", "assistant", response);
    }
  } catch (err) {
    console.error("Error handling message:", err);

    if (thinking.ts) {
      await app.client.chat.update({
        channel: channelId,
        ts: thinking.ts,
        text: "Sorry, something went wrong. Please try again.",
      }).catch(() => {});
    }
  } finally {
    unlock(session.session_id);
  }
}

export function registerHandlers(
  app: App,
  botUserId: string,
  ownerUserId: string
): void {
  app.message(async ({ message }) => {
    const msg = message as Record<string, any>;

    // Ignore bot's own messages, subtypes (edits, joins, etc.)
    if (msg.bot_id || msg.user === botUserId) return;
    if (msg.subtype) return;

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

    // Skip discuss channels — handled by discuss-monitor
    if (!isDm && isDiscussChannel(msg.channel)) return;

    // Owner: always respond
    if (isDm) {
      const replyThreadTs = msg.thread_ts as string | undefined;
      await handleMessage(app, msg.channel, msg.channel, msg.ts, userId, text, replyThreadTs);
    } else {
      const threadTs = (msg.thread_ts || msg.ts) as string;
      await handleMessage(app, msg.channel, threadTs, msg.ts, userId, text, threadTs);
    }
  });
}
