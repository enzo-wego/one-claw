import { getActiveSession, setProcessing } from "./database.js";

export function isProcessing(threadTs: string): boolean {
  const session = getActiveSession(threadTs);
  return session?.is_processing === 1;
}

export function lock(sessionId: string): void {
  setProcessing(sessionId, true);
}

export function unlock(sessionId: string): void {
  setProcessing(sessionId, false);
}
