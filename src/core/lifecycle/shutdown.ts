import { ISystem } from "../interfaces/ISystem";

export interface ShutdownStep {
  name: string;
  execute(): Promise<void>;
}

export function buildShutdownSteps(
  systems: ISystem[],
  onStep: (name: string) => void
): ShutdownStep[] {
  return [...systems].reverse().map((system) => ({
    name: system.name,
    execute: async () => {
      onStep(system.name);
      await system.destroy();
    },
  }));
}

export async function runShutdownSteps(
  steps: ShutdownStep[],
  timeoutMs = 10_000
): Promise<void> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error("Shutdown timed out after " + timeoutMs + "ms")),
      timeoutMs
    )
  );

  const work = (async () => {
    for (const step of steps) {
      await step.execute();
    }
  })();

  await Promise.race([work, timeout]);
}
