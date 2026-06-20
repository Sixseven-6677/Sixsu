import { AppStateCookie } from "../auth/types/IAuth";

/**
 * Wraps an FCA app-state cookie array and exposes the helpers
 * that MessengerPoller needs:
 *   - getUserId()      — the c_user value (Facebook user ID of the bot account)
 *   - getRawAppState() — the raw cookie array passed to fca-unofficial
 */
export class CookieHttpClient {
  private readonly appState: AppStateCookie[];
  private readonly _userId:  string;

  constructor(appState: AppStateCookie[]) {
    this.appState = appState;
    this._userId  = this.extractUserId(appState);
  }

  getUserId(): string {
    return this._userId;
  }

  getRawAppState(): AppStateCookie[] {
    return this.appState;
  }

  private extractUserId(appState: AppStateCookie[]): string {
    const cUser = appState.find((c) => c.key === "c_user");
    return cUser?.value ?? "";
  }
}
