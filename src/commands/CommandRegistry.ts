import { ICommand } from "./types/ICommand";

export class CommandRegistry {
  private readonly commands = new Map<string, ICommand>();
  private readonly aliases = new Map<string, string>();

  register(command: ICommand): void {
    if (this.commands.has(command.name)) {
      throw new Error(`Command already registered: "${command.name}"`);
    }

    this.commands.set(command.name, command);

    for (const alias of command.aliases ?? []) {
      if (this.aliases.has(alias) || this.commands.has(alias)) {
        throw new Error(
          `Alias "${alias}" conflicts with an existing command or alias.`
        );
      }
      this.aliases.set(alias, command.name);
    }

    console.log(
      `[CommandRegistry] Registered: ${command.name}` +
        (command.aliases?.length
          ? ` (aliases: ${command.aliases.join(", ")})`
          : "")
    );
  }

  unregister(name: string): void {
    const command = this.commands.get(name);
    if (!command) return;

    for (const alias of command.aliases ?? []) {
      this.aliases.delete(alias);
    }

    this.commands.delete(name);
    console.log(`[CommandRegistry] Unregistered: ${name}`);
  }

  resolve(nameOrAlias: string): ICommand | undefined {
    if (this.commands.has(nameOrAlias)) {
      return this.commands.get(nameOrAlias);
    }

    const resolvedName = this.aliases.get(nameOrAlias);
    if (resolvedName) {
      return this.commands.get(resolvedName);
    }

    return undefined;
  }

  has(nameOrAlias: string): boolean {
    return this.commands.has(nameOrAlias) || this.aliases.has(nameOrAlias);
  }

  getAll(): ICommand[] {
    return Array.from(this.commands.values());
  }

  size(): number {
    return this.commands.size;
  }

  clear(): void {
    this.commands.clear();
    this.aliases.clear();
  }
}
