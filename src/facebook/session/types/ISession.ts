export enum SessionStatus {
  ACTIVE       = "ACTIVE",
  EXPIRED      = "EXPIRED",
  CORRUPTED    = "CORRUPTED",
  DISCONNECTED = "DISCONNECTED",
  RESTORING    = "RESTORING",
}

export interface SessionEntry {
  accountId: string;
  /** Plaintext AppState JSON in memory; encrypted on disk by SessionStore. */
  appStateData: string;
  createdAt: string;
  expiresAt: string | null;
  lastValidatedAt: string | null;
  status: SessionStatus;
  failCount: number;
}

export interface SessionFile {
  version: number;
  updatedAt: string;
  sessions: Record<string, SessionEntry>;
}

export interface SessionValidationResult {
  valid: boolean;
  reason?: string;
  status: SessionStatus;
}
