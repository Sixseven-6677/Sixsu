import fs   from "fs";
import path from "path";
import { CryptoHelper }              from "../auth/CryptoHelper";
import { SessionFile, SessionEntry } from "./types/ISession";
import { LoggerManager }             from "../../logger/LoggerManager";

const log           = LoggerManager.getLogger("SessionStore");
const STORE_VERSION = 1;

export class SessionStore {
  private readonly filePath:      string;
  private readonly encryptionKey: string;

  /**
   * Serialises all writes through a promise chain so concurrent save() / delete()
   * calls never interleave their read-modify-write cycles.
   */
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string, encryptionKey: string) {
    this.filePath      = filePath;
    this.encryptionKey = encryptionKey;
    this.ensureDir();
  }

  async save(entry: SessionEntry): Promise<void> {
    this.writeQueue = this.writeQueue.then(() => this.doSave(entry));
    return this.writeQueue;
  }

  async load(accountId: string): Promise<SessionEntry | null> {
    const file  = this.readRaw();
    const entry = file.sessions[accountId];
    if (!entry) return null;

    let decrypted: string;
    try {
      decrypted = await CryptoHelper.decrypt(entry.appStateData, this.encryptionKey);
    } catch (err) {
      log.error(`Failed to decrypt session for "${accountId}".`, err);
      return null;
    }

    return { ...entry, appStateData: decrypted };
  }

  /** Queues a delete; fully serialised through the write queue. */
  delete(accountId: string): void {
    this.writeQueue = this.writeQueue.then(() => this.doDelete(accountId));
  }

  listAccounts(): string[] {
    return Object.keys(this.readRaw().sessions);
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private async doSave(entry: SessionEntry): Promise<void> {
    const file           = this.readRaw();
    const encryptedState = await CryptoHelper.encrypt(
      entry.appStateData,
      this.encryptionKey
    );

    file.sessions[entry.accountId] = { ...entry, appStateData: encryptedState };
    file.updatedAt = new Date().toISOString();

    this.writeRaw(file);
    log.info(`Session saved for account: ${entry.accountId}`);
  }

  private doDelete(accountId: string): void {
    const file = this.readRaw();
    if (!file.sessions[accountId]) return;

    delete file.sessions[accountId];
    file.updatedAt = new Date().toISOString();
    this.writeRaw(file);

    log.info(`Session deleted for account: ${accountId}`);
  }

  private ensureDir(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  private readRaw(): SessionFile {
    if (!fs.existsSync(this.filePath)) {
      return { version: STORE_VERSION, updatedAt: new Date().toISOString(), sessions: {} };
    }
    try {
      return JSON.parse(fs.readFileSync(this.filePath, "utf8")) as SessionFile;
    } catch (err) {
      log.error("Session store file corrupted — starting fresh.", err);
      return { version: STORE_VERSION, updatedAt: new Date().toISOString(), sessions: {} };
    }
  }

  private writeRaw(file: SessionFile): void {
    fs.writeFileSync(this.filePath, JSON.stringify(file, null, 2), "utf8");
  }
}
