import fs   from "fs";
import path from "path";
import { AppState, AppStateCookie, IAuthProvider } from "./types/IAuth";
import { CryptoHelper }                            from "./CryptoHelper";
import { LoggerManager }                           from "../../logger/LoggerManager";

const log = LoggerManager.getLogger("FileWatchAppStateProvider");

const REQUIRED_COOKIES = ["c_user", "xs"];

/** Marker prefix written to disk once the file's content has been encrypted. */
const ENCRYPTED_PREFIX = "ENC1:";

/** Debounce window for fs.watch — editors/operators often fire multiple events per save. */
const DEBOUNCE_MS = 500;

export type FileWatchChangeHandler = () => void | Promise<void>;

export interface FileWatchAppStateProviderOptions {
  /** Path to the single "state file" containing the AppState cookie JSON. */
  filePath: string;
  /**
   * Encryption key used to protect the file at rest (AES-256-GCM via CryptoHelper).
   * When set, a plaintext file is transparently encrypted in place on first read.
   * When empty, the file is stored as plaintext (legacy/local-dev only).
   */
  encryptionKey?: string;
}

/**
 * FileWatchAppStateProvider — "single state file" AppState provider.
 *
 * Ports Nejin's file-as-state simplicity (one file holds the live session,
 * `fs.watch` detects manual edits, auto re-login on change) into Sixsu's
 * layered auth architecture:
 *
 *  - Implements IAuthProvider like AppStateProvider / EmailPasswordProvider,
 *    so it plugs into AuthManager / AuthPipeline / ReconnectManager with
 *    zero changes to those layers.
 *  - Unlike Nejin's original account.txt, the file is encrypted at rest
 *    (AES-256-GCM, same CryptoHelper used by SessionStore) whenever an
 *    encryption key is configured — closing the "public repo leaks live
 *    cookies" gap found in Xanga / Goatbot-updated.
 *  - Exposes onChange()/startWatching() so bootstrap code can trigger
 *    auth.login() + sessionManager.saveSession() + reconnect.resetCircuit()
 *    whenever an operator manually updates the file with fresh cookies.
 */
export class FileWatchAppStateProvider implements IAuthProvider {
  private readonly filePath:      string;
  private readonly encryptionKey: string;

  private watcher:        fs.FSWatcher | null = null;
  private debounceTimer:  NodeJS.Timeout | null = null;
  private lastMtimeMs                        = 0;
  private readonly changeHandlers: FileWatchChangeHandler[] = [];

  constructor(options: FileWatchAppStateProviderOptions) {
    this.filePath      = options.filePath;
    this.encryptionKey = options.encryptionKey ?? "";
  }

  // ── IAuthProvider ─────────────────────────────────────────────────────────

  async load(): Promise<AppState> {
    if (!fs.existsSync(this.filePath)) {
      throw new Error(`AppState watch file not found: ${this.filePath}`);
    }

    const raw  = fs.readFileSync(this.filePath, "utf8").trim();
    const json = await this.decodeContent(raw);

    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error(
        `AppState watch file "${this.filePath}" does not contain valid JSON.`
      );
    }

    if (!Array.isArray(parsed)) {
      throw new Error("AppState must be a JSON array of cookie objects.");
    }

    const appState = parsed as AppStateCookie[];
    if (!this.validate(appState)) {
      const found = appState.map((c) => c.key).join(", ") || "(none)";
      throw new Error(
        `AppState watch file is missing required cookies: ${REQUIRED_COOKIES.join(", ")}. ` +
        `Found keys: ${found}`
      );
    }

    // Transparent upgrade: if the file was plaintext (Nejin-style) and an
    // encryption key is configured, encrypt it in place right now.
    if (this.encryptionKey && !raw.startsWith(ENCRYPTED_PREFIX)) {
      await this.encryptInPlace(json);
    }

    this.lastMtimeMs = this.statMtime();
    log.info(`AppState loaded from watched file. cookies=${appState.length}`);
    return appState;
  }

  validate(appState: AppState): boolean {
    const keys = new Set(appState.map((c) => c.key));
    return REQUIRED_COOKIES.every((k) => keys.has(k));
  }

  // ── Watch lifecycle ──────────────────────────────────────────────────────

  /** Registers a callback fired (debounced) after the watched file is edited on disk. */
  onChange(handler: FileWatchChangeHandler): void {
    this.changeHandlers.push(handler);
  }

  /** Starts watching the file for external edits (operator pastes fresh cookies). */
  startWatching(): void {
    if (this.watcher) return;

    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    if (!fs.existsSync(this.filePath)) {
      log.warn(
        `FileWatchAppStateProvider: cannot watch "${this.filePath}" — file does not exist yet.`
      );
      return;
    }

    try {
      this.watcher = fs.watch(this.filePath, { persistent: true }, (eventType) => {
        if (eventType !== "change" && eventType !== "rename") return;
        this.scheduleChangeCheck();
      });
      log.info(`FileWatchAppStateProvider: watching "${this.filePath}" for changes.`);
    } catch (err: unknown) {
      log.warn(
        `FileWatchAppStateProvider: failed to start fs.watch on "${this.filePath}".`,
        { error: err instanceof Error ? err.message : String(err) },
      );
    }
  }

  stopWatching(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
      log.info("FileWatchAppStateProvider: stopped watching.");
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private scheduleChangeCheck(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;

      const mtime = this.statMtime();
      // Ignore events caused by our own encryptInPlace() write, or duplicate
      // fs events for the same save.
      if (mtime === this.lastMtimeMs) return;
      this.lastMtimeMs = mtime;

      log.info(`FileWatchAppStateProvider: change detected in "${this.filePath}".`);
      for (const handler of this.changeHandlers) {
        Promise.resolve()
          .then(() => handler())
          .catch((err: unknown) => {
            log.error(
              "FileWatchAppStateProvider: onChange handler threw.",
              err instanceof Error ? err : new Error(String(err)),
            );
          });
      }
    }, DEBOUNCE_MS);
  }

  private statMtime(): number {
    try {
      return fs.statSync(this.filePath).mtimeMs;
    } catch {
      return 0;
    }
  }

  private async decodeContent(raw: string): Promise<string> {
    if (!raw.startsWith(ENCRYPTED_PREFIX)) return raw; // plaintext (legacy Nejin-style)

    if (!this.encryptionKey) {
      throw new Error(
        `AppState watch file "${this.filePath}" is encrypted but no encryption key is ` +
        `configured. Set SESSION_SECRET / FB_SESSION_SECRET.`
      );
    }

    const ciphertext = raw.slice(ENCRYPTED_PREFIX.length);
    try {
      return await CryptoHelper.decrypt(ciphertext, this.encryptionKey);
    } catch (err: unknown) {
      throw new Error(
        `Failed to decrypt AppState watch file "${this.filePath}": ` +
        (err instanceof Error ? err.message : String(err))
      );
    }
  }

  private async encryptInPlace(plainJson: string): Promise<void> {
    try {
      const encrypted = await CryptoHelper.encrypt(plainJson, this.encryptionKey);
      fs.writeFileSync(this.filePath, ENCRYPTED_PREFIX + encrypted, "utf8");
      log.info(
        `FileWatchAppStateProvider: encrypted plaintext AppState file "${this.filePath}" in place.`
      );
    } catch (err: unknown) {
      log.warn(
        `FileWatchAppStateProvider: failed to encrypt "${this.filePath}" in place — ` +
        `leaving it as plaintext.`,
        { error: err instanceof Error ? err.message : String(err) },
      );
    }
  }
}
