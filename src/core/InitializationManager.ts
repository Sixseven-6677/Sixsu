import { ISystem } from "./interfaces/ISystem";

export class InitializationManager {
  private readonly registered: Map<string, ISystem> = new Map();

  register(system: ISystem): void {
    if (this.registered.has(system.name)) {
      throw new Error(`System already registered: "${system.name}"`);
    }
    this.registered.set(system.name, system);
  }

  resolve(): ISystem[] {
    const resolved: ISystem[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const visit = (name: string): void => {
      if (visited.has(name)) return;

      if (visiting.has(name)) {
        throw new Error(`Circular dependency detected involving: "${name}"`);
      }

      const system = this.registered.get(name);
      if (!system) {
        throw new Error(`Unknown system dependency: "${name}"`);
      }

      visiting.add(name);

      for (const dep of system.dependencies ?? []) {
        visit(dep);
      }

      visiting.delete(name);
      visited.add(name);
      resolved.push(system);
    };

    for (const name of this.registered.keys()) {
      visit(name);
    }

    return resolved;
  }

  has(name: string): boolean {
    return this.registered.has(name);
  }
}
