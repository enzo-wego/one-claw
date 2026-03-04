import type { App } from "@slack/bolt";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { acknowledgePagerDutyIncident, getPagerDutyIncidentStatus } from "./pagerduty.js";
import { spawnClaudeCli, safeKill, detectAndLoadSkill, chunkResponse, markdownToSlackMrkdwn, type CliRunResult } from "./claude-cli.js";
import { insertWorkflow, deleteWorkflow, getWorkflowsByType } from "./database.js";

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return `${n}`;
}

function buildUsageFooter(result: CliRunResult): string {
  const parts: string[] = [];
  parts.push(`model: ${config.alertModel}`);
  if (result.inputTokens != null) {
    const pct = Math.round((result.inputTokens / 200_000) * 100);
    parts.push(`context: ${formatTokens(result.inputTokens)} (${pct}%)`);
  }
  return `\n\n---\n_${parts.join(" | ")}_`;
}

/** Extract the summary (header + section 1) from the full report markdown. */
function extractSummary(text: string): { summary: string; fullReport: string } {
  // Split at the first "---" separator to get just the header + one-liner summary
  const firstSeparator = text.match(/\n---\n/);
  if (firstSeparator?.index != null) {
    return { summary: text.slice(0, firstSeparator.index).trimEnd(), fullReport: text };
  }
  return { summary: text, fullReport: text };
}

