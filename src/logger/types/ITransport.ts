import { LogEntry } from "./ILogger";

export interface ITransport {
  readonly name: string;
  write(entry: LogEntry): void;
  close?(): void;
}
