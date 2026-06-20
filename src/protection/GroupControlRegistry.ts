/**
 * GroupControlRegistry
 *
 * Holds the muted-group set and per-thread last-activity timestamps.
 * Converted from module-level variables to a class instance.
 *
 * Used by:
 *   • groupMuteMiddleware — silently block commands from muted threads
 *   • ControlPlugin       — reads/writes mute state and activity
 *
 * Backward-compatible: all exported function signatures are preserved.
 */

class GroupControlRegistryImpl {
  private readonly _mutedThreads = new Set<string>();
  private readonly _lastActivity = new Map<string, number>();

  mute(id: string):         void    { this._mutedThreads.add(id); }
  unmute(id: string):       void    { this._mutedThreads.delete(id); }
  isMuted(id: string):      boolean { return this._mutedThreads.has(id); }
  getMuted(): ReadonlySet<string>   { return this._mutedThreads; }

  recordActivity(id: string): void    { this._lastActivity.set(id, Date.now()); }
  getLastActivity(id: string): number { return this._lastActivity.get(id) ?? 0; }
}

const _registry = new GroupControlRegistryImpl();

// ─── Backward-compatible exports ──────────────────────────────────────────────

export function muteThread(id: string):   void { _registry.mute(id); }
export function unmuteThread(id: string): void { _registry.unmute(id); }
export function isMuted(id: string):   boolean { return _registry.isMuted(id); }
export function getMutedThreads(): ReadonlySet<string> { return _registry.getMuted(); }

export function recordActivity(id: string):    void { _registry.recordActivity(id); }
export function getLastActivity(id: string): number { return _registry.getLastActivity(id); }
