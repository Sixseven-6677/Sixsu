import { AuthManager }           from "./AuthManager";
import { EmailPasswordProvider }  from "./EmailPasswordProvider";
import { SessionManager }         from "../session/SessionManager";
import {
  AuthFailureReason,
  AuthPipelineResult,
  AuthStage,
  AuthStageAttempt,
} from "./types/IAuthPipeline";
import { LoggerManager } from "../../logger/LoggerManager";

const log = LoggerManager.getLogger("AuthPipeline");

// ─────────────────────────────────────────────────────────────────────────────

export interface AuthPipelineOptions {
  auth:           AuthManager;
  session:        SessionManager;
  /**
   * Optional email/password provider for Stage 2 fallback.
   * When null or omitted, the pipeline stops after Stage 1 (AppState only).
   * Construct via EmailPasswordProvider.fromEnv().
   */
  emailPassword?: EmailPasswordProvider | null;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * AuthPipeline — Multi-Stage Authentication Orchestrator
 *
 * Responsibilities:
 *  - Runs ordered authentication stages: AppState → Email/Password.
 *  - Injects credentials into AuthManager when a stage succeeds.
 *  - Persists the resulting session via SessionManager.
 *  - Returns a structured, detailed result for logging and diagnostics.
 *
 * Architecture rules:
 *  - The pipeline owns NO transport or MQTT logic.
 *  - It never loops or retries — each stage runs exactly once.
 *  - On total failure it returns a result; it never throws.
 *  - Security: email/password credentials are never stored or logged.
 *
 * Integration:
 *  - Startup: bootstrapAuth calls pipeline.run() per account.
 *  - Reconnect: AuthManager.login() transparently uses registered fallback
 *    providers (set up by bootstrapAuth) — no pipeline call needed.
 */
export class AuthPipeline {
  private readonly auth:          AuthManager;
  private readonly session:       SessionManager;
  private readonly emailPassword: EmailPasswordProvider | null;

  constructor(opts: AuthPipelineOptions) {
    this.auth          = opts.auth;
    this.session       = opts.session;
    this.emailPassword = opts.emailPassword ?? null;
  }

  // ── Public entry point ────────────────────────────────────────────────────

  /**
   * Runs the multi-stage authentication pipeline for a single account.
   *
   * Stage 1 — AppState
   *   Delegates to AuthManager.login(), which tries the main provider (env/file)
   *   and then any registered fallback providers in registration order.
   *
   * Stage 2 — Email + Password  (only when Stage 1 fails AND emailPassword set)
   *   Performs a full fca-unofficial login, injects the resulting fresh AppState
   *   into AuthManager, then persists the session.
   *
   * @param accountId  Account to authenticate (e.g. "primary").
   * @returns          Always resolves — never rejects.
   */
  async run(accountId: string): Promise<AuthPipelineResult> {
    const configured = this.emailPassword
      ? "[appstate → email-password]"
      : "[appstate]";
    log.info(`[${accountId}] Auth pipeline starting. stages=${configured}`);

    const stages: AuthStageAttempt[] = [];

    // ── Stage 1: AppState ─────────────────────────────────────────────────
    const s1 = await this.runAppStateStage(accountId);
    stages.push(s1);

    if (s1.success) {
      const sessionSaved = await this.trySaveSession(accountId);
      const creds        = this.auth.getCredentials(accountId);
      log.info(`[${accountId}] Pipeline success via AppState. sessionSaved=${sessionSaved}`);
      return {
        success:                true,
        accountId,
        stageUsed:              AuthStage.APPSTATE,
        stages,
        freshAppState:          creds?.appState,
        freshAppStateGenerated: false,
        sessionSaved,
      };
    }

    log.warn(
      `[${accountId}] AppState stage failed. reason="${s1.failureReason}". ` +
      (this.emailPassword
        ? "Falling back to email/password login."
        : "No email/password fallback — authentication stopped.")
    );

    if (!this.emailPassword) {
      return {
        success:                false,
        accountId,
        stageUsed:              AuthStage.APPSTATE,
        stages,
        freshAppStateGenerated: false,
        sessionSaved:           false,
        errorMessage:
          s1.errorMessage ??
          `AppState login failed (${s1.failureReason ?? "unknown"}). ` +
          `Set FB_EMAIL and FB_PASSWORD to enable email/password fallback.`,
      };
    }

    // ── Stage 2: Email + Password ─────────────────────────────────────────
    const s2 = await this.runEmailPasswordStage(accountId);
    stages.push(s2);

    if (!s2.success) {
      log.error(
        `[${accountId}] All auth stages failed. ` +
        `s1=${s1.failureReason} s2=${s2.failureReason}`
      );
      return {
        success:                false,
        accountId,
        stageUsed:              AuthStage.EMAIL_PASSWORD,
        stages,
        freshAppStateGenerated: false,
        sessionSaved:           false,
        errorMessage:
          `All authentication stages failed — ` +
          `AppState: ${s1.failureReason}, ` +
          `Email/Password: ${s2.failureReason}`,
      };
    }

    // Stage 2 succeeded — fresh AppState was injected into AuthManager
    const freshAppState = this.auth.getCredentials(accountId)?.appState;
    const sessionSaved  = await this.trySaveSession(accountId);

    log.info(
      `[${accountId}] Pipeline success via Email/Password. ` +
      `cookies=${freshAppState?.length ?? 0} sessionSaved=${sessionSaved}`
    );

    return {
      success:                true,
      accountId,
      stageUsed:              AuthStage.EMAIL_PASSWORD,
      stages,
      freshAppState,
      freshAppStateGenerated: true,
      sessionSaved,
    };
  }

