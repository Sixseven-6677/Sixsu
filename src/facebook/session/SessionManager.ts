import { ISystem }          from "../../core/interfaces/ISystem";
import { AuthManager }      from "../auth/AuthManager";
import { AppState }         from "../auth/types/IAuth";
import { SessionStore }     from "./SessionStore";
import {
  SessionEntry,
  SessionStatus,
  SessionValidationResult,
} from "./types/ISession";
import { LoggerManager }    from "../../logger/LoggerManager";

const log = LoggerManager.getLogger("SessionManager");

const SESSION_TTL_MS  = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_FAIL_COUNT  = 5;

export interface SessionManagerOptions {
  store: SessionStore;
  auth:  AuthManager;
  ttlMs?: number;
}

export class SessionManager implements ISystem {
  readonly name = "session";

  private readonly store: SessionStore;
  private readonly auth:  AuthManager;
  private readonly ttlMs: number;

  constructor(options: SessionManagerOptions) {
    this.store = options.store;
    this.auth  = options.auth;
    this.ttlMs = options.ttlMs ?? SESSION_TTL_MS;
  }

  async initialize(): Promise<void> {
    log.info("SessionManager initialized. Restoring sessions...");
    await this.restoreAll();
  }

  async destroy(): Promise<void> {
    log.info("SessionManager destroyed.");
  }

  async saveSession(accountId: string): Promise<void> {
    const credentials = this.auth.getCredentials(accountId);
    if (!credentials) {
      throw new Error(
        `Cannot save session: account "${accountId}" is not authenticated.`
      );
    }

    const entry: SessionEntry = {
      accountId,
      encryptedAppState: JSON.stringify(credentials.appState),
      createdAt:         credentials.loadedAt.toISOString(),
      expiresAt:         new Date(Date.now() + this.ttlMs).toISOString(),
      lastValidatedAt:   new Date().toISOString(),
      status:            SessionStatus.ACTIVE,
      failCount:         0,
    };

    await this.store.save(entry);
    log.info(`Session saved for account: ${accountId}`);
  }

  async restoreSession(accountId: string): Promise<boolean> {
    log.info(`Restoring session for account: ${accountId}`);

    const entry = await this.store.load(accountId);
    if (!entry) {
      log.warn(`No saved session found for account: ${accountId}`);
      return false;
    }

    const validation = this.validateEntry(entry);
    if (!validation.valid) {
      log.warn(
        `Session for "${accountId}" invalid: ${validation.reason ?? "unknown"}`
      );
      await this.handleInvalidSession(accountId, entry, validation.status);
      return false;
    }

    let appState: AppState;
    try {
      appState = JSON.parse(entry.encryptedAppState) as AppState;
    } catch {
      log.error(`Session data for "${accountId}" is corrupted.`);
      await this.markCorrupted(accountId, entry);
      return false;
    }

    this.auth.injectCredentials({
      accountId,
      appState,
      loadedAt: new Date(entry.createdAt),
    });

    await this.store.save({
      ...entry,
      lastValidatedAt: new Date().toISOString(),
      status:          SessionStatus.ACTIVE,
    });

    log.info(`Session restored for account: ${accountId}`);
    return true;
  }

  async restoreAll(): Promise<void> {
    const accounts = this.store.listAccounts();
    if (accounts.length === 0) {
      log.info("No saved sessions found.");
      return;
    }

    let restored = 0;
    for (const id of accounts) {
      if (await this.restoreSession(id)) restored++;
    }

    log.info(`Sessions restored: ${restored}/${accounts.length}`);
  }

  async reconnect(accountId: string): Promise<boolean> {
    log.info(`Reconnecting account: ${accountId}`);

    const entry = await this.store.load(accountId);
    if (entry && entry.failCount >= MAX_FAIL_COUNT) {
      log.error(
        `Account "${accountId}" exceeded max reconnect attempts (${MAX_FAIL_COUNT}). ` +
        `Manual intervention required.`
      );
      return false;
    }

    const result = await this.auth.login(accountId);
    if (!result.success) {
      await this.incrementFailCount(accountId);
      log.warn(`Reconnect failed for "${accountId}": ${result.error ?? "unknown error"}`);
      return false;
    }

    await this.saveSession(accountId);
    log.info(`Reconnect successful for account: ${accountId}`);
    return true;
  }

  validate(accountId: string): SessionValidationResult {
    if (!this.auth.isAuthenticated(accountId)) {
      return {
        valid:  false,
        reason: "Account is not authenticated.",
        status: SessionStatus.DISCONNECTED,
      };
    }
    return { valid: true, status: SessionStatus.ACTIVE };
  }

  invalidate(accountId: string): void {
    this.auth.logout(accountId);
    this.store.delete(accountId);
    log.info(`Session invalidated for account: ${accountId}`);
  }

  getStatus(accountId: string): SessionStatus {
    return this.auth.isAuthenticated(accountId)
      ? SessionStatus.ACTIVE
      : SessionStatus.DISCONNECTED;
  }

  private validateEntry(entry: SessionEntry): SessionValidationResult {
    if (entry.status === SessionStatus.CORRUPTED) {
      return {
        valid:  false,
        reason: "Session is marked as corrupted.",
        status: SessionStatus.CORRUPTED,
      };
    }

    if (entry.failCount >= MAX_FAIL_COUNT) {
      return {
        valid:  false,
        reason: `Too many failures (${entry.failCount}).`,
        status: SessionStatus.DISCONNECTED,
      };
    }

    if (entry.expiresAt && Date.now() > new Date(entry.expiresAt).getTime()) {
      return {
        valid:  false,
        reason: "Session has expired.",
        status: SessionStatus.EXPIRED,
      };
    }

    return { valid: true, status: SessionStatus.ACTIVE };
  }

  private async handleInvalidSession(
    accountId: string,
    entry: SessionEntry,
    status: SessionStatus
  ): Promise<void> {
    if (status === SessionStatus.EXPIRED) {
      log.info(`Session for "${accountId}" expired. Attempting reconnect via provider.`);
      await this.reconnect(accountId);
    } else {
      await this.markCorrupted(accountId, entry);
    }
  }

  private async markCorrupted(accountId: string, entry: SessionEntry): Promise<void> {
    await this.store.save({ ...entry, status: SessionStatus.CORRUPTED });
    log.error(`Session for "${accountId}" marked as CORRUPTED.`);
  }

  private async incrementFailCount(accountId: string): Promise<void> {
    const entry = await this.store.load(accountId);
    if (!entry) return;
    await this.store.save({
      ...entry,
      failCount: entry.failCount + 1,
      status:    SessionStatus.DISCONNECTED,
    });
  }
}
