import type { App } from "@slack/bolt";
import type { ChildProcess } from "node:child_process";
import { config } from "../config.js";
import { spawnClaudeCli } from "./claude-cli.js";

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

  console.log(
    `[DelayAlertWorkflow] Started for Dag: ${dagName}, thread ${messageTs}`
  );

  // Spawn Claude CLI to investigate using the configured skill
  const prompt = `Invoke skill "${config.delayAlertSkill}" with args "${slackLink}". Pre-approved to post report.`;
  const { child, done } = spawnClaudeCli(prompt, config.paymentsRepoPath);
  workflow.cliChild = child;

  // When CLI finishes, start feedback timer
  done.then((result) => {
    workflow.cliChild = null;
    console.log(
      `[DelayAlertWorkflow] CLI finished for Dag: ${dagName}, thread ${messageTs} (exit: ${result.exitCode})`
    );
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
    workflow.cliChild.kill("SIGTERM");
    workflow.cliChild = null;
  }

  // Spawn follow-up CLI
  const slackLink = buildSlackLink(workflow.channelId, threadTs);
  const prompt = `Invoke skill "${config.delayAlertSkill}" with args "${slackLink}". Follow-up question from owner: ${text}`;
  const { child, done } = spawnClaudeCli(prompt, config.paymentsRepoPath);
  workflow.cliChild = child;

  done.then((result) => {
    workflow.cliChild = null;
    console.log(
      `[DelayAlertWorkflow] Follow-up CLI finished for thread ${threadTs} (exit: ${result.exitCode})`
    );
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
    workflow.cliChild.kill("SIGTERM");
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
    workflow.cliChild.kill("SIGTERM");
    workflow.cliChild = null;
  }
  workflows.delete(threadTs);
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
      workflow.cliChild.kill("SIGTERM");
      workflow.cliChild = null;
    }
    workflows.delete(key);
  }
  if (workflows.size > 0) {
    console.log(`Killed ${workflows.size} active delay alert workflows`);
  }
}