  // ── Stage runners ─────────────────────────────────────────────────────────

  private async runAppStateStage(accountId: string): Promise<AuthStageAttempt> {
    const start = Date.now();
    log.info(`[${accountId}] Stage 1 — AppState: loading credentials…`);

    try {
      const result     = await this.auth.login(accountId);
      const durationMs = Date.now() - start;

      if (result.success) {
        log.info(`[${accountId}] Stage 1 (AppState): success. durationMs=${durationMs}`);
        return { stage: AuthStage.APPSTATE, success: true, durationMs };
      }

      const failureReason = classifyAppStateError(result.error ?? "");
      log.warn(
        `[${accountId}] Stage 1 (AppState): failed. ` +
        `reason="${failureReason}" durationMs=${durationMs}`
      );
      return {
        stage: AuthStage.APPSTATE, success: false,
        failureReason, errorMessage: result.error, durationMs,
      };

    } catch (err: unknown) {
      const durationMs    = Date.now() - start;
      const errorMessage  = err instanceof Error ? err.message : String(err);
      const failureReason = classifyAppStateError(errorMessage);
      log.error(
        `[${accountId}] Stage 1 (AppState): threw. ` +
        `reason="${failureReason}" durationMs=${durationMs}`
      );
      return {
        stage: AuthStage.APPSTATE, success: false,
        failureReason, errorMessage, durationMs,
      };
    }
  }

  private async runEmailPasswordStage(accountId: string): Promise<AuthStageAttempt> {
    const start = Date.now();
    log.info(`[${accountId}] Stage 2 — Email/Password: attempting full credential login…`);

    if (!this.emailPassword) {
      return {
        stage:         AuthStage.EMAIL_PASSWORD,
        success:       false,
        failureReason: AuthFailureReason.CREDENTIAL_MISSING,
        errorMessage:  "Email/password provider not configured.",
        durationMs:    0,
      };
    }

    try {
      const result     = await this.emailPassword.loginWithCredentials();
      const durationMs = Date.now() - start;

      if (!result.success || !result.appState) {
        log.warn(
          `[${accountId}] Stage 2 (Email/Password): failed. ` +
          `reason="${result.failureReason}" durationMs=${durationMs}`
        );
        return {
          stage:         AuthStage.EMAIL_PASSWORD,
          success:       false,
          failureReason: result.failureReason ?? AuthFailureReason.UNKNOWN,
          errorMessage:  result.error,
          durationMs,
        };
      }

      // Inject the fresh AppState (generated by email/password login) into AuthManager
      // so that SessionManager.saveSession() and MiraiTransport.restart() use it.
      this.auth.injectCredentials({
        accountId,
        appState:  result.appState,
        loadedAt:  new Date(),
      });

      log.info(
        `[${accountId}] Stage 2 (Email/Password): success. ` +
        `cookies=${result.appState.length} durationMs=${durationMs}`
      );
      return { stage: AuthStage.EMAIL_PASSWORD, success: true, durationMs };

    } catch (err: unknown) {
      const durationMs   = Date.now() - start;
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(
        `[${accountId}] Stage 2 (Email/Password): threw unexpectedly. ` +
        `durationMs=${durationMs}`
      );
      return {
        stage:         AuthStage.EMAIL_PASSWORD,
        success:       false,
        failureReason: AuthFailureReason.UNKNOWN,
        errorMessage,
        durationMs,
      };
    }
  }

  // ── Session persistence ───────────────────────────────────────────────────

  private async trySaveSession(accountId: string): Promise<boolean> {
    try {
      await this.session.saveSession(accountId);
      return true;
    } catch (err: unknown) {
      log.warn(
        `[${accountId}] Failed to persist session after successful auth.`,
        { error: err instanceof Error ? err.message : String(err) },
      );
      return false;
    }
  }

