import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

const SLACK_FILES_DIR = "./data/slack-files";
const FILE_TTL_MS = 60 * 60 * 1000; // 1 hour

const SUPPORTED_PREFIXES = ["image/", "application/pdf", "text/"];

function isSupportedMimetype(mimetype: string): boolean {
  return SUPPORTED_PREFIXES.some((prefix) => mimetype.startsWith(prefix));
}

function cleanupOldFiles(): void {
  try {
    const now = Date.now();
    for (const entry of readdirSync(SLACK_FILES_DIR)) {
      const filePath = path.join(SLACK_FILES_DIR, entry);
      const stat = statSync(filePath);
      if (now - stat.mtimeMs > FILE_TTL_MS) {
        unlinkSync(filePath);
      }
    }
  } catch {
    // Directory may not exist yet
  }
}

export interface SlackFile {
  url_private_download?: string;
  name?: string | null;
  mimetype?: string;
  id?: string;
}

export async function downloadSlackFiles(
  files: SlackFile[],
  botToken: string
): Promise<string[]> {
  cleanupOldFiles();
  mkdirSync(SLACK_FILES_DIR, { recursive: true });

  const downloadedPaths: string[] = [];

  for (const file of files) {
    if (!file.url_private_download || !file.id) continue;
    if (file.mimetype && !isSupportedMimetype(file.mimetype)) continue;

    const safeName = (file.name || "file").replace(/[^a-zA-Z0-9._-]/g, "_");
    const localPath = path.join(SLACK_FILES_DIR, `${file.id}_${safeName}`);

    try {
      const res = await fetch(file.url_private_download, {
        headers: { Authorization: `Bearer ${botToken}` },
      });

      if (!res.ok) {
        console.error(
          `[SlackFiles] Failed to download ${file.id}: ${res.status} ${res.statusText}`
        );
        continue;
      }

      const buffer = Buffer.from(await res.arrayBuffer());
      await writeFile(localPath, buffer);
      downloadedPaths.push(path.resolve(localPath));
      console.log(`[SlackFiles] Downloaded ${file.id} → ${localPath}`);
    } catch (err) {
      console.error(`[SlackFiles] Error downloading ${file.id}:`, err);
    }
  }

  return downloadedPaths;
}

export function buildFilePromptPrefix(filePaths: string[]): string {
  if (filePaths.length === 0) return "";
  const lines = filePaths.map((p) => `- ${p}`).join("\n");
  return `[Attached files — use the Read tool to view them]\n${lines}\n\n`;
}
