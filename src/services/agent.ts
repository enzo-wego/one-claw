import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Message } from "./database.js";

export async function askAgent(
  prompt: string,
  history: Message[],
  model: string
): Promise<string> {
  const historyBlock = history
    .map((m) => `[${m.role}]: ${m.content}`)
    .join("\n");

  const fullPrompt = historyBlock
    ? `Here is the conversation so far:\n${historyBlock}\n\nUser's latest message:\n${prompt}\n\nRespond helpfully. At the very end add this footer on its own line:\nSent using @Claude - model ${model}`
    : `${prompt}\n\nRespond helpfully. At the very end add this footer on its own line:\nSent using @Claude - model ${model}`;

  let text = "";

  for await (const message of query({
    prompt: fullPrompt,
    options: {
      model: model as "sonnet" | "haiku" | "opus",
      permissionMode: "bypassPermissions",
      maxTurns: 50,
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
        `[Agent] Done. Cost: $${cost?.toFixed(4) ?? "unknown"}`
      );
    }
  }

  return text || "I wasn't able to generate a response. Please try again.";
}
