import type { App } from "@slack/bolt";
import type { ChildProcess } from "node:child_process";
import { config } from "../config.js";
import { acknowledgePagerDutyIncident } from "./pagerduty.js";
import { spawnClaudeCli } from "./claude-cli.js";
import { insertWorkflow, deleteWorkflow, getWorkflowsByType } from "./database.js";

interface ActiveWorkflow {
  channelId: string;
  threadTs: string;
  incidentId: string | null;
  cliChild: ChildProcess | null;
  feedbackTimer: ReturnType<typeof setTimeout> | null;
}

const workflows = new Map<string, ActiveWorkflow>();

/** Extract PagerDuty incident ID from message text or attachment URLs */
function extractIncidentId(
  text: string,
  attachments?: Array<Record<string, unknown>>
): string | null {
  // Check main text
  const match = text.match(/pagerduty\.com\/incidents\/([A-Z0-9]+)/i);
  if (match) return match[1];

  // Check attachments
  if (attachments) {
    for (const att of attachments) {
      for (const field of [
        "title_link",
        "fallback",
        "text",
        "pretext",
      ] as const) {
        const val = att[field];
        if (typeof val === "string") {
          const m = val.match(/pagerduty\.com\/incidents\/([A-Z0-9]+)/i);
          if (m) return m[1];
        }
      }
    }
  }

  return null;
}

/** Build a Slack message permalink */
function buildSlackLink(channelId: string, messageTs: string): string {
  const tsNoDot = messageTs.replace(".", "");
  return `https://${config.slackWorkspaceDomain}/archives/${channelId}/p${tsNoDot}`;
}

/** Start the feedback timeout. On expiry, clean up the workflow. */
function startFeedbackTimer(app: App, workflow: ActiveWorkflow): void {
  clearFeedbackTimer(workflow);
  workflow.feedbackTimer = setTimeout(() => {
    console.log(
      `[AlertWorkflow] Feedback timeout for thread ${workflow.threadTs}, cleaning up`
    );
    cleanupWorkflow(app, workflow);
  }, config.alertFeedbackTimeoutMs);
}

function clearFeedbackTimer(workflow: ActiveWorkflow): void {
  if (workflow.feedbackTimer) {
    clearTimeout(workflow.feedbackTimer);
    workflow.feedbackTimer = null;
  }
}

export async function startAlertWorkflow(
  app: App,
  channelId: string,
  messageTs: string,
  text: string,
  attachments?: Array<Record<string, unknown>>
): Promise<void> {
  if (workflows.has(messageTs)) return; // already handling

  const incidentId = extractIncidentId(text, attachments);
  const slackLink = buildSlackLink(channelId, messageTs);

  const workflow: ActiveWorkflow = {
    channelId,
    threadTs: messageTs,
    incidentId,
    cliChild: null,
    feedbackTimer: null,
  };
  workflows.set(messageTs, workflow);
  insertWorkflow(messageTs, "alert", channelId, { incidentId: incidentId ?? undefined });

  console.log(
    `[AlertWorkflow] Started for thread ${messageTs}` +
      (incidentId ? ` (PD incident: ${incidentId})` : "")
  );

  // 1. Acknowledge PagerDuty incident
  if (incidentId && config.pagerdutyApiToken && config.pagerdutyFromEmail) {
    const ack = await acknowledgePagerDutyIncident(
      incidentId,
      config.pagerdutyApiToken,
      config.pagerdutyFromEmail
    );
    if (ack.success) {
      console.log(`[AlertWorkflow] PD incident ${incidentId} acknowledged`);
    } else {
      console.error(
        `[AlertWorkflow] Failed to ack PD incident ${incidentId}: ${ack.error}`
      );
    }
  }

  // 2. Spawn Claude CLI to investigate
  const prompt = `Invoke skill "${config.alertSkill}" with args "on ${slackLink}". Pre-approved to post report.`;
  const { child, done } = spawnClaudeCli(prompt, config.paymentsRepoPath);
  workflow.cliChild = child;

  // 3. When CLI finishes, start feedback timer
  done.then((result) => {
    workflow.cliChild = null;
    console.log(
      `[AlertWorkflow] CLI finished for thread ${messageTs} (exit: ${result.exitCode})`
    );
    // Only start timer if workflow is still active
    if (workflows.has(messageTs)) {
      startFeedbackTimer(app, workflow);
    }
  });
}

