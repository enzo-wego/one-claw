import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { App } from "@slack/bolt";
import { getAllDiscussions, killDiscussSession } from "./services/discuss-workflow.js";
import { getAllAlertWorkflows, killAlertWorkflow, startAlertWorkflow, isAlertWorkflowActive } from "./services/alert-workflow.js";
import { getAllDelayWorkflows, killDelayWorkflow, startDelayAlertWorkflow, getActiveDelayWorkflow } from "./services/delay-alert-workflow.js";

const startTime = Date.now();
let slackConnected = false;
let slackApp: App | undefined;
let onTriggerDailySummary: (() => void) | undefined;

export function setSlackConnected(connected: boolean): void {
  slackConnected = connected;
}

export function setSlackApp(app: App): void {
  slackApp = app;
}

export function setDailySummaryTrigger(fn: () => void): void {
  onTriggerDailySummary = fn;
}

function uptime(): string {
  const seconds = Math.floor((Date.now() - startTime) / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s}s`;
}

function handleHealth(_req: IncomingMessage, res: ServerResponse): void {
  const body = {
    status: "ok",
    uptime: uptime(),
    slack_connected: slackConnected,
    active_sessions: getAllDiscussions().length,
  };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function handleIndex(_req: IncomingMessage, res: ServerResponse): void {
  const discuss = getAllDiscussions();
  const alert = getAllAlertWorkflows();
  const delayAlert = getAllDelayWorkflows();
  const cliRunning = discuss.filter(d => d.hasCliChild).length
    + alert.filter(a => a.hasCliChild).length
    + delayAlert.filter(d => d.hasCliChild).length;
  const cliTotal = discuss.length + alert.length + delayAlert.length;

  const html = `<!DOCTYPE html>
<html>
<head><title>EnzoBot</title><meta charset="utf-8">
<style>
  body { font-family: system-ui, sans-serif; max-width: 480px; margin: 60px auto; padding: 0 20px; color: #333; }
  h1 { margin-bottom: 4px; }
  .status { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; }
  .ok { background: #22c55e; }
  .err { background: #ef4444; }
  dl { line-height: 1.8; }
  dt { font-weight: 600; }
  dd { margin-bottom: 4px; }
  .sub { color: #666; font-size: 0.9em; }
</style>
</head>
<body>
  <h1>EnzoBot</h1>
  <p><span class="status ${slackConnected ? "ok" : "err"}"></span>${slackConnected ? "Connected" : "Disconnected"}</p>
  <dl>
    <dt>Uptime</dt><dd>${uptime()}</dd>
    <dt>CLI Sessions</dt>
    <dd>${cliRunning} running / ${cliTotal} total
      <span class="sub">(${discuss.length} discuss, ${alert.length} alert, ${delayAlert.length} delay)</span>
    </dd>
  </dl>
  <p><a href="/sessions">Session details (JSON)</a> · <a href="/api-docs">API docs</a></p>
</body>
</html>`;
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(html);
}

function handleSessions(_req: IncomingMessage, res: ServerResponse): void {
  const discuss = getAllDiscussions();
  const alert = getAllAlertWorkflows();
  const delayAlert = getAllDelayWorkflows();

  const body = {
    summary: {
      total_cli_processes: discuss.filter(d => d.hasCliChild).length
        + alert.filter(a => a.hasCliChild).length
        + delayAlert.filter(d => d.hasCliChild).length,
      discuss: discuss.length,
      alert: alert.length,
      delay_alert: delayAlert.length,
    },
    discuss,
    alert,
    delay_alert: delayAlert,
  };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}

function handleKillSession(threadTs: string, res: ServerResponse): void {
  const killed = killDiscussSession(threadTs)
    || killAlertWorkflow(threadTs)
    || killDelayWorkflow(threadTs);

  if (killed) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "killed", threadTs }));
  } else {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "session not found", threadTs }));
  }
}

function handleKillAll(res: ServerResponse): void {
  const discuss = getAllDiscussions();
  const alert = getAllAlertWorkflows();
  const delayAlert = getAllDelayWorkflows();
  const total = discuss.length + alert.length + delayAlert.length;

  discuss.forEach(d => killDiscussSession(d.threadTs));
  alert.forEach(a => killAlertWorkflow(a.threadTs));
  delayAlert.forEach(d => killDelayWorkflow(d.threadTs));

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "killed_all", killed: total }));
}

function handleDailySummary(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "POST only" }));
    return;
  }
  if (!onTriggerDailySummary) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "daily summary not configured" }));
    return;
  }
  onTriggerDailySummary();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "started" }));
}

function parseSlackUrl(url: string): { channelId: string; messageTs: string } | null {
  const match = url.match(/\/archives\/([A-Z0-9]+)\/p(\d+)/i);
  if (!match) return null;
  const channelId = match[1];
  const raw = match[2];
  // Insert '.' before last 6 digits: p1709123456789012 → 1709123456.789012
  const messageTs = raw.slice(0, raw.length - 6) + "." + raw.slice(raw.length - 6);
  return { channelId, messageTs };
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function jsonError(res: ServerResponse, status: number, error: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error }));
}

async function handleTriggerAlert(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") { jsonError(res, 405, "POST only"); return; }
  if (!slackApp) { jsonError(res, 503, "Slack app not configured"); return; }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch {
    jsonError(res, 400, "invalid JSON body"); return;
  }

  const url = body.url;
  if (typeof url !== "string" || !url) { jsonError(res, 400, "missing url"); return; }

  const parsed = parseSlackUrl(url);
  if (!parsed) { jsonError(res, 400, "invalid Slack URL"); return; }

  const { channelId, messageTs } = parsed;

  if (isAlertWorkflowActive(messageTs)) {
    jsonError(res, 409, "workflow already active for this message"); return;
  }

  // Fetch the message from Slack
  let text = "";
  let attachments: Array<Record<string, unknown>> | undefined;
  try {
    const result = await slackApp.client.conversations.history({
      channel: channelId,
      latest: messageTs,
      inclusive: true,
      limit: 1,
    });
    const msg = result.messages?.[0];
    if (msg) {
      text = (msg.text as string) || "";
      attachments = msg.attachments as Array<Record<string, unknown>> | undefined;
    }
  } catch (err) {
    jsonError(res, 500, `failed to fetch Slack message: ${err}`); return;
  }

  startAlertWorkflow(slackApp, channelId, messageTs, text, attachments);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "started", channelId, messageTs }));
}

async function handleTriggerDelayAlert(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") { jsonError(res, 405, "POST only"); return; }
  if (!slackApp) { jsonError(res, 503, "Slack app not configured"); return; }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch {
    jsonError(res, 400, "invalid JSON body"); return;
  }

  const url = body.url;
  if (typeof url !== "string" || !url) { jsonError(res, 400, "missing url"); return; }

  const parsed = parseSlackUrl(url);
  if (!parsed) { jsonError(res, 400, "invalid Slack URL"); return; }

  const { channelId, messageTs } = parsed;

  if (getActiveDelayWorkflow(messageTs)) {
    jsonError(res, 409, "workflow already active for this message"); return;
  }

  // Fetch the message from Slack
  let text = "";
  try {
    const result = await slackApp.client.conversations.history({
      channel: channelId,
      latest: messageTs,
      inclusive: true,
      limit: 1,
    });
    const msg = result.messages?.[0];
    if (msg) {
      text = (msg.text as string) || "";
    }
  } catch (err) {
    jsonError(res, 500, `failed to fetch Slack message: ${err}`); return;
  }

  // Extract dag name from message text
  const dagMatch = text.match(/\*Dag\*:\s*(.+)/);
  if (!dagMatch) {
    jsonError(res, 400, "no dag name found in message text"); return;
  }
  const dagName = dagMatch[1].trim();

  startDelayAlertWorkflow(slackApp, channelId, messageTs, text, dagName);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "started", channelId, messageTs, dagName }));
}

const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "EnzoBot API",
    description: "EnzoBot — Slack bot powered by Claude. Manage health, CLI sessions, and daily summaries.",
    version: "1.0.0",
  },
  paths: {
    "/": {
      get: {
        summary: "Status page",
        description: "HTML status page showing bot connectivity and uptime.",
        responses: {
          "200": { description: "HTML status page", content: { "text/html": { schema: { type: "string" } } } },
        },
      },
    },
    "/health": {
      get: {
        summary: "Health check",
        description: "Returns bot health status, uptime, Slack connection, and active DM session count.",
        responses: {
          "200": {
            description: "Health status",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", example: "ok" },
                    uptime: { type: "string", example: "2h 15m 30s" },
                    slack_connected: { type: "boolean", example: true },
                    active_sessions: { type: "integer", example: 3 },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/sessions": {
      get: {
        summary: "List all active CLI sessions",
        description: "Returns all active Claude CLI sessions across discuss, alert, and delay-alert workflows.",
        responses: {
          "200": {
            description: "Active sessions",
            content: {
              "application/json": {
                example: {
                  summary: { total_cli_processes: 3, discuss: 2, alert: 1, delay_alert: 0 },
                  discuss: [
                    { threadTs: "1740500000.000100", channelId: "C06ABC123", cliSessionId: "abc123-def456", isProcessing: true, hasCliChild: true },
                    { threadTs: "1740499000.000200", channelId: "C06ABC123", cliSessionId: "xyz789-abc012", isProcessing: false, hasCliChild: false },
                  ],
                  alert: [
                    { threadTs: "1740498000.000300", channelId: "C07DEF456", incidentId: "P9X8Y7Z6", hasCliChild: true },
                  ],
                  delay_alert: [],
                },
              },
            },
          },
        },
      },
    },
    "/sessions/kill": {
      post: {
        summary: "Kill all sessions",
        description: "Kills all active CLI sessions across all workflow types. Returns the count of sessions killed.",
        responses: {
          "200": {
            description: "All sessions killed",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", example: "killed_all" },
                    killed: { type: "integer", example: 3 },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/sessions/{threadTs}/kill": {
      post: {
        summary: "Kill a specific session",
        description: "Kills a specific CLI session by its Slack thread timestamp. Searches across all workflow types.",
        parameters: [
          {
            name: "threadTs",
            in: "path",
            required: true,
            description: "Slack thread timestamp (e.g. 1740500000.000100)",
            schema: { type: "string", example: "1740500000.000100" },
          },
        ],
        responses: {
          "200": {
            description: "Session killed",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", example: "killed" },
                    threadTs: { type: "string", example: "1740500000.000100" },
                  },
                },
              },
            },
          },
          "404": {
            description: "Session not found",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    error: { type: "string", example: "session not found" },
                    threadTs: { type: "string", example: "1740500000.000100" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/daily-summary": {
      post: {
        summary: "Trigger daily summary",
        description: "Manually triggers the daily channel summary. The summary is generated asynchronously and sent as a DM.",
        responses: {
          "200": {
            description: "Summary started",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", example: "started" },
                  },
                },
              },
            },
          },
          "405": {
            description: "Method not allowed (GET not supported)",
            content: {
              "application/json": {
                schema: { type: "object", properties: { error: { type: "string", example: "POST only" } } },
              },
            },
          },
          "503": {
            description: "Daily summary not configured",
            content: {
              "application/json": {
                schema: { type: "object", properties: { error: { type: "string", example: "daily summary not configured" } } },
              },
            },
          },
        },
      },
    },
    "/trigger-alert": {
      post: {
        summary: "Trigger alert investigation",
        description: "Manually triggers a PagerDuty alert investigation on a specific Slack message. Parses the Slack URL, fetches the message, and starts the alert workflow.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["url"],
                properties: {
                  url: { type: "string", example: "https://wego.slack.com/archives/C0ABC/p1709123456789012" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Investigation started",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", example: "started" },
                    channelId: { type: "string", example: "C0ABC" },
                    messageTs: { type: "string", example: "1709123456.789012" },
                  },
                },
              },
            },
          },
          "400": {
            description: "Invalid request (missing/invalid URL)",
            content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } },
          },
          "409": {
            description: "Workflow already active for this message",
            content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } },
          },
          "503": {
            description: "Slack app not configured",
            content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } },
          },
        },
      },
    },
    "/trigger-delay-alert": {
      post: {
        summary: "Trigger delay alert investigation",
        description: "Manually triggers an Airflow delay alert investigation on a specific Slack message. Parses the Slack URL, fetches the message, extracts the DAG name, and starts the delay workflow.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["url"],
                properties: {
                  url: { type: "string", example: "https://wego.slack.com/archives/C0ABC/p1709123456789012" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Investigation started",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", example: "started" },
                    channelId: { type: "string", example: "C0ABC" },
                    messageTs: { type: "string", example: "1709123456.789012" },
                    dagName: { type: "string", example: "payments.process-taxes" },
                  },
                },
              },
            },
          },
          "400": {
            description: "Invalid request (missing/invalid URL, no dag name in message)",
            content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } },
          },
          "409": {
            description: "Workflow already active for this message",
            content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } },
          },
          "503": {
            description: "Slack app not configured",
            content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } },
          },
        },
      },
    },
  },
};

function handleApiDocs(_req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(openApiSpec, null, 2));
}

function handleSwaggerUi(_req: IncomingMessage, res: ServerResponse): void {
  const html = `<!DOCTYPE html>
<html>
<head>
  <title>EnzoBot API Docs</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({ url: "/api-docs.json", dom_id: "#swagger-ui" });
  </script>
</body>
</html>`;
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(html);
}

let httpServer: Server | undefined;

export function startHttpServer(port: number): void {
  httpServer = createServer((req, res) => {
    if (req.url === "/api-docs") return handleSwaggerUi(req, res);
    if (req.url === "/api-docs.json") return handleApiDocs(req, res);
    if (req.url === "/health") return handleHealth(req, res);
    if (req.url === "/sessions") return handleSessions(req, res);
    if (req.url === "/sessions/kill" && req.method === "POST") return handleKillAll(res);
    if (req.url?.startsWith("/sessions/") && req.method === "POST") {
      const threadTs = decodeURIComponent(req.url.slice("/sessions/".length).replace(/\/kill$/, ""));
      return handleKillSession(threadTs, res);
    }
    if (req.url === "/daily-summary") return handleDailySummary(req, res);
    if (req.url === "/trigger-alert") return void handleTriggerAlert(req, res);
    if (req.url === "/trigger-delay-alert") return void handleTriggerDelayAlert(req, res);
    if (req.url === "/") return handleIndex(req, res);
    res.writeHead(404);
    res.end("Not found");
  });

  httpServer.listen(port, () => {
    console.log(`HTTP server listening on http://localhost:${port}`);
  });
}

export function stopHttpServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!httpServer) return resolve();
    httpServer.close(() => {
      console.log("HTTP server closed");
      resolve();
    });
  });
}
