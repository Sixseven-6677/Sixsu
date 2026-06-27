import { ISystem } from "../../core/interfaces/ISystem";
import { AppStateProvider } from "./AppStateProvider";
import {
  AppState,
  AuthCredentials,
  AuthResult,
  AuthStatus,
  IAuthProvider,
} from "./types/IAuth";
import { LoggerManager } from "../../logger/LoggerManager";

const log = LoggerManager.getLogger("AuthManager");

export class AuthManager implements ISystem {
  readonly name = "auth";

  private readonly accounts          = new Map<string, AuthCredentials>();
  private readonly providers         = new Map<string, IAuthProvider>();
  /**
   * Fallback providers tried in order after the main provider fails.
   * Designed for EmailPasswordProvider — registered via registerFallbackProvider().
   * Transparent to ReconnectManager: auth.login() uses them automatically.
   */
  private readonly fallbackProviders = new Map<string, IAuthProvider[]>();

  async initialize(): Promise<void> {
    log.info(`AuthManager initialized. providers=${this.providers.size}`);
  }

  async destroy(): Promise<void> {
    this.accounts.clear();
    this.providers.clear();
    this.fallbackProviders.clear();
    log.info("AuthManager destroyed. All credentials cleared.");
  }

  // ── Provider registration ─────────────────────────────────────────────────

  registerAccount(accountId: string, provider: IAuthProvider): this {
    if (this.providers.has(accountId)) {
      log.warn(`Account "${accountId}" already registered. Overwriting provider.`);
    }
    this.providers.set(accountId, provider);
    log.info(`Provider registered for account: ${accountId}`);
    return this;
  }

  /**
   * Register a fallback provider that is tried (in registration order) when the
   * main provider fails. The canonical use case is registering an
   * EmailPasswordProvider so that auth.login() automatically falls back to a full
   * email/password login during reconnects — without any changes to ReconnectManager.
   */
  registerFallbackProvider(accountId: string, provider: IAuthProvider): this {
    const existing = this.fallbackProviders.get(accountId) ?? [];
    existing.push(provider);
    this.fallbackProviders.set(accountId, existing);
    log.info(
      `Fallback provider registered for account: ${accountId} ` +
      `(total fallbacks: ${existing.length})`
    );
    return this;
  }

  // ── Authentication ────────────────────────────────────────────────────────

  /**
   * Authenticates an account using its registered provider.
   * If the main provider fails, each fallback provider is tried in order.
   *
   * For the startup multi-stage pipeline with full per-stage reporting,
   * use AuthPipeline.run() instead — it wraps this method and adds diagnostics.
   */
  async login(accountId: string): Promise<AuthResult> {
    const mainProvider = this.providers.get(accountId);
    if (!mainProvider) {
      return {
        success: false,
        status:  AuthStatus.UNAUTHENTICATED,
        error:   `No provider registered for account "${accountId}".`,
      };
    }

    log.info(`Logging in account: ${accountId}`);

    // ── Try main provider ─────────────────────────────────────────────────
    let appState:  AppState | undefined;
    let lastError: string  | undefined;

    try {
      appState  = await mainProvider.load();
      lastError = undefined;
    } catch (err: unknown) {
      lastError = err instanceof Error ? err.message : String(err);
      const hasFallbacks = (this.fallbackProviders.get(accountId)?.length ?? 0) > 0;
      log.warn(
        `Main provider failed for "${accountId}": ${lastError}.` +
        (hasFallbacks ? " Trying fallback provider(s)…" : "")
      );
    }

    // ── Try fallback providers in order ───────────────────────────────────
    if (!appState) {
      const fallbacks = this.fallbackProviders.get(accountId) ?? [];
      for (let i = 0; i < fallbacks.length; i++) {
        log.info(`Fallback provider ${i + 1}/${fallbacks.length} for "${accountId}"…`);
        try {
          appState  = await fallbacks[i].load();
          lastError = undefined;
          log.info(
            `Fallback provider ${i + 1} succeeded for "${accountId}". ` +
            `cookies=${appState.length}`
          );
          break;
        } catch (err: unknown) {
          lastError = err instanceof Error ? err.message : String(err);
          log.warn(`Fallback provider ${i + 1} failed for "${accountId}": ${lastError}`);
        }
      }
    }

    // ── Result ────────────────────────────────────────────────────────────
    if (!appState) {
      log.error(`Login failed for "${accountId}": ${lastError}`);
      return { success: false, status: AuthStatus.CORRUPTED, error: lastError };
    }

    this.accounts.set(accountId, { accountId, appState, loadedAt: new Date() });
    log.info(`Account "${accountId}" authenticated. cookies=${appState.length}`);
    return { success: true, accountId, status: AuthStatus.AUTHENTICATED };
  }