/** Save the full investigation report to data/reports/ and return the file path. */
function saveFullReport(threadTs: string, text: string): string | undefined {
  try {
    const reportsDir = path.join("data", "reports");
    mkdirSync(reportsDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filePath = path.join(reportsDir, `${ts}-${threadTs}.md`);
    writeFileSync(filePath, text, "utf-8");
    console.log(`[AlertWorkflow] Full report saved to ${filePath} (${text.length} chars)`);
    return filePath;
  } catch (err) {
    console.error(`[AlertWorkflow] Failed to save report:`, err);
    return undefined;
  }
}

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

/** Check if an incident is already being handled by an active workflow */
function isIncidentAlreadyTracked(incidentId: string): boolean {
  for (const w of workflows.values()) {
    if (w.incidentId === incidentId) return true;
  }
  const dbRows = getWorkflowsByType("alert");
  return dbRows.some(r => r.incident_id === incidentId);
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

  // Prevent feedback loop: skip if this incident is already tracked
  if (incidentId && isIncidentAlreadyTracked(incidentId)) {
    console.log(`[AlertWorkflow] Incident ${incidentId} already tracked, skipping message ${messageTs}`);
    return;
  }

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

  // 1. Acknowledge PagerDuty incident (skip if already acked/resolved)
  if (incidentId && config.pagerdutyApiToken && config.pagerdutyFromEmail) {
    const status = await getPagerDutyIncidentStatus(incidentId, config.pagerdutyApiToken);
    if (status && status !== "triggered") {
      console.log(`[AlertWorkflow] PD incident ${incidentId} already ${status}, skipping ack`);
    } else {
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
  }

  // 2. Load skill content and spawn Claude CLI to investigate
  const skillContext = detectAndLoadSkill(config.alertSkill);
  if (!skillContext) {
    console.error(`[AlertWorkflow] Skill "${config.alertSkill}" not found, aborting workflow`);
    workflows.delete(messageTs);
    deleteWorkflow(messageTs);
    return;
  }
  skillContext.skillArgs = `on ${slackLink}`;

  // 2b. Post "Investigating..." indicator to thread
  let thinkingTs: string | undefined;
  try {
    const res = await app.client.chat.postMessage({
      channel: channelId,
      thread_ts: messageTs,
      text: "Investigating...",
    });
    thinkingTs = res.ts || undefined;
  } catch (err) {
    console.error(`[AlertWorkflow] Failed to post thinking indicator:`, err);
  }

  const prompt = `Invoke skill "${config.alertSkill}" with args "on ${slackLink}".`;
  const { child, done } = spawnClaudeCli(prompt, config.paymentsRepoPath, { skillContext });
  workflow.cliChild = child;

  // 3. When CLI finishes, post response and start feedback timer
  done.then(async (result) => {
    workflow.cliChild = null;
    console.log(
      `[AlertWorkflow] CLI finished for thread ${messageTs} (exit: ${result.exitCode})`
    );

    // Prefer fullReport (detailed investigation) over short result summary
    const rawText = result.fullReport || result.response
      || (result.exitCode !== 0 ? `CLI exited with error (code: ${result.exitCode}).` : "No response from CLI.");

    // Extract summary (header + section 1) for Slack, save full report to file
    const { summary } = extractSummary(rawText);
    const reportPath = saveFullReport(messageTs, rawText);
    const summaryText = markdownToSlackMrkdwn(summary) + buildUsageFooter(result);

    try {
      // Post summary to Slack
      const chunks = chunkResponse(summaryText);

      // First chunk: update the "Investigating..." message or post new
      if (thinkingTs) {
        try {
          await app.client.chat.update({
            channel: channelId,
            ts: thinkingTs,
            text: chunks[0],
          });
        } catch (updateErr: any) {
          if (updateErr?.data?.error === "msg_too_long") {
            console.warn(`[AlertWorkflow] msg_too_long on update, truncating chunk (${chunks[0].length} chars)`);
            const truncated = chunks[0].slice(0, 3800) + "\n\n_(truncated)_";
            await app.client.chat.update({
              channel: channelId,
              ts: thinkingTs,
              text: truncated,
            });
          } else {
            throw updateErr;
          }
        }
      } else {
        await app.client.chat.postMessage({
          channel: channelId,
          thread_ts: messageTs,
          text: chunks[0],
        });
      }

      // Remaining chunks as thread replies
      for (let i = 1; i < chunks.length; i++) {
        try {
          await app.client.chat.postMessage({
            channel: channelId,
            thread_ts: messageTs,
            text: chunks[i],
          });
        } catch (postErr: any) {
          if (postErr?.data?.error === "msg_too_long") {
            console.warn(`[AlertWorkflow] msg_too_long on chunk ${i}, truncating (${chunks[i].length} chars)`);
            const truncated = chunks[i].slice(0, 3800) + "\n\n_(truncated)_";
            await app.client.chat.postMessage({
              channel: channelId,
              thread_ts: messageTs,
              text: truncated,
            });
          } else {
            throw postErr;
          }
        }
      }

      // Upload full report as file snippet in thread
      if (reportPath) {
        try {
          await app.client.filesUploadV2({
            channel_id: channelId,
            thread_ts: messageTs,
            content: rawText,
            filename: path.basename(reportPath),
            title: "Full Investigation Report",
            initial_comment: "_Full report attached above._",
          });
          console.log(`[AlertWorkflow] Uploaded full report to thread ${messageTs}`);
        } catch (uploadErr) {
          console.error(`[AlertWorkflow] Failed to upload report file:`, uploadErr);
        }
      }

      console.log(`[AlertWorkflow] Posted summary (${chunks.length} chunk(s), ${summaryText.length} chars) to thread ${messageTs}`);
    } catch (err) {
      console.error(`[AlertWorkflow] Failed to post response:`, err);
    }

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
    safeKill(workflow.cliChild);
    workflow.cliChild = null;
  }

  // Load skill and spawn follow-up CLI
  const slackLink = buildSlackLink(workflow.channelId, threadTs);
  const skillContext = detectAndLoadSkill(config.alertSkill);
  if (!skillContext) {
    console.error(`[AlertWorkflow] Skill "${config.alertSkill}" not found for follow-up`);
    return;
  }
  skillContext.skillArgs = `on ${slackLink}`;

  // Post "Investigating..." indicator
  let thinkingTs: string | undefined;
  try {
    const res = await app.client.chat.postMessage({
      channel: workflow.channelId,
      thread_ts: threadTs,
      text: "Investigating...",
    });
    thinkingTs = res.ts || undefined;
  } catch {}

  const prompt = `Invoke skill "${config.alertSkill}" with args "on ${slackLink}". Follow-up question from owner: ${text}`;
  const { child, done } = spawnClaudeCli(prompt, config.paymentsRepoPath, { skillContext });
  workflow.cliChild = child;

  done.then(async (result) => {
    workflow.cliChild = null;
    console.log(
      `[AlertWorkflow] Follow-up CLI finished for thread ${threadTs} (exit: ${result.exitCode})`
    );

    const rawFollowUpText = result.fullReport || result.response
      || (result.exitCode !== 0 ? `CLI exited with error (code: ${result.exitCode}).` : "No response from CLI.");
    const responseText = markdownToSlackMrkdwn(rawFollowUpText) + buildUsageFooter(result);

    try {
      const chunks = chunkResponse(responseText);

      if (thinkingTs) {
        try {
          await app.client.chat.update({
            channel: workflow.channelId,
            ts: thinkingTs,
            text: chunks[0],
          });
        } catch (updateErr: any) {
          if (updateErr?.data?.error === "msg_too_long") {
            console.warn(`[AlertWorkflow] msg_too_long on follow-up update, truncating chunk (${chunks[0].length} chars)`);
            const truncated = chunks[0].slice(0, 3800) + "\n\n_(truncated)_";
            await app.client.chat.update({
              channel: workflow.channelId,
              ts: thinkingTs,
              text: truncated,
            });
          } else {
            throw updateErr;
          }
        }
      } else {
        await app.client.chat.postMessage({
          channel: workflow.channelId,
          thread_ts: threadTs,
          text: chunks[0],
        });
      }

      for (let i = 1; i < chunks.length; i++) {
        try {
          await app.client.chat.postMessage({
            channel: workflow.channelId,
            thread_ts: threadTs,
            text: chunks[i],
          });
        } catch (postErr: any) {
          if (postErr?.data?.error === "msg_too_long") {
            console.warn(`[AlertWorkflow] msg_too_long on follow-up chunk ${i}, truncating (${chunks[i].length} chars)`);
            const truncated = chunks[i].slice(0, 3800) + "\n\n_(truncated)_";
            await app.client.chat.postMessage({
              channel: workflow.channelId,
              thread_ts: threadTs,
              text: truncated,
            });
          } else {
            throw postErr;
          }
        }
      }

      console.log(`[AlertWorkflow] Posted follow-up response (${chunks.length} chunk(s), ${responseText.length} chars) to thread ${threadTs}`);
    } catch (err) {
      console.error(`[AlertWorkflow] Failed to post follow-up response:`, err);
    }

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
    safeKill(workflow.cliChild);
    workflow.cliChild = null;
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
    safeKill(workflow.cliChild);
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
      safeKill(workflow.cliChild);
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
