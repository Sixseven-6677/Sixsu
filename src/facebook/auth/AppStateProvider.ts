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
      raw = Buffer.from(this.value, "base64").toString("utf8");
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
      throw new Error("AppState is not valid JSON.");
    }

    if (!Array.isArray(parsed)) {
      throw new Error("AppState must be an array of cookies.");
    }

    const appState = parsed as AppStateCookie[];

    if (!this.validate(appState)) {
      throw new Error(
        `AppState is missing required cookies: ${REQUIRED_COOKIES.join(", ")}`
      );
    }

    log.info(`AppState loaded. Cookies: ${appState.length}`);
    return appState;
  }

  validate(appState: AppState): boolean {
    const keys = new Set(appState.map((c) => c.key));
    return REQUIRED_COOKIES.every((k) => keys.has(k));
  }
}
