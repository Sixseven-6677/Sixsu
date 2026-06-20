import {
  ICredentialLoader,
  LoadResult,
  CredentialSource,
} from "./types/ICredential";
import { LoggerManager } from "../logger/LoggerManager";

const log = LoggerManager.getLogger("CredentialManager");

export class CredentialManager {
  private readonly loaders: ICredentialLoader[];
  private cachedResult:     LoadResult | null = null;

  constructor(loaders: ICredentialLoader[]) {
    this.loaders = loaders;
  }

  async load(forceReload = false): Promise<LoadResult> {
    if (this.cachedResult && !forceReload) {
      return this.cachedResult;
    }

    for (const loader of this.loaders) {
      let canLoad: boolean;
      try { canLoad = await loader.canLoad(); } catch { canLoad = false; }
      if (!canLoad) continue;

      log.info(`CredentialManager: trying loader "${loader.name}".`);

      let result: LoadResult;
      try {
        result = await loader.load();
      } catch (err: unknown) {
        result = {
          success: false, credentials: [],
          source: CredentialSource.UNKNOWN,
          error: err instanceof Error ? err.message : String(err),
        };
      }

      if (result.success) {
        log.info(`CredentialManager: loader "${loader.name}" succeeded — ${result.credentials.length} credential(s).`);
        this.cachedResult = result;
        return result;
      }
      log.warn(`CredentialManager: loader "${loader.name}" failed — ${result.error ?? "unknown"}.`);
    }

    return { success: false, credentials: [], source: CredentialSource.UNKNOWN, error: "No credential loader succeeded." };
  }

  invalidate(): void { this.cachedResult = null; }
}
