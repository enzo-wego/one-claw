import { WebClient } from "@slack/web-api";
import { config } from "../config.js";

// Cache user names across calls within the same process
const userNameCache = new Map<string, string>();

export interface SlackMessage {
  ts: string;
  userId: string;
  userName: string;
  text: string;
}

export function createPersonalSlackClient(): WebClient {
  if (!config.slackXoxcToken || !config.slackXoxdToken) {
    throw new Error(
      "[SlackReader] SLACK_XOXC_TOKEN and SLACK_XOXD_TOKEN must be set"
    );
  }
  return new WebClient(config.slackXoxcToken, {
    headers: { cookie: `d=${config.slackXoxdToken}` },
  });
}

export async function fetchChannelMessages(
  client: WebClient,
  channelId: string,
  sinceHours = 24
): Promise<SlackMessage[]> {
  const oldest = String(Date.now() / 1000 - sinceHours * 3600);
  const messages: SlackMessage[] = [];
  let cursor: string | undefined;

  do {
    const resp = await client.conversations.history({
      channel: channelId,
      oldest,
      limit: 200,
      cursor,
    });
    for (const msg of resp.messages || []) {
      if (msg.subtype && msg.subtype !== "file_share") continue;
      if (!msg.ts || !msg.text) continue;
      messages.push({
        ts: msg.ts,
        userId: msg.user || "unknown",
        userName: "",
        text: msg.text,
      });
    }
    cursor = resp.response_metadata?.next_cursor || undefined;
  } while (cursor);

  // Resolve user names (sender names + @mentions in text)
  const senderIds = new Set(messages.map((m) => m.userId));
  const mentionIds = new Set<string>();
  for (const msg of messages) {
    for (const match of msg.text.matchAll(/<@(U[A-Z0-9]+)>/g)) {
      mentionIds.add(match[1]);
    }
  }
  const allUserIds = [...new Set([...senderIds, ...mentionIds])];
  const names = await resolveUserNames(client, allUserIds);

  for (const msg of messages) {
    msg.userName = names.get(msg.userId) || msg.userId;
    // Replace <@U...> mentions in text with display names
    msg.text = msg.text.replace(/<@(U[A-Z0-9]+)>/g, (_, id: string) => {
      const name = names.get(id);
      return name ? `@${name}` : `@${id}`;
    });
  }

  // Sort chronologically (oldest first)
  messages.sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));
  return messages;
}

async function resolveUserNames(
  client: WebClient,
  userIds: string[]
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const toFetch = userIds.filter((id) => {
    if (userNameCache.has(id)) {
      result.set(id, userNameCache.get(id)!);
      return false;
    }
    return true;
  });

  for (const userId of toFetch) {
    try {
      const resp = await client.users.info({ user: userId });
      const name =
        resp.user?.profile?.display_name ||
        resp.user?.real_name ||
        resp.user?.name ||
        userId;
      userNameCache.set(userId, name);
      result.set(userId, name);
    } catch {
      result.set(userId, userId);
    }
  }

  return result;
}

export function formatMessagesForSummary(messages: SlackMessage[]): string {
  return messages
    .map((m) => {
      const date = new Date(parseFloat(m.ts) * 1000);
      // Convert UTC to GMT+7
      const gmt7 = new Date(date.getTime() + 7 * 60 * 60 * 1000);
      const hh = String(gmt7.getUTCHours()).padStart(2, "0");
      const mm = String(gmt7.getUTCMinutes()).padStart(2, "0");
      return `[${hh}:${mm}] ${m.userName}: ${m.text}`;
    })
    .join("\n");
}
