import "dotenv/config";
import path from "node:path";
import os from "node:os";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function csvList(name: string): string[] {
  return (process.env[name] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function channelList(name: string): { enabled: string[]; disabled: string[] } {
  const raw = (process.env[name] || "").split(",").map((s) => s.trim()).filter(Boolean);
  const enabled: string[] = [];
  const disabled: string[] = [];
  for (const item of raw) {
    if (item.startsWith("!")) {
      disabled.push(item.slice(1));
    } else {
      enabled.push(item);
    }
  }
  return { enabled, disabled };
}

export const config = {
  slackBotToken: required("SLACK_BOT_TOKEN"),
  slackAppToken: required("SLACK_APP_TOKEN"),
  slackSigningSecret: required("SLACK_SIGNING_SECRET"),
  databasePath: process.env.DATABASE_PATH || "./data/bot.db",
  port: parseInt(process.env.PORT || "3000", 10),
  ownerUserId: required("OWNER_USER_ID"),

  // Channel configuration (comma-separated channel names)
  channels: {
    dailySummary: csvList("DAILY_SUMMARY_CHANNELS"),
    monitor: channelList("MONITOR_CHANNELS"),
    monitorDelay: channelList("MONITOR_DELAY_CHANNELS"),
    discuss: csvList("DISCUSS_CHANNELS"),
  },

  // Daily summary settings
  dailySummaryTime: process.env.DAILY_SUMMARY_TIME || "07:00",
  dailySummaryModel: process.env.DAILY_SUMMARY_MODEL || "sonnet",

  // Agent model for chat responses
  agentModel: process.env.AGENT_MODEL || "sonnet",

  // Discuss channel model
  discussModel: process.env.DISCUSS_MODEL || "claude-sonnet-4-5-20250929",
  discussCliTimeoutMs: parseInt(process.env.DISCUSS_CLI_TIMEOUT_MS || "600000", 10),
  discussHeartbeatIntervalMs: parseInt(process.env.DISCUSS_HEARTBEAT_INTERVAL_MS || "30000", 10),

  // PagerDuty
  pagerdutyApiToken: process.env.PAGERDUTY_API_TOKEN || "",
  pagerdutyFromEmail: process.env.PAGERDUTY_FROM_EMAIL || "",

  // Slack workspace domain (for building permalinks)
  slackWorkspaceDomain: process.env.SLACK_WORKSPACE_DOMAIN || "wego.slack.com",

  // Daily restart hour (0-23, default: 23)
  dailyRestartHour: parseInt(process.env.DAILY_RESTART_HOUR || "23", 10),

  // Alert workflow
  alertSkill: process.env.ALERT_SKILL || "one:pay-ops-production",
  alertModel: process.env.ALERT_MODEL || "claude-opus-4-6",
  paymentsRepoPath:
    process.env.PAYMENTS_REPO_PATH ||
    "/Users/neocapitelo/go/src/github.com/payments",
  alertFeedbackTimeoutMs: parseInt(
    process.env.ALERT_FEEDBACK_TIMEOUT_MS || "300000",
    10
  ),

  // Delay alert workflow
  delayAlertThreshold: parseInt(process.env.DELAY_ALERT_THRESHOLD || "3", 10),
  delayAlertWindowMs: parseInt(
    process.env.DELAY_ALERT_WINDOW_MS || "3600000",
    10
  ),
  delayAlertTaskPatterns: csvList("DELAY_ALERT_TASK_PATTERNS"),
  delayAlertSkill: process.env.DELAY_ALERT_SKILL || "one:pay-ops-tax-production",

  // MCP servers required by alert skills (auto-detected from ~/.claude.json)
  requiredMcpServers: csvList("REQUIRED_MCP_SERVERS").length > 0
    ? csvList("REQUIRED_MCP_SERVERS")
    : ["chrome-devtools", "athena"],
  claudeConfigPath: process.env.CLAUDE_CONFIG_PATH || path.join(os.homedir(), ".claude.json"),
};
