import type { App } from "@slack/bolt";
import type { ChildProcess } from "node:child_process";
import { config } from "../config.js";
import { spawnClaudeCli, safeKill, detectAndLoadSkill, chunkResponse, markdownToSlackMrkdwn, rewriteApiError, type CliRunResult } from "./claude-cli.js";
import { insertWorkflow, deleteWorkflow, getWorkflowsByType, updateWorkflowType, updateWorkflowCliSession } from "./database.js";
import { createDiscussFromWorkflow } from "./discuss-workflow.js";

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

interface DelayAlertWorkflow {
  channelId: string;
  threadTs: string;
  dagName: string;
  cliChild: ChildProcess | null;
  feedbackTimer: ReturnType<typeof setTimeout> | null;
}

const workflows = new Map<string, DelayAlertWorkflow>();

/** Build a Slack message permalink */
function buildSlackLink(channelId: string, messageTs: string): string {
  const tsNoDot = messageTs.replace(".", "");
  return `https://${config.slackWorkspaceDomain}/archives/${channelId}/p${tsNoDot}`;
}

/** Start the feedback timeout. On expiry, clean up the workflow. */
function startFeedbackTimer(app: App, workflow: DelayAlertWorkflow): void {
  clearFeedbackTimer(workflow);
  workflow.feedbackTimer = setTimeout(() => {
    console.log(
      `[DelayAlertWorkflow] Feedback timeout for thread ${workflow.threadTs}, cleaning up`
    );
    cleanupDelayWorkflow(app, workflow);
  }, config.alertFeedbackTimeoutMs);
}

function clearFeedbackTimer(workflow: DelayAlertWorkflow): void {
  if (workflow.feedbackTimer) {
    clearTimeout(workflow.feedbackTimer);
    workflow.feedbackTimer = null;
  }
}

export async function startDelayAlertWorkflow(
  app: App,
  channelId: string,
  messageTs: string,
  text: string,
  dagName: string
): Promise<void> {
  if (workflows.has(messageTs)) return;

  const slackLink = buildSlackLink(channelId, messageTs);

  const workflow: DelayAlertWorkflow = {
    channelId,
    threadTs: messageTs,
    dagName,
    cliChild: null,
    feedbackTimer: null,
  };
  workflows.set(messageTs, workflow);
  insertWorkflow(messageTs, "delay_alert", channelId, { dagName });

  console.log(
    `[DelayAlertWorkflow] Started for Dag: ${dagName}, thread ${messageTs}`
  );

  // Load skill content and spawn Claude CLI to investigate
  const skillContext = detectAndLoadSkill(config.delayAlertSkill, config.paymentsRepoPath);
  if (!skillContext) {
    console.error(`[DelayAlertWorkflow] Skill "${config.delayAlertSkill}" not found, aborting workflow`);
    workflows.delete(messageTs);
    deleteWorkflow(messageTs);
    return;
  }
  skillContext.skillArgs = slackLink;

  // Post "Investigating..." indicator to thread
  let thinkingTs: string | undefined;
  try {
    const res = await app.client.chat.postMessage({
      channel: channelId,
      thread_ts: messageTs,
      text: "Investigating...",
    });
    thinkingTs = res.ts || undefined;
  } catch (err) {
    console.error(`[DelayAlertWorkflow] Failed to post thinking indicator:`, err);
  }

  const prompt = `Invoke skill "${config.delayAlertSkill}" with args "${slackLink}".`;
  const { child, done } = spawnClaudeCli(prompt, config.paymentsRepoPath, { skillContext });
  workflow.cliChild = child;

  // When CLI finishes, post response and start feedback timer
  done.then(async (result) => {
    workflow.cliChild = null;
    console.log(
      `[DelayAlertWorkflow] CLI finished for Dag: ${dagName}, thread ${messageTs} (exit: ${result.exitCode})`
    );

    let rawText = result.fullReport || result.response
      || (result.exitCode !== 0 ? `CLI exited with error (code: ${result.exitCode}).` : "No response from CLI.");
    const rewritten = rewriteApiError(rawText);
    if (rewritten) {
      console.warn(`[DelayAlertWorkflow] API error in thread ${messageTs}: ${rawText.slice(0, 200)}`);
      rawText = rewritten;
    }
    const responseText = markdownToSlackMrkdwn(rawText) + buildUsageFooter(result);

    try {
      const chunks = chunkResponse(responseText);

      if (thinkingTs) {
        try {
          await app.client.chat.update({
            channel: channelId,
            ts: thinkingTs,
            text: chunks[0],
          });
        } catch (updateErr: any) {
          if (updateErr?.data?.error === "msg_too_long") {
            console.warn(`[DelayAlertWorkflow] msg_too_long on update, truncating (${chunks[0].length} chars)`);
            await app.client.chat.update({
              channel: channelId,
              ts: thinkingTs,
              text: chunks[0].slice(0, 3800) + "\n\n_(truncated)_",
            });
          } else {
            throw updateErr;
          }
        }
      } else {
        try {
          await app.client.chat.postMessage({
            channel: channelId,
            thread_ts: messageTs,
            text: chunks[0],
          });
        } catch (postErr: any) {
          if (postErr?.data?.error === "msg_too_long") {
            console.warn(`[DelayAlertWorkflow] msg_too_long on post, truncating (${chunks[0].length} chars)`);
            await app.client.chat.postMessage({
              channel: channelId,
              thread_ts: messageTs,
              text: chunks[0].slice(0, 3800) + "\n\n_(truncated)_",
            });
          } else {
            throw postErr;
          }
        }
      }

      for (let i = 1; i < chunks.length; i++) {
        try {
          await app.client.chat.postMessage({
            channel: channelId,
            thread_ts: messageTs,
            text: chunks[i],
          });
        } catch (postErr: any) {
          if (postErr?.data?.error === "msg_too_long") {
            console.warn(`[DelayAlertWorkflow] msg_too_long on chunk ${i}, truncating (${chunks[i].length} chars)`);
            await app.client.chat.postMessage({
              channel: channelId,
              thread_ts: messageTs,
              text: chunks[i].slice(0, 3800) + "\n\n_(truncated)_",
            });
          } else {
            throw postErr;
          }
        }
      }

      console.log(`[DelayAlertWorkflow] Posted response (${chunks.length} chunk(s)) to thread ${messageTs}`);
    } catch (err) {
      console.error(`[DelayAlertWorkflow] Failed to post response:`, err);
    }

    // Convert to discuss session if we got a sessionId (no API error)
    if (result.sessionId && !rewritten && workflows.has(messageTs)) {
      console.log(`[DelayAlertWorkflow] Converting thread ${messageTs} to discuss session (session: ${result.sessionId})`);
      const lastPostedTs = thinkingTs || null;
      createDiscussFromWorkflow(channelId, messageTs, result.sessionId, lastPostedTs);
      updateWorkflowType(messageTs, "discuss");
      updateWorkflowCliSession(messageTs, result.sessionId);
      clearFeedbackTimer(workflow);
      workflows.delete(messageTs);
      return;
    }

    if (workflows.has(messageTs)) {
      startFeedbackTimer(app, workflow);
    }
  });
}

