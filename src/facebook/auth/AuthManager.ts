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

  private readonly accounts  = new Map<string, AuthCredentials>();
  private readonly providers = new Map<string, IAuthProvider>();

  async initialize(): Promise<void> {
    log.info(`AuthManager initialized. Registered providers: ${this.providers.size}`);
  }

  async destroy(): Promise<void> {
    this.accounts.clear();
    this.providers.clear();
    log.info("AuthManager destroyed. All credentials cleared.");
  }

  registerAccount(accountId: string, provider: IAuthProvider): this {
    if (this.providers.has(accountId)) {
      log.warn(`Account "${accountId}" already registered. Overwriting provider.`);
    }
    this.providers.set(accountId, provider);
    log.info(`Provider registered for account: ${accountId}`);
    return this;
  }

  async login(accountId: string): Promise<AuthResult> {
    const provider = this.providers.get(accountId);
    if (!provider) {
      return {
        success: false,
        status:  AuthStatus.UNAUTHENTICATED,
        error:   `No provider registered for account "${accountId}".`,
      };
    }

    log.info(`Logging in account: ${accountId}`);

    let appState: AppState;
    try {
      appState = await provider.load();
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.error(`Login failed for "${accountId}": ${error}`);
      return { success: false, status: AuthStatus.CORRUPTED, error };
    }

    this.accounts.set(accountId, { accountId, appState, loadedAt: new Date() });
    log.info(`Account "${accountId}" authenticated.`);

    return { success: true, accountId, status: AuthStatus.AUTHENTICATED };
  }

  async loginAll(): Promise<Map<string, AuthResult>> {
    const results = new Map<string, AuthResult>();
    for (const id of this.providers.keys()) {
      results.set(id, await this.login(id));
    }
    return results;
  }

  injectCredentials(credentials: AuthCredentials): void {
    this.accounts.set(credentials.accountId, credentials);
    log.info(`Credentials injected for account: ${credentials.accountId}`);
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

  getAuthenticatedAccounts(): string[] {
    return Array.from(this.accounts.keys());
  }

  static fromEnv(accountId: string, envKey: string): { accountId: string; provider: IAuthProvider } {
    const value = process.env[envKey];
    if (!value) {
      throw new Error(`Environment variable "${envKey}" is not set.`);
    }
    return { accountId, provider: new AppStateProvider({ fromEnv: value }) };
  }

  static fromFile(accountId: string, filePath: string): { accountId: string; provider: IAuthProvider } {
    return { accountId, provider: new AppStateProvider({ fromFile: filePath }) };
  }
}
