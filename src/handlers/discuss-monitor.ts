import type { App } from "@slack/bolt";
import { config } from "../config.js";
import {
  startDiscussSession,
  handleDiscussReply,
  handleDiscussCompact,
  handleDiscussExit,
  getActiveDiscussion,
} from "../services/discuss-workflow.js";

/** Map of channel name → channel ID, populated at startup */
const discussChannelIds = new Map<string, string>();

/** Resolve configured discuss channel names to IDs via Slack API */
export async function resolveDiscussChannels(app: App): Promise<void> {
  const channels = config.channels.discuss;
  if (channels.length === 0) return;

  let cursor: string | undefined;
  const nameSet = new Set(channels.map((n) => n.toLowerCase()));

  do {
    const res = await app.client.conversations.list({
      types: "public_channel",
      limit: 200,
      cursor,
    });

    for (const ch of res.channels || []) {
      if (ch.name && ch.id && nameSet.has(ch.name.toLowerCase())) {
        discussChannelIds.set(ch.name.toLowerCase(), ch.id);
      }
    }

    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);

  for (const name of channels) {
    const id = discussChannelIds.get(name.toLowerCase());
    if (id) {
      console.log(`Discuss channel #${name} → ${id}`);
    } else {
      console.warn(`Warning: discuss channel #${name} not found`);
    }
  }
}

/** Check if a channel is a discuss channel */
export function isDiscussChannel(channelId: string): boolean {
  for (const id of discussChannelIds.values()) {
    if (id === channelId) return true;
  }
  return false;
}

/** Register the discuss monitor as a Slack message handler */
export function registerDiscussMonitor(
  app: App,
  ownerUserId: string
): void {
  app.message(async ({ message }) => {
    const msg = message as unknown as Record<string, unknown>;
    const channelId = msg.channel as string;

    if (!isDiscussChannel(channelId)) return;

    // Only respond to owner, skip bot messages and subtypes
    if (msg.user !== ownerUserId) return;
    if (msg.bot_id || msg.subtype) return;

    const threadTs = msg.thread_ts as string | undefined;
    const messageTs = msg.ts as string;
    const text = (msg.text as string) || "";

    if (!text.trim()) return;

    // Top-level message → start new discuss session
    if (!threadTs) {
      await startDiscussSession(app, channelId, messageTs, text);
      return;
    }

    // Thread commands
    if (threadTs && getActiveDiscussion(threadTs)) {
      const cmd = text.trim().toLowerCase();

      if (cmd === "!compact") {
        await handleDiscussCompact(app, threadTs);
        return;
      }

      if (cmd === "!exit") {
        await handleDiscussExit(app, threadTs);
        return;
      }

      // Thread reply on active discussion → follow-up
      await handleDiscussReply(app, threadTs, text);
    }
  });
}