export async function handleDelayOwnerFeedback(
  app: App,
  threadTs: string,
  text: string
): Promise<void> {
  const workflow = workflows.get(threadTs);
  if (!workflow) return;

  console.log(`[DelayAlertWorkflow] Owner feedback on thread ${threadTs}`);

  clearFeedbackTimer(workflow);

  // Kill any running CLI before spawning a new one
  if (workflow.cliChild) {
    safeKill(workflow.cliChild);
    workflow.cliChild = null;
  }

  // Load skill and spawn follow-up CLI
  const slackLink = buildSlackLink(workflow.channelId, threadTs);
  const skillContext = detectAndLoadSkill(config.delayAlertSkill, config.paymentsRepoPath);
  if (!skillContext) {
    console.error(`[DelayAlertWorkflow] Skill "${config.delayAlertSkill}" not found for follow-up`);
    return;
  }
  skillContext.skillArgs = slackLink;

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

  const prompt = `Invoke skill "${config.delayAlertSkill}" with args "${slackLink}". Follow-up question from owner: ${text}`;
  const { child, done } = spawnClaudeCli(prompt, config.paymentsRepoPath, { skillContext });
  workflow.cliChild = child;

  done.then(async (result) => {
    workflow.cliChild = null;
    console.log(
      `[DelayAlertWorkflow] Follow-up CLI finished for thread ${threadTs} (exit: ${result.exitCode})`
    );

    let rawFollowUpText = result.fullReport || result.response
      || (result.exitCode !== 0 ? `CLI exited with error (code: ${result.exitCode}).` : "No response from CLI.");
    const rewrittenFollowUp = rewriteApiError(rawFollowUpText);
    if (rewrittenFollowUp) {
      console.warn(`[DelayAlertWorkflow] API error in follow-up for thread ${threadTs}: ${rawFollowUpText.slice(0, 200)}`);
      rawFollowUpText = rewrittenFollowUp;
    }
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
            console.warn(`[DelayAlertWorkflow] msg_too_long on follow-up update, truncating (${chunks[0].length} chars)`);
            await app.client.chat.update({
              channel: workflow.channelId,
              ts: thinkingTs,
              text: chunks[0].slice(0, 3800) + "\n\n_(truncated)_",
            });
          } else {
            throw updateErr;
          }
        }
      } else {
        try {
          await app.client.chat.postMessage({
            channel: workflow.channelId,
            thread_ts: threadTs,
            text: chunks[0],
          });
        } catch (postErr: any) {
          if (postErr?.data?.error === "msg_too_long") {
            console.warn(`[DelayAlertWorkflow] msg_too_long on follow-up post, truncating (${chunks[0].length} chars)`);
            await app.client.chat.postMessage({
              channel: workflow.channelId,
              thread_ts: threadTs,
              text: chunks[0].slice(0, 3800) + "\n\n_(truncated)_",
            });
          } else {
            throw postErr;
          }
        }
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
            console.warn(`[DelayAlertWorkflow] msg_too_long on follow-up chunk ${i}, truncating (${chunks[i].length} chars)`);
            await app.client.chat.postMessage({
              channel: workflow.channelId,
              thread_ts: threadTs,
              text: chunks[i].slice(0, 3800) + "\n\n_(truncated)_",
            });
          } else {
            throw postErr;
          }
        }
      }

      console.log(`[DelayAlertWorkflow] Posted follow-up response (${chunks.length} chunk(s)) to thread ${threadTs}`);
    } catch (err) {
      console.error(`[DelayAlertWorkflow] Failed to post follow-up response:`, err);
    }

    // Convert to discuss session if we got a sessionId (no API error)
    if (result.sessionId && !rewrittenFollowUp && workflows.has(threadTs)) {
      console.log(`[DelayAlertWorkflow] Converting follow-up thread ${threadTs} to discuss session (session: ${result.sessionId})`);
      const lastPostedTs = thinkingTs || null;
      createDiscussFromWorkflow(workflow.channelId, threadTs, result.sessionId, lastPostedTs);
      updateWorkflowType(threadTs, "discuss");
      updateWorkflowCliSession(threadTs, result.sessionId);
      clearFeedbackTimer(workflow);
      workflows.delete(threadTs);
      return;
    }

    if (workflows.has(threadTs)) {
      startFeedbackTimer(app, workflow);
    }
  });
}

