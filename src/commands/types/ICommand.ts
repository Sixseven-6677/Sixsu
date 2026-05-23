import { Context } from "../../context/Context";

export type CommandCategory =
  | "general"
  | "admin"
  | "debug"
  | "util"
  | string;

export interface ICommand {
  readonly name:         string;
  readonly aliases?:     string[];
  readonly description?: string;
  readonly usage?:       string;
  readonly category?:    CommandCategory;
  /** Minimum positional args required — pipeline rejects with usage hint if not met. */
  readonly minArgs?:     number;
  /** Maximum positional args allowed — pipeline rejects with usage hint if exceeded. */
  readonly maxArgs?:     number;
  /** Per-command cooldown in ms (overrides global pipeline cooldown if set). */
  readonly cooldownMs?:  number;
  /** If true, only bot admins can run this command. */
  readonly adminOnly?:   boolean;
  /** If true, command is excluded from /help listings. */
  readonly hidden?:      boolean;
  execute(ctx: Context): Promise<void>;
}

export function isValidCommand(obj: unknown): obj is ICommand {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "name" in obj &&
    typeof (obj as ICommand).name === "string" &&
    (obj as ICommand).name.trim().length > 0 &&
    "execute" in obj &&
    typeof (obj as ICommand).execute === "function"
  );
}