  async loginAll(): Promise<Map<string, AuthResult>> {
    const results = new Map<string, AuthResult>();
    for (const id of this.providers.keys()) {
      results.set(id, await this.login(id));
    }
    return results;
  }
  /**
   * Authenticate using ONLY fallback providers (e.g. EmailPasswordProvider),
   * bypassing the main provider entirely.
   *
   * In reconnect contexts, AppStateProvider.load() reads expired env cookies
   * and returns them without liveness validation — never throwing. This causes
   * auth.login() to always "succeed" with expired cookies, so EmailPasswordProvider
   * (registered as fallback) is never reached through the normal path.
   *
   * Call this in ReconnectManager.attemptLogin() to force the fallback chain.
   */
  async loginFallbackOnly(accountId: string): Promise<AuthResult> {
    const fallbacks = this.fallbackProviders.get(accountId) ?? [];
    if (fallbacks.length === 0) {
      return {
        success: false,
        status:  AuthStatus.UNAUTHENTICATED,
        error:   `No fallback providers registered for account "${accountId}".`,
      };
    }

    log.info(`loginFallbackOnly: trying ${fallbacks.length} fallback(s) for "${accountId}"…`);

    let appState:  AppState | undefined;
    let lastError: string  | undefined;

    for (let i = 0; i < fallbacks.length; i++) {
      log.info(`Fallback provider ${i + 1}/${fallbacks.length} for "${accountId}"…`);
      try {
        appState  = await fallbacks[i].load();
        lastError = undefined;
        log.info(
          `Fallback provider ${i + 1} succeeded for "${accountId}". ` +
          `cookies=${appState.length}`,
        );
        break;
      } catch (err: unknown) {
        lastError = err instanceof Error ? err.message : String(err);
        log.warn(`Fallback provider ${i + 1} failed for "${accountId}": ${lastError}`);
      }
    }

    if (!appState) {
      log.error(`loginFallbackOnly: all fallbacks failed for "${accountId}": ${lastError}`);
      return { success: false, status: AuthStatus.CORRUPTED, error: lastError };
    }

    this.accounts.set(accountId, { accountId, appState, loadedAt: new Date() });
    log.info(`Account "${accountId}" authenticated via fallback. cookies=${appState.length}`);
    return { success: true, accountId, status: AuthStatus.AUTHENTICATED };
  }

  injectCredentials(credentials: AuthCredentials): void {
    this.accounts.set(credentials.accountId, credentials);
    log.info(`Credentials injected for account: ${credentials.accountId}`);
  }

  /**
   * Update the stored AppState for an account in-memory.
   * Used by the transport layer to persist fresh cookies obtained from
   * fca-unofficial after a successful MQTT connection so that the next
   * session save writes the latest cookies, not the original ones.
   */
  updateAppState(accountId: string, appState: AppState): void {
    const existing = this.accounts.get(accountId);
    if (!existing) {
      log.warn(`updateAppState: account "${accountId}" not found.`);
      return;
    }
    this.accounts.set(accountId, { ...existing, appState, loadedAt: new Date() });
    log.info(`AppState updated for account: ${accountId} cookies=${appState.length}`);
  }

  logout(accountId: string): void {
    this.accounts.delete(accountId);
    log.info(`Account "${accountId}" logged out.`);
  }

  getCredentials(accountId: string): AuthCredentials | null {
    return this.accounts.get(accountId) ?? null;
  }

  isAuthenticated(accountId: string): boolean {
    return this.accounts.has(accountId);
  }

  hasProvider(accountId: string): boolean {
    return this.providers.has(accountId);
  }

  hasFallbacks(accountId: string): boolean {
    return (this.fallbackProviders.get(accountId)?.length ?? 0) > 0;
  }

  getAuthenticatedAccounts(): string[] {
    return Array.from(this.accounts.keys());
  }

  getRegisteredAccounts(): string[] {
    return Array.from(this.providers.keys());
  }

  static fromEnv(
    accountId: string,
    envKey: string
  ): { accountId: string; provider: IAuthProvider } {
    const value = process.env[envKey];
    if (!value) {
      throw new Error(`Environment variable "${envKey}" is not set.`);
    }
    return { accountId, provider: new AppStateProvider({ fromEnv: value }) };
  }

  static fromFile(
    accountId: string,
    filePath: string
  ): { accountId: string; provider: IAuthProvider } {
    return { accountId, provider: new AppStateProvider({ fromFile: filePath }) };
  }
}