export async function cleanupDelayWorkflow(
  app: App,
  workflow: DelayAlertWorkflow
): Promise<void> {
  clearFeedbackTimer(workflow);

  if (workflow.cliChild) {
    safeKill(workflow.cliChild);
    workflow.cliChild = null;
  }

  // Post completion message to thread
  try {
    await app.client.chat.postMessage({
      channel: workflow.channelId,
      thread_ts: workflow.threadTs,
      text: "Investigation complete.",
    });
  } catch (err) {
    console.error(`[DelayAlertWorkflow] Failed to post cleanup message:`, err);
  }

  workflows.delete(workflow.threadTs);
  deleteWorkflow(workflow.threadTs);
  console.log(
    `[DelayAlertWorkflow] Cleaned up workflow for Dag: ${workflow.dagName}, thread ${workflow.threadTs}`
  );
}

export function getActiveDelayWorkflow(
  threadTs: string
): DelayAlertWorkflow | undefined {
  return workflows.get(threadTs);
}

export function getAllDelayWorkflows(): Array<{
  threadTs: string;
  channelId: string;
  dagName: string;
  hasCliChild: boolean;
}> {
  return Array.from(workflows.entries()).map(([threadTs, w]) => ({
    threadTs,
    channelId: w.channelId,
    dagName: w.dagName,
    hasCliChild: w.cliChild !== null,
  }));
}

export function killDelayWorkflow(threadTs: string): boolean {
  const workflow = workflows.get(threadTs);
  if (!workflow) return false;
  clearFeedbackTimer(workflow);
  if (workflow.cliChild) {
    safeKill(workflow.cliChild);
    workflow.cliChild = null;
  }
  workflows.delete(threadTs);
  deleteWorkflow(threadTs);
  console.log(`[DelayAlertWorkflow] Killed workflow for thread ${threadTs} via API`);
  return true;
}

export function isWorkflowActiveForDag(dagName: string): boolean {
  for (const workflow of workflows.values()) {
    if (workflow.dagName === dagName) return true;
  }
  return false;
}

export function killAllDelayWorkflows(): void {
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
    console.log(`Killed ${workflows.size} active delay alert workflows`);
  }
}

/** Restore persisted delay alert workflows from DB on startup */
export function restoreDelayWorkflows(app: App): void {
  const rows = getWorkflowsByType("delay_alert");
  for (const row of rows) {
    const workflow: DelayAlertWorkflow = {
      channelId: row.channel_id,
      threadTs: row.thread_ts,
      dagName: row.dag_name || "unknown",
      cliChild: null,
      feedbackTimer: null,
    };
    workflows.set(row.thread_ts, workflow);
    startFeedbackTimer(app, workflow);
  }
  if (rows.length > 0) {
    console.log(`[DelayAlertWorkflow] Restored ${rows.length} workflows`);
  }
}
