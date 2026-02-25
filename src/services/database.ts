import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

let db: Database.Database;

export interface Session {
  id: number;
  session_id: string;
  thread_ts: string | null;
  channel_id: string;
  user_id: string;
  is_processing: number;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: number;
  session_id: string;
  message_ts: string;
  user_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

function generateSessionId(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

export function initDatabase(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL UNIQUE,
      thread_ts TEXT UNIQUE,
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      is_processing INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      message_ts TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
    );
  `);

  return db;
}

export function getDb(): Database.Database {
  if (!db) throw new Error("Database not initialized");
  return db;
}

// Find the active session for a channel/thread key
export function getActiveSession(threadTs: string): Session | undefined {
  return getDb().prepare("SELECT * FROM sessions WHERE thread_ts = ?").get(threadTs) as Session | undefined;
}

// Find a session by its session_id
export function getSessionById(sessionId: string): Session | undefined {
  return getDb().prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId) as Session | undefined;
}

// Create a new active session
export function createSession(threadTs: string, channelId: string, userId: string): Session {
  const sessionId = generateSessionId();
  getDb()
    .prepare("INSERT INTO sessions (session_id, thread_ts, channel_id, user_id) VALUES (?, ?, ?, ?)")
    .run(sessionId, threadTs, channelId, userId);
  return getSessionById(sessionId)!;
}

// Archive the current active session (detach from thread_ts)
export function archiveSession(threadTs: string): void {
  getDb()
    .prepare("UPDATE sessions SET thread_ts = NULL, updated_at = datetime('now') WHERE thread_ts = ?")
    .run(threadTs);
}

// Activate a session by session_id, linking it to a thread_ts
export function activateSession(sessionId: string, threadTs: string): void {
  getDb()
    .prepare("UPDATE sessions SET thread_ts = ?, updated_at = datetime('now') WHERE session_id = ?")
    .run(threadTs, sessionId);
}

export function setProcessing(sessionId: string, flag: boolean): void {
  getDb()
    .prepare("UPDATE sessions SET is_processing = ?, updated_at = datetime('now') WHERE session_id = ?")
    .run(flag ? 1 : 0, sessionId);
}

export function saveMessage(
  sessionId: string,
  messageTs: string,
  userId: string,
  role: "user" | "assistant",
  content: string
): void {
  getDb()
    .prepare("INSERT INTO messages (session_id, message_ts, user_id, role, content) VALUES (?, ?, ?, ?, ?)")
    .run(sessionId, messageTs, userId, role, content);
}

export function getMessages(sessionId: string): Message[] {
  return getDb().prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC").all(sessionId) as Message[];
}

export function getActiveSessionCount(): number {
  const row = getDb().prepare("SELECT COUNT(*) as count FROM sessions").get() as { count: number };
  return row.count;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    console.log("Database closed");
  }
}
