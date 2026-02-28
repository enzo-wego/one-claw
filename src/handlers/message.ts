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
import { queryGemini } from "../services/gemini.js";

// Gemini thread history: threadTs → list of Gemini responses
const geminiThreadHistory = new Map<string, string[]>();

function detectGeminiRequest(text: string): boolean {
  return /\buse\s+gemini\b/i.test(text);
}

const GEMINI_MODEL_MAP: [RegExp, string][] = [
  [/^pro\b/i, "gemini-3.1-pro"],
  [/^3\s*flash\b/i, "gemini-3-flash"],
  [/^2\.?5\s*pro\b/i, "gemini-2.5-pro"],
  [/^2\.?5\s*flash\b/i, "gemini-2.5-flash"],
];

function parseGeminiModel(text: string): { model: string; rest: string } {
  // Get everything after "use gemini"
  const afterGemini = text.replace(/^.*?\buse\s+gemini\s*/i, "");

  for (const [pattern, model] of GEMINI_MODEL_MAP) {
    const match = afterGemini.match(pattern);
    if (match) {
      const rest = afterGemini.slice(match[0].length).replace(/^\s+/, "");
      return { model, rest };
    }
  }

  return { model: "gemini-2.5-flash", rest: afterGemini };
}

function extractGeminiQuery(text: string): string {
  const { rest } = parseGeminiModel(text);
  // Strip leading "to " connector (e.g. "use gemini to check..." → "check...")
  return rest.replace(/^to\s+/i, "").trim();
}

function detectClaudeCodeResume(text: string): boolean {
  return /\buse\s+claude(?:\s+code)?\b/i.test(text);
}

function buildGeminiContext(threadTs: string): string {
  const responses = geminiThreadHistory.get(threadTs);
  if (!responses || responses.length === 0) return "";
  return "Previous Gemini analysis:\n" + responses.join("\n---\n") + "\n\n";
}

function formatGeminiResponse(result: { text: string; sources: { title: string; url: string }[] }, model: string): string {
  let msg = `*Gemini (${model}):*\n${result.text}`;
  if (result.sources.length > 0) {
    msg += "\n\n*Sources:*\n";
    const seen = new Set<string>();
    for (const s of result.sources) {
      if (seen.has(s.url)) continue;
      seen.add(s.url);
      msg += `• <${s.url}|${s.title}>\n`;
    }
  }
  return msg;
}

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

    // Gemini routing: "use gemini ..."
    if (detectGeminiRequest(cleanText)) {
      if (!config.geminiApiKey) {
        await app.client.chat.postMessage({
          channel: msg.channel,
          thread_ts: threadTs,
          text: "Gemini API key is not configured. Please add `GEMINI_API_KEY` to .env or use Claude instead.",
        });
        return;
      }

      const { model } = parseGeminiModel(cleanText);
      const query = extractGeminiQuery(cleanText);
      if (!query) return;

      let indicatorTs: string | undefined;
      try {
        const res = await app.client.chat.postMessage({
          channel: msg.channel,
          thread_ts: threadTs,
          text: `Checking with Gemini (${model})...`,
        });
        indicatorTs = res.ts || undefined;
      } catch (err) {
        console.error("[Gemini] Failed to post indicator:", err);
      }

      const result = await queryGemini(query, model);
      const response = result
        ? formatGeminiResponse(result, model)
        : "Gemini request failed. Please try again.";

      if (indicatorTs) {
        await app.client.chat.update({
          channel: msg.channel,
          ts: indicatorTs,
          text: response,
        }).catch((err: any) => console.error("[Gemini] Failed to update message:", err));
      } else {
        await app.client.chat.postMessage({
          channel: msg.channel,
          thread_ts: threadTs,
          text: response,
        }).catch((err: any) => console.error("[Gemini] Failed to post response:", err));
      }

      // Store response for later Claude context carry-over
      if (result) {
        const existing = geminiThreadHistory.get(threadTs) || [];
        existing.push(`[${model}] ${result.text}`);
        geminiThreadHistory.set(threadTs, existing);
      }

      return;
    }

    // "use claude code" with Gemini history → carry over context
    if (detectClaudeCodeResume(cleanText) && geminiThreadHistory.has(threadTs)) {
      const geminiContext = buildGeminiContext(threadTs);
      const filePrefix = await extractFilePrefix(msg.files as SlackFile[] | undefined);
      const resumeText = cleanText.replace(/\buse\s+claude(?:\s+code)?\s*/i, "").trim();
      const activeForResume = getActiveDiscussion(threadTs);

      if (activeForResume) {
        // Already in a Claude session → send Gemini context as a follow-up reply
        const context = await fetchThreadContext(app, msg.channel, threadTs, activeForResume.lastSeenTs, botUserId);
        const prompt = filePrefix + context + geminiContext + (resumeText || "Continue our task based on the Gemini analysis above.");
        await handleDiscussReply(app, threadTs, prompt);
      } else {
        // No active session → start a new one with Gemini context
        const context = await fetchThreadContext(app, msg.channel, threadTs, null, botUserId);
        const prompt = filePrefix + context + geminiContext + (resumeText || "Continue our task based on the Gemini analysis above.");
        await startDiscussSession(app, msg.channel, threadTs, prompt);
      }
      return;
    }

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
