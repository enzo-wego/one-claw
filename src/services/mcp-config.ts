import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";

let mcpConfigPath: string | null = null;

/**
 * Read ~/.claude.json, find project config for paymentsRepoPath,
 * check if any required MCP servers are disabled.
 * If so, extract their config and write a temp override JSON file.
 * Returns the path to the override file, or null if none needed.
 */
export function detectMcpOverrides(): string | null {
  const claudeConfigPath = config.claudeConfigPath;
  if (!existsSync(claudeConfigPath)) {
    console.log("[MCP] Claude config not found, skipping MCP detection");
    return null;
  }

  let claudeConfig: any;
  try {
    claudeConfig = JSON.parse(readFileSync(claudeConfigPath, "utf-8"));
  } catch (err) {
    console.warn("[MCP] Failed to parse Claude config:", err);
    return null;
  }

  const projectConfig = claudeConfig.projects?.[config.paymentsRepoPath];
  if (!projectConfig) {
    console.log(`[MCP] No project config found for ${config.paymentsRepoPath}`);
    return null;
  }

  const mcpServers = projectConfig.mcpServers || {};
  const disabled = new Set(projectConfig.disabledMcpServers || []);
  const overrides: Record<string, any> = {};

  for (const name of config.requiredMcpServers) {
    if (disabled.has(name) && mcpServers[name]) {
      console.log(`[MCP] Required server "${name}" is disabled — will force-enable via --mcp-config`);
      overrides[name] = mcpServers[name];
    } else if (!mcpServers[name]) {
      console.warn(`[MCP] Required server "${name}" not configured in project`);
    } else {
      console.log(`[MCP] Required server "${name}" is enabled`);
    }
  }

  if (Object.keys(overrides).length === 0) {
    console.log("[MCP] All required servers enabled, no override needed");
    return null;
  }

  // Write override config to a temp file in the project data directory
  const overridePath = path.join(path.dirname(config.databasePath), "mcp-override.json");
  writeFileSync(overridePath, JSON.stringify({ mcpServers: overrides }, null, 2));
  console.log(`[MCP] Override config written to ${overridePath}`);

  mcpConfigPath = overridePath;
  return overridePath;
}

export function getMcpConfigPath(): string | null {
  return mcpConfigPath;
}
