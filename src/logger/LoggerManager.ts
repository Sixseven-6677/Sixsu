import { ILogger, LogLevel } from "./types/ILogger";
import { ITransport } from "./types/ITransport";
import { Logger } from "./Logger";
import { ConsoleTransport } from "./transports/ConsoleTransport";
import { FileTransport } from "./transports/FileTransport";

export interface LoggerOptions {
  level?: LogLevel;
  logDir?: string;
  enableFile?: boolean;
  enableConsole?: boolean;
}

export class LoggerManager {
  private static instance: Logger | null = null;

  static configure(options: LoggerOptions = {}): void {
    const {
      level         = LogLevel.INFO,
      logDir        = "logs",
      enableFile    = true,
      enableConsole = true,
    } = options;

    const transports: ITransport[] = [];

    if (enableConsole) {
      transports.push(new ConsoleTransport());
    }

    if (enableFile) {
      transports.push(new FileTransport({ dir: logDir }));
    }

    LoggerManager.instance = new Logger(transports, level);
  }

  static getLogger(context?: string): ILogger {
    if (!LoggerManager.instance) {
      LoggerManager.configure();
    }
    return context
      ? LoggerManager.instance!.child(context)
      : LoggerManager.instance!;
  }

  static close(): void {
    LoggerManager.instance?.close();
    LoggerManager.instance = null;
  }
}
