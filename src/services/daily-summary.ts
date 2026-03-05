import { config } from "../config.js";
import { spawnDiscussCli } from "./claude-cli.js";
import {
  createPersonalSlackClient,
  fetchChannelMessages,
  formatMessagesForSummary,
} from "./slack-reader.js";

export interface DailySummaryOptions {
  channels: { name: string; id: string }[];
  ownerUserId: string;
  model?: string;
  sendDm: (userId: string, text: string) => Promise<void>;
}

async function summarizeChannel(
  channel: { name: string; id: string },
  model: string
): Promise<string | null> {
  console.log(`[DailySummary] Fetching messages from #${channel.name} (${channel.id})`);

  const client = createPersonalSlackClient();
  const messages = await fetchChannelMessages(client, channel.id, 24);
  console.log(
    `[DailySummary] #${channel.name}: fetched ${messages.length} messages`
  );

  if (messages.length === 0) {
    return `*#${channel.name}*\nNo activity in the last 24 hours.`;
  }

  const formatted = formatMessagesForSummary(messages);

  const now = new Date();
  const dateTimeStr = now.toLocaleString("en-US", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });

  const prompt = `You are a daily summary assistant. The current date and time is: ${dateTimeStr} (GMT+7).

Summarize the following Slack messages from #${channel.name} (last 24 hours).
Include timestamps (HH:MM) for each key event. Include key discussions, decisions, action items, and external links shared.
If any external links (URLs, articles, docs, repos) were shared, include them in a "Resources shared" section or inline.

<messages>
${formatted}
</messages>

Format the summary with clear sections. Use bullet points. Keep it concise but informative.
Start the summary with a heading: *#${channel.name}*

IMPORTANT: Do NOT send any Slack messages. Only return the summary text.`;

  console.log(`[DailySummary] Summarizing #${channel.name} with LLM`);

  const { done } = spawnDiscussCli(prompt, config.paymentsRepoPath, { model });
  const result = await done;

  if (result.costUsd !== undefined) {
    console.log(
      `[DailySummary] #${channel.name} done. Cost: $${result.costUsd.toFixed(4)}`
    );
  }

  if (result.response) {
    console.log(`[DailySummary] Summary ready for #${channel.name}`);
    return result.response;
  }

  console.warn(`[DailySummary] No summary text produced for #${channel.name}`);
  return null;
}

export async function runDailySummary(
  options: DailySummaryOptions
): Promise<void> {
  const { channels, ownerUserId, model = "sonnet", sendDm } = options;

  if (channels.length === 0) {
    console.log("[DailySummary] No channels configured, skipping");
    return;
  }

  console.log(
    `[DailySummary] Starting for ${channels.length} channel(s): ${channels.map((c) => c.name).join(", ")}`
  );

  const summaries: string[] = [];

  for (const channel of channels) {
    try {
      const summary = await summarizeChannel(channel, model);
      if (summary) {
        summaries.push(summary);
      }
    } catch (err) {
      console.error(`[DailySummary] Error summarizing #${channel.name}:`, err);
    }
  }

  if (summaries.length > 0) {
    const combined =
      summaries.join("\n\n---\n\n") +
      `\n\n_Sent using @Claude - model ${model}_`;
    await sendDm(ownerUserId, combined);
    console.log(
      `[DailySummary] Combined DM sent (${summaries.length} channel(s))`
    );
  } else {
    console.warn("[DailySummary] No summaries produced for any channel");
  }

  console.log("[DailySummary] All channels processed");
}
