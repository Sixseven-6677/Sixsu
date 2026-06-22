import fs from "fs";
import { AppState, AppStateCookie, IAuthProvider } from "./types/IAuth";
import { LoggerManager } from "../../logger/LoggerManager";

const log = LoggerManager.getLogger("AppStateProvider");

const REQUIRED_COOKIES = ["c_user", "xs"];

type ProviderOptions =
  | { fromEnv: string }
  | { fromFile: string };

export class AppStateProvider implements IAuthProvider {
  private readonly source: "env" | "file";
  private readonly value: string;

  constructor(opts: ProviderOptions) {
    if ("fromEnv" in opts) {
      this.source = "env";
      this.value  = opts.fromEnv;
    } else {
      this.source = "file";
      this.value  = opts.fromFile;
    }
  }

  async load(): Promise<AppState> {
    let raw: string;

    if (this.source === "env") {
      log.info("Loading appstate from environment variable.");
      raw = AppStateProvider.decodeEnvValue(this.value);
    } else {
      log.info(`Loading appstate from file: ${this.value}`);
      if (!fs.existsSync(this.value)) {
        throw new Error(`AppState file not found: ${this.value}`);
      }
      raw = fs.readFileSync(this.value, "utf8");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        "AppState is not valid JSON. " +
        "Env var must be Base64-encoded JSON or a plain JSON array."
      );
    }

    if (!Array.isArray(parsed)) {
      throw new Error("AppState must be a JSON array of cookie objects.");
    }

    const appState = parsed as AppStateCookie[];

    if (!this.validate(appState)) {
      const found = appState.map((c) => c.key).join(", ") || "(none)";
      throw new Error(
        `AppState is missing required cookies: ${REQUIRED_COOKIES.join(", ")}. ` +
        `Found keys: ${found}`
      );
    }

    log.info(`AppState loaded. cookies=${appState.length}`);
    return appState;
  }

  validate(appState: AppState): boolean {
    const keys = new Set(appState.map((c) => c.key));
    return REQUIRED_COOKIES.every((k) => keys.has(k));
  }

  /**
   * Decodes an env-var value that may be in one of two formats:
   *
   *   1. Base64-encoded JSON (preferred):
   *        FB_APPSTATE = Buffer.from(JSON.stringify(cookies)).toString('base64')
   *
   *   2. Plain JSON string (legacy / fallback):
   *        FB_APPSTATE = JSON.stringify(cookies)
   *
   * Strategy: attempt a base64 decode and verify the result is parseable JSON.
   * If that succeeds, return the decoded string; otherwise return the original
   * value unchanged (plain JSON path).
   */
  static decodeEnvValue(value: string): string {
    try {
      const decoded = Buffer.from(value, "base64").toString("utf8");
      JSON.parse(decoded); // throws if not valid JSON
      log.debug("AppStateProvider: env value decoded from Base64.");
      return decoded;
    } catch {
      log.debug("AppStateProvider: env value is plain JSON (not Base64).");
      return value;
    }
  }
}
