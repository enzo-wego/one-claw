import { query } from "@anthropic-ai/claude-agent-sdk";

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
1. Use the Slack tools to search for and read recent messages from the last 24 hours in #${channel}
2. Compile a concise, well-organized summary
3. Include: key discussions, decisions, action items, and important updates
4. If any external links (URLs, articles, docs, repos) were shared in the channel, include them in the summary so the user can learn from them. Format links clearly, e.g. as a "Resources shared" section or inline with the relevant discussion point.
5. If the channel had no activity, note it briefly

Format the summary with clear sections. Use bullet points. Keep it concise but informative.
Start the summary with a heading: *#${channel}*

IMPORTANT: Do NOT send any Slack messages. Do NOT use any Slack send/post/schedule tools. Only read channels and return the summary text as your final response.`;

  console.log(`[DailySummary] Summarizing #${channel}`);

  let text = "";

  for await (const message of query({
    prompt,
    options: {
      model: model as "sonnet" | "haiku" | "opus",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      maxTurns: 50,
      settingSources: ['user', 'project', 'local'],
      disallowedTools: [
        "mcp__claude_ai_Slack__slack_send_message",
        "mcp__claude_ai_Slack__slack_send_message_draft",
        "mcp__claude_ai_Slack__slack_schedule_message",
      ],
    },
  })) {
    const msg = message as Record<string, unknown>;
    if (msg.type === "assistant") {
      const message = msg.message as Record<string, unknown> | undefined;
      const content = message?.content as Array<Record<string, unknown>> | undefined;
      if (content) {
        for (const block of content) {
          if (block.type === "text" && typeof block.text === "string") {
            text += block.text;
          }
        }
      }
    }
    if (msg.type === "result") {
      const resultText = msg.result as string | undefined;
      if (resultText) {
        text = resultText;
      }
      const cost = msg.total_cost_usd as number | undefined;
      console.log(
        `[DailySummary] #${channel} done. Cost: $${cost?.toFixed(4) ?? "unknown"}`
      );
    }
  }

  if (text) {
    console.log(`[DailySummary] Summary ready for #${channel}`);
    return text;
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