export async function handleOwnerFeedback(
  app: App,
  threadTs: string,
  text: string
): Promise<void> {
  const workflow = workflows.get(threadTs);
  if (!workflow) return;

  console.log(`[AlertWorkflow] Owner feedback on thread ${threadTs}`);

  // Reset timer while we process
  clearFeedbackTimer(workflow);

  // Kill any running CLI before spawning a new one
  if (workflow.cliChild) {
    workflow.cliChild.kill("SIGTERM");
    workflow.cliChild = null;
  }

  // Spawn follow-up CLI
  const slackLink = buildSlackLink(workflow.channelId, threadTs);
  const prompt = `Invoke skill "${config.alertSkill}" with args "on ${slackLink}". Follow-up question from owner: ${text}`;
  const { child, done } = spawnClaudeCli(prompt, config.paymentsRepoPath);
  workflow.cliChild = child;

  done.then((result) => {
    workflow.cliChild = null;
    console.log(
      `[AlertWorkflow] Follow-up CLI finished for thread ${threadTs} (exit: ${result.exitCode})`
    );
    if (workflows.has(threadTs)) {
      startFeedbackTimer(app, workflow);
    }
  });
}

export async function cleanupWorkflow(
  app: App,
  workflow: ActiveWorkflow
): Promise<void> {
  clearFeedbackTimer(workflow);

  // Kill any running CLI
  if (workflow.cliChild) {
    workflow.cliChild.kill("SIGTERM");
    workflow.cliChild = null;
  }

  // Spawn CLI to disconnect VPN
  const prompt = `/${config.alertSkill} off`;
  const { done } = spawnClaudeCli(prompt, config.paymentsRepoPath);
  await done;

  // Post completion message to thread
  try {
    await app.client.chat.postMessage({
      channel: workflow.channelId,
      thread_ts: workflow.threadTs,
      text: "Investigation complete. VPN disconnected.",
    });
  } catch (err) {
    console.error(`[AlertWorkflow] Failed to post cleanup message:`, err);
  }

  workflows.delete(workflow.threadTs);
  deleteWorkflow(workflow.threadTs);
  console.log(`[AlertWorkflow] Cleaned up workflow for thread ${workflow.threadTs}`);
}

export function isAlertWorkflowActive(messageTs: string): boolean {
  return workflows.has(messageTs);
}

export function getActiveWorkflow(threadTs: string): ActiveWorkflow | undefined {
  return workflows.get(threadTs);
}

export function getAllAlertWorkflows(): Array<{
  threadTs: string;
  channelId: string;
  incidentId: string | null;
  hasCliChild: boolean;
}> {
  return Array.from(workflows.entries()).map(([threadTs, w]) => ({
    threadTs,
    channelId: w.channelId,
    incidentId: w.incidentId,
    hasCliChild: w.cliChild !== null,
  }));
}

export function killAlertWorkflow(threadTs: string): boolean {
  const workflow = workflows.get(threadTs);
  if (!workflow) return false;
  clearFeedbackTimer(workflow);
  if (workflow.cliChild) {
    workflow.cliChild.kill("SIGTERM");
    workflow.cliChild = null;
  }
  workflows.delete(threadTs);
  deleteWorkflow(threadTs);
  console.log(`[AlertWorkflow] Killed workflow for thread ${threadTs} via API`);
  return true;
}

export function killAllWorkflows(): void {
  for (const [key, workflow] of workflows) {
    clearFeedbackTimer(workflow);
    if (workflow.cliChild) {
      workflow.cliChild.kill("SIGTERM");
      workflow.cliChild = null;
    }
    deleteWorkflow(key);
    workflows.delete(key);
  }
  if (workflows.size > 0) {
    console.log(`Killed ${workflows.size} active alert workflows`);
  }
}

/** Restore persisted alert workflows from DB on startup */
export function restoreAlertWorkflows(app: App): void {
  const rows = getWorkflowsByType("alert");
  for (const row of rows) {
    const workflow: ActiveWorkflow = {
      channelId: row.channel_id,
      threadTs: row.thread_ts,
      incidentId: row.incident_id,
      cliChild: null,
      feedbackTimer: null,
    };
    workflows.set(row.thread_ts, workflow);
    startFeedbackTimer(app, workflow);
  }
  if (rows.length > 0) {
    console.log(`[AlertWorkflow] Restored ${rows.length} workflows`);
  }
}
