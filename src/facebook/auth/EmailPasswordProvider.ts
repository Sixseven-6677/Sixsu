import { FcaApi, FcaCookie }    from "../../mirai/FcaTypes";
import { AppState, IAuthProvider } from "./types/IAuth";
import { AuthFailureReason }       from "./types/IAuthPipeline";
import { LoggerManager }           from "../../../logger/LoggerManager";

const log = LoggerManager.getLogger("EmailPasswordProvider");

/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * fca-unofficial accepts either { appState } or { email, password }.
 * We declare the broadest union here so TypeScript is satisfied.
 */
const fcaLogin = require("@dongdev/fca-unofficial") as (
  options:  { email: string; password: string } | { appState: FcaCookie[] },
  callback: (err: unknown, api: FcaApi | null) => void,
) => void;

/** Timeout for a single email/password login attempt. */
const LOGIN_TIMEOUT_MS = 60_000;

const FCA_OPTIONS: Record<string, unknown> = {
  logLevel:          "silent",
  selfListen:        false,
  listenEvents:      false,
  updatePresence:    false,
  forceLogin:        false,
  autoMarkDelivered: false,
  autoMarkRead:      false,
  autoReconnect:     false,
};

// ─── Public result type ───────────────────────────────────────────────────────

export interface EmailPasswordLoginResult {
  success:        boolean;
  appState?:      AppState;
  failureReason?: AuthFailureReason;
  /** Raw error string — NEVER contains the password. */
  error?:         string;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * IAuthProvider implementation that performs a full Facebook login using
 * email and password credentials, then extracts and returns a fresh AppState.
 *
 * Security rules enforced here:
 *  - Credentials are accepted only via constructor — never read by this class.
 *  - The password is NEVER written to any log, session file, or error message.
 *  - The email is logged only in redacted form (first 3 chars + domain masked).
 *  - Call EmailPasswordProvider.fromEnv() to read from FB_EMAIL / FB_PASSWORD.
 */
export class EmailPasswordProvider implements IAuthProvider {
  private readonly email:    string;
  private readonly password: string;

  constructor(email: string, password: string) {
    this.email    = email;
    this.password = password;
  }

  // ── IAuthProvider ─────────────────────────────────────────────────────────

  /** Performs a full login and returns the resulting AppState. */
  async load(): Promise<AppState> {
    const result = await this.loginWithCredentials();
    if (!result.success || !result.appState) {
      throw new Error(
        result.error ??
        `Email/password login failed: ${result.failureReason ?? "unknown"}`
      );
    }
    return result.appState;
  }

  /** Validates that the returned AppState contains the minimum required cookies. */
  validate(appState: AppState): boolean {
    const keys = new Set(appState.map((c) => c.key));
    return keys.has("c_user") && keys.has("xs");
  }

  // ── Core login ────────────────────────────────────────────────────────────

