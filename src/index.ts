// Prepend timestamps to all console output
function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
const origLog = console.log.bind(console);
const origError = console.error.bind(console);
const origWarn = console.warn.bind(console);
console.log = (...args: unknown[]) => origLog(`[${timestamp()}]`, ...args);
console.error = (...args: unknown[]) => origError(`[${timestamp()}] ERROR`, ...args);
console.warn = (...args: unknown[]) => origWarn(`[${timestamp()}] WARN`, ...args);

import { config } from "./config.js";
import { initDatabase, closeDatabase } from "./services/database.js";
import { startHttpServer, setSlackConnected, setDailySummaryTrigger, stopHttpServer } from "./server.js";
import { registerHandlers } from "./handlers/message.js";
import { registerAlertMonitor, resolveMonitorChannels } from "./handlers/alert-monitor.js";
import { resolveDelayChannels, registerDelayAlertMonitor } from "./handlers/delay-alert-monitor.js";
import { resolveDiscussChannels, registerDiscussMonitor } from "./handlers/discuss-monitor.js";
import { runDailySummary } from "./services/daily-summary.js";
import { killAllWorkflows } from "./services/alert-workflow.js";
import { killAllDelayWorkflows } from "./services/delay-alert-workflow.js";
import { killAllDiscussWorkflows } from "./services/discuss-workflow.js";
import { detectMcpOverrides } from "./services/mcp-config.js";
import { App } from "@slack/bolt";

// Init database
initDatabase(config.databasePath);
console.log(`Database initialized at ${config.databasePath}`);

// Detect MCP overrides for alert CLI processes
detectMcpOverrides();

// Create Slack app
const app = new App({
  token: config.slackBotToken,
  appToken: config.slackAppToken,
  signingSecret: config.slackSigningSecret,
  socketMode: true,
});

// Schedule daily restart
function scheduleDailyRestart(): void {
  const hour = config.dailyRestartHour;
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  const ms = next.getTime() - now.getTime();
  console.log(`Scheduled restart at ${hour}:00 (in ${Math.round(ms / 60000)} minutes)`);
  setTimeout(() => {
    console.log(`Daily restart at ${hour}:00 — exiting...`);
    process.exit(0);
  }, ms).unref();
}

// Run daily summary
function triggerDailySummary(): void {
  runDailySummary({
    channels: config.channels.dailySummary,
    ownerUserId: config.ownerUserId,
    model: config.dailySummaryModel,
    sendDm: async (userId: string, text: string) => {
      const MAX_LENGTH = 3900;
      if (text.length <= MAX_LENGTH) {
        await app.client.chat.postMessage({ channel: userId, text });
        return;
      }

      // Split into chunks at paragraph boundaries, thread replies after first
      const chunks: string[] = [];
      let remaining = text;
      while (remaining.length > 0) {
        if (remaining.length <= MAX_LENGTH) {
          chunks.push(remaining);
          break;
        }
        // Find last paragraph break within limit
        let splitAt = remaining.lastIndexOf("\n\n", MAX_LENGTH);
        if (splitAt <= 0) splitAt = remaining.lastIndexOf("\n", MAX_LENGTH);
        if (splitAt <= 0) splitAt = MAX_LENGTH;
        chunks.push(remaining.slice(0, splitAt));
        remaining = remaining.slice(splitAt).replace(/^\n+/, "");
      }

      // First chunk as the main message
      const first = await app.client.chat.postMessage({
        channel: userId,
        text: chunks[0],
      });
      const threadTs = first.ts;

      // Remaining chunks as thread replies
      for (let i = 1; i < chunks.length; i++) {
        await app.client.chat.postMessage({
          channel: userId,
          text: chunks[i],
          thread_ts: threadTs,
        });
      }
    },
  }).catch((err) => console.error("[DailySummary] Failed:", err));
}

// Schedule daily summary at configured time
function scheduleDailySummary(): void {
  if (config.channels.dailySummary.length === 0) {
    console.log("Daily summary: no channels configured, skipping scheduler");
    return;
  }

  const [hourStr, minStr] = config.dailySummaryTime.split(":");
  const hour = parseInt(hourStr, 10);
  const minute = parseInt(minStr, 10);

  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  const ms = next.getTime() - now.getTime();
  console.log(
    `Daily summary scheduled at ${config.dailySummaryTime} ` +
      `for channels: ${config.channels.dailySummary.join(", ")} ` +
      `(in ${Math.round(ms / 60000)} min)`
  );

  setTimeout(() => {
    triggerDailySummary();
  }, ms).unref();
}

// Register HTTP trigger for manual testing
setDailySummaryTrigger(triggerDailySummary);

// Start HTTP server
startHttpServer(config.port);

// Start Slack Socket Mode
(async () => {
  await app.start();
  setSlackConnected(true);

  // Get bot's own user ID to filter self-messages
  const auth = await app.client.auth.test();
  const botUserId = auth.user_id || "";
  console.log(`Bot user ID: ${botUserId}`);

  // Resolve all channel names to IDs before registering handlers
  await resolveMonitorChannels(app);
  await resolveDelayChannels(app);
  await resolveDiscussChannels(app);

  // Register message handlers (checks isDiscussChannel, so must be after resolve)
  registerHandlers(app, botUserId, config.ownerUserId);
  registerAlertMonitor(app, config.ownerUserId);
  registerDelayAlertMonitor(app, config.ownerUserId);
  registerDiscussMonitor(app, config.ownerUserId);

  scheduleDailyRestart();
  scheduleDailySummary();

  // Graceful shutdown
  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received — shutting down...`);

    killAllWorkflows();
    killAllDelayWorkflows();
    killAllDiscussWorkflows();
    setSlackConnected(false);

    try { await app.stop(); } catch {}
    await stopHttpServer();
    closeDatabase();

    console.log("EnzoBot stopped.");
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  console.log(`EnzoBot is running! http://localhost:${config.port}`);
})();
