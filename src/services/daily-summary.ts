import { config } from "../config.js";
import { spawnDiscussCli } from "./claude-cli.js";

export interface DailySummaryOptions {
  channels: string[];
  ownerUserId: string;
  model?: string;
  sendDm: (userId: string, text: string) => Promise<void>;
}

async function summarizeChannel(
  channel: string,
  model: string
): Promise<string | null> {
  const dateStr = new Date().toISOString().split("T")[0];

  const prompt = `You are a daily summary assistant. Today is ${dateStr}.

Your task: summarize the last 24 hours of activity from the Slack channel: ${channel}

Steps:
1. Use mcp__slack__conversations_history to read messages from #${channel} with limit "3d" (3 days — compensates for timezone misalignment). Do NOT use conversations_search_messages or channels_list.
2. Filter the results to only include messages from the last 24 hours
3. Compile a concise, well-organized summary
4. Include: key discussions, decisions, action items, and important updates
5. If any external links (URLs, articles, docs, repos) were shared in the channel, include them in the summary so the user can learn from them. Format links clearly, e.g. as a "Resources shared" section or inline with the relevant discussion point.
6. If the channel had no activity in the last 24 hours, note it briefly

Format the summary with clear sections. Use bullet points. Keep it concise but informative.
Start the summary with a heading: *#${channel}*

IMPORTANT: Do NOT send any Slack messages. Do NOT use any Slack send/post/schedule tools. Only read channels and return the summary text as your final response.`;

  console.log(`[DailySummary] Summarizing #${channel}`);

  const { done } = spawnDiscussCli(prompt, config.paymentsRepoPath, { model });
  const result = await done;

  if (result.costUsd !== undefined) {
    console.log(
      `[DailySummary] #${channel} done. Cost: $${result.costUsd.toFixed(4)}`
    );
  }

  if (result.response) {
    console.log(`[DailySummary] Summary ready for #${channel}`);
    return result.response;
  }

  console.warn(`[DailySummary] No summary text produced for #${channel}`);
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
    `[DailySummary] Starting for ${channels.length} channel(s): ${channels.join(", ")}`
  );

  const summaries: string[] = [];

  for (const channel of channels) {
    try {
      const summary = await summarizeChannel(channel, model);
      if (summary) {
        summaries.push(summary);
      }
    } catch (err) {
      console.error(`[DailySummary] Error summarizing #${channel}:`, err);
    }
  }

  if (summaries.length > 0) {
    const combined = summaries.join("\n\n---\n\n")
      + `\n\n_Sent using @Claude - model ${model}_`;
    await sendDm(ownerUserId, combined);
    console.log(`[DailySummary] Combined DM sent (${summaries.length} channel(s))`);
  } else {
    console.warn("[DailySummary] No summaries produced for any channel");
  }

  console.log("[DailySummary] All channels processed");
}
