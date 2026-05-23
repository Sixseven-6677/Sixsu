import { LoggerManager } from "../logger/LoggerManager";

const log = LoggerManager.getLogger("PluginServiceRegistry");

interface ServiceEntry {
  service: unknown;
  owner:   string;
}

/**
 * Shared service registry for inter-plugin dependency injection.
 * Plugins provide services; other plugins consume them by name.
 */
export class PluginServiceRegistry {
  private readonly services = new Map<string, ServiceEntry>();

  provide<T>(name: string, service: T, owner: string): () => void {
    if (this.services.has(name)) {
      const existing = this.services.get(name)!;
      log.warn(
        `Service "${name}" already registered by plugin "${existing.owner}". ` +
        `Overriding with registration from plugin "${owner}".`
      );
    }

    this.services.set(name, { service, owner });
    log.info(`Service registered: "${name}" by plugin "${owner}".`);

    return () => {
      const current = this.services.get(name);
      if (current?.owner === owner) {
        this.services.delete(name);
        log.info(`Service unregistered: "${name}" (owner: "${owner}").`);
      }
    };
  }

  consume<T>(name: string): T | undefined {
    return this.services.get(name)?.service as T | undefined;
  }

  has(name: string): boolean {
    return this.services.has(name);
  }

  listByOwner(owner: string): string[] {
    const result: string[] = [];
    for (const [name, entry] of this.services) {
      if (entry.owner === owner) result.push(name);
    }
    return result;
  }

  removeByOwner(owner: string): void {
    for (const [name, entry] of this.services) {
      if (entry.owner === owner) {
        this.services.delete(name);
        log.info(`Service removed: "${name}" (owner: "${owner}").`);
      }
    }
  }
}
