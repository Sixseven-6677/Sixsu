import fs   from "fs";
import path from "path";
import { CryptoHelper }                from "../auth/CryptoHelper";
import { SessionFile, SessionEntry }   from "./types/ISession";
import { LoggerManager }               from "../../logger/LoggerManager";

const log           = LoggerManager.getLogger("SessionStore");
const STORE_VERSION = 1;

export class SessionStore {
  private readonly filePath:      string;
  private readonly encryptionKey: string;

  constructor(filePath: string, encryptionKey: string) {
    this.filePath      = filePath;
    this.encryptionKey = encryptionKey;
    this.ensureDir();
  }

  async save(entry: SessionEntry): Promise<void> {
    const file           = this.readRaw();
    const encryptedState = await CryptoHelper.encrypt(
      entry.encryptedAppState,
      this.encryptionKey
    );

    file.sessions[entry.accountId] = { ...entry, encryptedAppState: encryptedState };
    file.updatedAt = new Date().toISOString();

    this.writeRaw(file);
    log.info(`Session saved for account: ${entry.accountId}`);
  }

  async load(accountId: string): Promise<SessionEntry | null> {
    const file  = this.readRaw();
    const entry = file.sessions[accountId];
    if (!entry) return null;

    let decrypted: string;
    try {
      decrypted = await CryptoHelper.decrypt(entry.encryptedAppState, this.encryptionKey);
    } catch (err) {
      log.error(`Failed to decrypt session for "${accountId}".`, err);
      return null;
    }

    return { ...entry, encryptedAppState: decrypted };
  }

  delete(accountId: string): boolean {
    const file = this.readRaw();
    if (!file.sessions[accountId]) return false;

    delete file.sessions[accountId];
    file.updatedAt = new Date().toISOString();
    this.writeRaw(file);

    log.info(`Session deleted for account: ${accountId}`);
    return true;
  }

  listAccounts(): string[] {
    return Object.keys(this.readRaw().sessions);
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
      log.error("Session store corrupted. Starting fresh.", err);
      return { version: STORE_VERSION, updatedAt: new Date().toISOString(), sessions: {} };
    }
  }

  private writeRaw(file: SessionFile): void {
    fs.writeFileSync(this.filePath, JSON.stringify(file, null, 2), "utf8");
  }
}
