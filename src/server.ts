import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { getActiveSessionCount } from "./services/database.js";

const startTime = Date.now();
let slackConnected = false;
let onTriggerDailySummary: (() => void) | undefined;

export function setSlackConnected(connected: boolean): void {
  slackConnected = connected;
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
    active_sessions: getActiveSessionCount(),
  };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function handleIndex(_req: IncomingMessage, res: ServerResponse): void {
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
</style>
</head>
<body>
  <h1>EnzoBot</h1>
  <p><span class="status ${slackConnected ? "ok" : "err"}"></span>${slackConnected ? "Connected" : "Disconnected"}</p>
  <dl>
    <dt>Uptime</dt><dd>${uptime()}</dd>
    <dt>Sessions</dt><dd>${getActiveSessionCount()}</dd>
  </dl>
</body>
</html>`;
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(html);
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

let httpServer: Server | undefined;

export function startHttpServer(port: number): void {
  httpServer = createServer((req, res) => {
    if (req.url === "/health") return handleHealth(req, res);
    if (req.url === "/daily-summary") return handleDailySummary(req, res);
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
