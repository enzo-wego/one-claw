import type { App } from "@slack/bolt";
import { config } from "../config.js";
import {
  startAlertWorkflow,
  handleOwnerFeedback,
  getActiveWorkflow,
} from "../services/alert-workflow.js";

/** Map of channel name → channel ID, populated at startup */
const monitorChannelIds = new Map<string, string>();

/** Resolve configured monitor channel names to IDs via Slack API */
export async function resolveMonitorChannels(app: App): Promise<void> {
  const { enabled, disabled } = config.channels.monitor;
  if (enabled.length === 0 && disabled.length === 0) return;

  for (const name of disabled) {
    console.log(`Monitor channel #${name} disabled (skipped)`);
  }

  if (enabled.length === 0) return;

  let cursor: string | undefined;
  const nameSet = new Set(enabled.map((n) => n.toLowerCase()));

  do {
    const res = await app.client.conversations.list({
      types: "public_channel",
      limit: 200,
      cursor,
    });

    for (const ch of res.channels || []) {
      if (ch.name && ch.id && nameSet.has(ch.name.toLowerCase())) {
        monitorChannelIds.set(ch.name.toLowerCase(), ch.id);
      }
    }

    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);

  for (const name of enabled) {
    const id = monitorChannelIds.get(name.toLowerCase());
    if (id) {
      console.log(`Monitoring #${name} → ${id}`);
    } else {
      console.warn(`Warning: monitor channel #${name} not found`);
    }
  }
}

/** Check if a message is from PagerDuty */
function isPagerDutyMessage(msg: Record<string, unknown>): boolean {
  // Check bot profile name
  const botProfile = msg.bot_profile as Record<string, unknown> | undefined;
  if (botProfile) {
    const name = (botProfile.name as string)?.toLowerCase() || "";
    if (name.includes("pagerduty")) return true;
  }

  // Check username
  const username = (msg.username as string)?.toLowerCase() || "";
  if (username.includes("pagerduty")) return true;

  // Check for PD links in text
  const text = (msg.text as string) || "";
  if (/pagerduty\.com\/incidents\//i.test(text)) return true;

  // Check attachments for PD links
  const attachments = msg.attachments as Array<Record<string, unknown>> | undefined;
  if (attachments) {
    for (const att of attachments) {
      for (const field of ["title_link", "fallback", "text", "pretext"]) {
        const val = att[field];
        if (typeof val === "string" && /pagerduty\.com/i.test(val)) {
          return true;
        }
      }
    }
  }

  return false;
}

/** Is the channel one we're monitoring? */
function isMonitoredChannel(channelId: string): boolean {
  for (const id of monitorChannelIds.values()) {
    if (id === channelId) return true;
  }
  return false;
}

/** Register the alert monitor as a Slack message handler */
export function registerAlertMonitor(app: App, ownerUserId: string): void {
  app.message(async ({ message }) => {
    const msg = message as unknown as Record<string, unknown>;
    const channelId = msg.channel as string;

    if (!isMonitoredChannel(channelId)) return;

    const threadTs = msg.thread_ts as string | undefined;
    const messageTs = msg.ts as string;
    const text = (msg.text as string) || "";
    const attachments = msg.attachments as
      | Array<Record<string, unknown>>
      | undefined;

    // Top-level PagerDuty message → start workflow
    if (!threadTs && isPagerDutyMessage(msg)) {
      console.log(`[AlertMonitor] PagerDuty message detected in ${channelId}`);
      await startAlertWorkflow(app, channelId, messageTs, text, attachments);
      return;
    }

    // Thread reply from owner on an active workflow → handle feedback
    if (threadTs && msg.user === ownerUserId && getActiveWorkflow(threadTs)) {
      await handleOwnerFeedback(app, threadTs, text);
    }
  });
}