  /**
   * Attempts a full Facebook login with email + password.
   * Returns a structured result — never throws.
   *
   * The password is passed directly to fca-unofficial and is never stored
   * in any variable that is subsequently logged or serialised.
   */
  async loginWithCredentials(): Promise<EmailPasswordLoginResult> {
    log.info(`EmailPasswordProvider: logging in as ${this.redactEmail(this.email)}…`);

    return new Promise<EmailPasswordLoginResult>((resolve) => {
      let settled = false;

      const settle = (result: EmailPasswordLoginResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const timeout = setTimeout(() => {
        log.error("EmailPasswordProvider: login timed out after 60s.");
        settle({
          success:       false,
          failureReason: AuthFailureReason.NETWORK_FAILURE,
          error:         "Email/password login timed out after 60s.",
        });
      }, LOGIN_TIMEOUT_MS);

      try {
        fcaLogin(
          { email: this.email, password: this.password },
          (err, api) => {
            clearTimeout(timeout);

            if (err || !api) {
              const reason = classifyError(err);
              const msg    = safeErrorMessage(err);
              log.warn(
                `EmailPasswordProvider: login failed. ` +
                `reason="${reason}" error="${msg}"`
              );
              settle({ success: false, failureReason: reason, error: msg });
              return;
            }

            try { api.setOptions(FCA_OPTIONS); } catch { /* non-critical */ }

            const freshCookies = api.getAppState() as FcaCookie[];
            if (!freshCookies || freshCookies.length === 0) {
              log.error(
                "EmailPasswordProvider: login reported success but " +
                "getAppState() returned empty — session may be unusable."
              );
              try { api.logout(); } catch { /* ignore */ }
              settle({
                success:       false,
                failureReason: AuthFailureReason.UNKNOWN,
                error:         "Login succeeded but AppState cookies were empty.",
              });
              return;
            }

            log.info(
              `EmailPasswordProvider: login successful. ` +
              `cookies=${freshCookies.length} account=${this.redactEmail(this.email)}`
            );

            // Disconnect the temporary API — MiraiTransport will re-initialise
            // with the freshly extracted AppState.
            try { api.logout(); } catch { /* ignore */ }

            settle({ success: true, appState: freshCookies as AppState });
          },
        );
      } catch (syncErr: unknown) {
        clearTimeout(timeout);
        const msg = syncErr instanceof Error ? syncErr.message : String(syncErr);
        log.error(`EmailPasswordProvider: fcaLogin threw synchronously: ${msg}`);
        settle({
          success:       false,
          failureReason: classifyError(syncErr),
          error:         msg,
        });
      }
    });
  }

  // ── Factory ───────────────────────────────────────────────────────────────

  /**
   * Creates an EmailPasswordProvider by reading FB_EMAIL and FB_PASSWORD from
   * environment variables. Returns null when either variable is absent —
   * callers treat null as "email/password fallback not configured."
   *
   * The password value is never logged — only its presence is checked.
   */
  static fromEnv(): EmailPasswordProvider | null {
    const email    = process.env["FB_EMAIL"]    ?? "";
    const password = process.env["FB_PASSWORD"] ?? "";
    if (!email || !password) return null;
    return new EmailPasswordProvider(email, password);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Returns a safe display form of the email — never logs the full address. */
  private redactEmail(email: string): string {
    const at = email.indexOf("@");
    if (at <= 0) return "***@***";
    return email.slice(0, Math.min(3, at)) + "***" + email.slice(at);
  }
}

// ─── Error helpers ────────────────────────────────────────────────────────────

/**
 * Extracts a human-readable error message from the raw fca-unofficial error.
 * Never surfaces the password — it is not part of fca-unofficial error objects.
 */
function safeErrorMessage(err: unknown): string {
  if (!err) return "null error returned by fca-unofficial";
  if (err instanceof Error) return err.message;
  if (typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (typeof e["errorDescription"] === "string") return e["errorDescription"];
    if (typeof e["error"]            === "string") return e["error"];
    if (typeof e["message"]          === "string") return e["message"];
    const safe = { ...e };
    delete safe["password"]; delete safe["pass"]; delete safe["pwd"];
    return JSON.stringify(safe);
  }
  return String(err);
}

/**
 * Maps a raw fca-unofficial error to a structured AuthFailureReason.
 * Does not log or surface credential values.
 */
function classifyError(err: unknown): AuthFailureReason {
  const msg    = safeErrorMessage(err).toLowerCase();
  const errObj = (typeof err === "object" && err !== null)
    ? err as Record<string, unknown>
    : {};

  // Checkpoint — Facebook requires identity verification
  const continueUrl = String(errObj["continue"] ?? errObj["url"] ?? "");
  if (continueUrl.includes("/checkpoint/") || msg.includes("checkpoint")) {
    return AuthFailureReason.CHECKPOINT;
  }

  // Two-factor authentication
  if (
    msg.includes("two-factor") || msg.includes("two factor")   ||
    msg.includes("verification code") || msg.includes("login approval") ||
    msg.includes("approvals")
  ) {
    return AuthFailureReason.TWO_FACTOR_AUTH;
  }

  // Wrong credentials
  if (
    msg.includes("incorrect password") || msg.includes("wrong password") ||
    msg.includes("invalid credentials") || msg.includes("email or phone") ||
    msg.includes("1357004") || msg.includes("login failed")
  ) {
    return AuthFailureReason.CREDENTIAL_INVALID;
  }

  // Account restricted / suspended
  if (
    msg.includes("suspended") || msg.includes("restricted") ||
    msg.includes("disabled")  || msg.includes("locked")
  ) {
    return AuthFailureReason.ACCOUNT_RESTRICTED;
  }

  // AppState-specific (rare in email/password path but be safe)
  if (
    msg.includes("appstate expired") || msg.includes("fb_appstate expired") ||
    msg.includes("appstate die")
  ) {
    return AuthFailureReason.APPSTATE_EXPIRED;
  }

  // Transient Facebook server errors
  if (
    msg.includes("1357031") || msg.includes("1357045") ||
    msg.includes("server error") || msg.includes("try again later")
  ) {
    return AuthFailureReason.FACEBOOK_TEMPORARY_ERROR;
  }

  // Network / connectivity
  if (
    msg.includes("econnrefused") || msg.includes("enotfound") ||
    msg.includes("network")      || msg.includes("timeout")   ||
    msg.includes("socket hang up")
  ) {
    return AuthFailureReason.NETWORK_FAILURE;
  }

  return AuthFailureReason.UNKNOWN;
}
