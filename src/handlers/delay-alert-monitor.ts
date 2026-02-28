import type { App } from "@slack/bolt";
import { config } from "../config.js";
import {
  startDelayAlertWorkflow,
  handleDelayOwnerFeedback,
  getActiveDelayWorkflow,
  isWorkflowActiveForDag,
} from "../services/delay-alert-workflow.js";
import {
  upsertAlertCounter,
  deleteAlertCounter,
  getAllAlertCounters,
} from "../services/database.js";

/** Map of channel name → channel ID, populated at startup */
const delayChannelIds = new Map<string, string>();

/** Resolve configured delay channel names to IDs via Slack API */
export async function resolveDelayChannels(app: App): Promise<void> {
  const { enabled, disabled } = config.channels.monitorDelay;
  if (enabled.length === 0 && disabled.length === 0) return;

  for (const name of disabled) {
    console.log(`Delay monitor channel #${name} disabled (skipped)`);
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
        delayChannelIds.set(ch.name.toLowerCase(), ch.id);
      }
    }

    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);

  for (const name of enabled) {
    const id = delayChannelIds.get(name.toLowerCase());
    if (id) {
      console.log(`Delay-monitoring #${name} → ${id}`);
    } else {
      console.warn(`Warning: delay monitor channel #${name} not found`);
    }
  }
}

/** Check if a channel is a delay-monitored channel */
function isDelayChannel(channelId: string): boolean {
  for (const id of delayChannelIds.values()) {
    if (id === channelId) return true;
  }
  return false;
}

/** Detect Airflow task alert messages (contain *Task*:, *Dag*:, *Execution Time*:) */
function isAirflowTaskAlert(text: string): boolean {
  return /\*Task\*:/i.test(text) && /\*Dag\*:/i.test(text) && /\*Execution Time\*:/i.test(text);
}

/** Extract Task name and Dag name from Airflow alert text */
function extractTaskInfo(text: string): { taskName: string; dagName: string } | null {
  const taskMatch = text.match(/\*Task\*:\s*(.+)/);
  const dagMatch = text.match(/\*Dag\*:\s*(.+)/);
  if (!taskMatch || !dagMatch) return null;
  return {
    taskName: taskMatch[1].trim(),
    dagName: dagMatch[1].trim(),
  };
}

/** Check if Task name matches any configured pattern */
function matchesTaskPattern(taskName: string): boolean {
  const patterns = config.delayAlertTaskPatterns;
  if (patterns.length === 0) return false;
  const lower = taskName.toLowerCase();
  return patterns.some((p) => lower.includes(p.toLowerCase()));
}

interface AlertCounter {
  dagName: string;
  count: number;
  firstSeenAt: number;
  windowTimer: ReturnType<typeof setTimeout>;
}

const alertCounters = new Map<string, AlertCounter>();

/** Restore persisted alert counters from DB on startup */
export function restoreAlertCounters(): void {
  const rows = getAllAlertCounters();
  const now = Date.now();
  let restored = 0;
  let expired = 0;

  for (const row of rows) {
    if (row.window_expires_at <= now) {
      deleteAlertCounter(row.dag_name);
      expired++;
      continue;
    }

    const remaining = row.window_expires_at - now;
    const timer = setTimeout(() => {
      console.log(`[DelayAlertMonitor] Window expired for Dag: ${row.dag_name}, resetting counter`);
      alertCounters.delete(row.dag_name);
      deleteAlertCounter(row.dag_name);
    }, remaining);

    alertCounters.set(row.dag_name, {
      dagName: row.dag_name,
      count: row.count,
      firstSeenAt: row.first_seen_at,
      windowTimer: timer,
    });
    restored++;
  }

  if (restored > 0 || expired > 0) {
    console.log(`[DelayAlertMonitor] Restored ${restored} counters, expired ${expired}`);
  }
}

/** Register the delay alert monitor as a Slack message handler */
export function registerDelayAlertMonitor(app: App, ownerUserId: string): void {
  app.message(async ({ message }) => {
    const msg = message as unknown as Record<string, unknown>;
    const channelId = msg.channel as string;

    if (!isDelayChannel(channelId)) return;

    const threadTs = msg.thread_ts as string | undefined;
    const messageTs = msg.ts as string;
    const text = (msg.text as string) || "";

    // Thread reply from owner on an active workflow → handle feedback
    if (threadTs && msg.user === ownerUserId && getActiveDelayWorkflow(threadTs)) {
      await handleDelayOwnerFeedback(app, threadTs, text);
      return;
    }

    // Only process top-level messages
    if (threadTs) return;

    // Check if it's an Airflow task alert
    if (!isAirflowTaskAlert(text)) return;

    // Extract task info
    const info = extractTaskInfo(text);
    if (!info) return;

    // Check if task name matches configured patterns
    if (!matchesTaskPattern(info.taskName)) return;

    const { dagName } = info;
    console.log(`[DelayAlertMonitor] Airflow alert for Dag: ${dagName} (Task: ${info.taskName})`);

    // Look up or create counter
    let counter = alertCounters.get(dagName);
    if (!counter) {
      const now = Date.now();
      const windowExpiresAt = now + config.delayAlertWindowMs;
      const timer = setTimeout(() => {
        console.log(`[DelayAlertMonitor] Window expired for Dag: ${dagName}, resetting counter`);
        alertCounters.delete(dagName);
        deleteAlertCounter(dagName);
      }, config.delayAlertWindowMs);

      counter = {
        dagName,
        count: 0,
        firstSeenAt: now,
        windowTimer: timer,
      };
      alertCounters.set(dagName, counter);
    }

    counter.count++;
    upsertAlertCounter(dagName, counter.count, counter.firstSeenAt, counter.firstSeenAt + config.delayAlertWindowMs);
    console.log(
      `[DelayAlertMonitor] Dag: ${dagName} count: ${counter.count}/${config.delayAlertThreshold}`
    );

    // Check threshold
    if (counter.count >= config.delayAlertThreshold) {
      // Guard: don't trigger if workflow already active for this dag
      if (isWorkflowActiveForDag(dagName)) {
        console.log(
          `[DelayAlertMonitor] Workflow already active for Dag: ${dagName}, skipping`
        );
        return;
      }

      // Reset counter
      clearTimeout(counter.windowTimer);
      alertCounters.delete(dagName);
      deleteAlertCounter(dagName);

      console.log(
        `[DelayAlertMonitor] Threshold reached for Dag: ${dagName}, starting workflow`
      );

      await startDelayAlertWorkflow(app, channelId, messageTs, text, dagName);
    }
  });
}
