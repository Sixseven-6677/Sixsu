export class PluginError extends Error {
  constructor(
    readonly pluginName: string,
    message: string,
    readonly cause?: unknown,
  ) {
    super(`[Plugin:${pluginName}] ${message}`);
    this.name = "PluginError";
  }
}

export class PluginNotFoundError extends PluginError {
  constructor(pluginName: string) {
    super(pluginName, `Plugin not found: "${pluginName}".`);
    this.name = "PluginNotFoundError";
  }
}

export class PluginDependencyError extends PluginError {
  constructor(pluginName: string, depName: string) {
    super(
      pluginName,
      `Missing dependency: "${depName}" must be enabled before "${pluginName}".`,
    );
    this.name = "PluginDependencyError";
  }
}

export class PluginStateError extends PluginError {
  constructor(pluginName: string, current: string, desired: string) {
    super(
      pluginName,
      `Invalid state transition: "${current}" → "${desired}" is not allowed.`,
    );
    this.name = "PluginStateError";
  }
}

export class PluginServiceError extends PluginError {
  constructor(pluginName: string, serviceName: string) {
    super(pluginName, `Required service not found: "${serviceName}".`);
    this.name = "PluginServiceError";
  }
}

export class PluginCircularDependencyError extends PluginError {
  constructor(pluginName: string, chain: string[]) {
    super(
      pluginName,
      `Circular dependency detected: ${chain.join(" → ")}.`,
    );
    this.name = "PluginCircularDependencyError";
  }
}