  // ── Reporting ─────────────────────────────────────────────────────────────

  /**
   * Generates a human-readable authentication report.
   * Safe to log — never contains passwords or raw cookie values.
   */
  static formatReport(result: AuthPipelineResult): string {
    const sep   = "─".repeat(52);
    const lines = [
      sep,
      "  Auth Pipeline Report",
      sep,
      `  Account          : ${result.accountId}`,
      `  Success          : ${result.success ? "YES" : "NO"}`,
      `  Stage used       : ${result.stageUsed ?? "none"}`,
      `  Fresh AppState   : ${result.freshAppStateGenerated ? "YES (email/password)" : "no (AppState reused)"}`,
      `  Cookies          : ${result.freshAppState?.length ?? "—"}`,
      `  Session saved    : ${result.sessionSaved ? "YES" : "NO"}`,
      "  Stages:",
    ];

    for (const s of result.stages) {
      const icon = s.success ? "  OK" : "  FAIL";
      if (s.success) {
        lines.push(`${icon}  ${s.stage.padEnd(14)} ${s.durationMs}ms`);
      } else {
        const detail = s.errorMessage
          ? s.errorMessage.slice(0, 80)
          : "no detail";
        lines.push(
          `${icon}  ${s.stage.padEnd(14)} ${s.failureReason ?? "?"} — ${detail} (${s.durationMs}ms)`
        );
      }
    }

    if (!result.success && result.errorMessage) {
      lines.push(`  Error            : ${result.errorMessage}`);
    }
    lines.push(sep);
    return lines.join("\n");
  }

  /**
   * Returns actionable remediation advice for a failed pipeline result.
   * Emitted as a WARN/ERROR log by bootstrapAuth after total failure.
   */
  static remediationAdvice(result: AuthPipelineResult): string {
    if (result.success) return "";
    const last = result.stages[result.stages.length - 1];
    switch (last?.failureReason) {
      case AuthFailureReason.APPSTATE_EXPIRED:
        return "AppState cookies expired. Export fresh cookies from a browser and update FB_APPSTATE.";
      case AuthFailureReason.APPSTATE_MISSING:
        return "FB_APPSTATE is not set. Configure it in the Railway environment variables.";
      case AuthFailureReason.APPSTATE_CORRUPTED:
        return "FB_APPSTATE is not valid JSON. Re-export the cookies and update the variable.";
      case AuthFailureReason.CREDENTIAL_MISSING:
        return "Email/password fallback not configured. Set FB_EMAIL and FB_PASSWORD.";
      case AuthFailureReason.CREDENTIAL_INVALID:
        return "Email or password is incorrect. Verify FB_EMAIL / FB_PASSWORD.";
      case AuthFailureReason.CHECKPOINT:
        return "Facebook requires a checkpoint. Log in from a browser, solve it, then update FB_APPSTATE.";
      case AuthFailureReason.TWO_FACTOR_AUTH:
        return "Facebook requires 2FA. Disable it on the account or approve from a trusted device.";
      case AuthFailureReason.ACCOUNT_RESTRICTED:
        return "The Facebook account is suspended or restricted. Manual review required.";
      case AuthFailureReason.NETWORK_FAILURE:
        return "Network error. Check connectivity — the bot will retry on the next reconnect cycle.";
      case AuthFailureReason.FACEBOOK_TEMPORARY_ERROR:
        return "Facebook returned a temporary error. The bot will retry automatically.";
      default:
        return "Unknown error. Check the stage logs above for details.";
    }
  }
}

// ─── AppState error classifier ────────────────────────────────────────────────

function classifyAppStateError(error: string): AuthFailureReason {
  const lower = error.toLowerCase();

  if (
    lower.includes("not set")     || lower.includes("environment variable") ||
    lower.includes("not found")   && lower.includes("file") ||
    lower.includes("missing required cookie")
  ) return AuthFailureReason.APPSTATE_MISSING;

  if (
    lower.includes("expired")             ||
    lower.includes("appstate die")        ||
    lower.includes("c_user/i_user cookie not found") ||
    lower.includes("fb_appstate expired")
  ) return AuthFailureReason.APPSTATE_EXPIRED;

  if (
    lower.includes("corrupted") || lower.includes("invalid json") ||
    lower.includes("not valid json") || lower.includes("must be a json array")
  ) return AuthFailureReason.APPSTATE_CORRUPTED;

  if (lower.includes("checkpoint")) return AuthFailureReason.CHECKPOINT;

  if (
    lower.includes("network") || lower.includes("timeout") ||
    lower.includes("econnrefused") || lower.includes("enotfound")
  ) return AuthFailureReason.NETWORK_FAILURE;

  return AuthFailureReason.UNKNOWN;
}
