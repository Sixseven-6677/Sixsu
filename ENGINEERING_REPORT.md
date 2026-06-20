# Sixsu — Engineering Review & Architectural Analysis
**Date:** 2026-06-20  
**Reviewer:** Automated deep-read of 158 source files  
**Scope:** Full codebase — `Sixseven-6677/Sixsu`  

---

## 0. Executive Summary

The bot is functionally complete and delivers value. The persistence layer is modern (MongoDB + Mongoose repositories), the command pipeline is clean, and the context/role system is well-designed. However, the codebase carries five categories of structural debt that, if left unaddressed, will increase crash frequency and make every future feature progressively harder to ship:

| Category | Count | Severity |
|---|---|---|
| Dead code / unreachable files | 7 files | Medium |
| Module-level global singletons | 4 hotspots | High |
| God file (all wiring in one place) | 1 (index.ts 25 KB) | High |
| Duplicated FCA helper wrappers | 2+ plugin pairs | Medium |
| Dual-persistence remnants (file + Mongo) | 3 stores | Low (migration done) |

No changes have been made to the codebase. This document is the basis for all refactoring decisions.

---

## 1. Repository Map

```
src/
├── index.ts              ← 25 KB GOD FILE — all wiring
├── app.ts                ← thin Express bootstrap (1.3 KB)
├── cache/                ← CacheManager, CacheStore (generic TTL cache)
├── commands/             ← CommandPipeline, CommandRegistry, ICommand
├── config/               ← env.ts (Zod-validated env)
├── context/              ← ContextBuilder, Context, types
├── core/                 ← Bot.ts + lifecycle helpers
├── database/
│   ├── DatabaseManager.ts
│   ├── migration.ts      ← one-time JSON→MongoDB migration
│   ├── models/           ← 7 Mongoose models
│   └── repositories/     ← 8 repositories (BaseRepository + 7 domain)
├── errors/               ← ErrorReporter + typed error hierarchy
├── facebook/
│   ├── FacebookGateway.ts       ← ACTIVE: FCA event pump
│   ├── FacebookConnection.ts    ← ACTIVE: connection state machine
│   ├── FacebookEventNormalizer.ts ← ACTIVE: raw→typed event
│   ├── HumanBehaviorSender.ts   ← ACTIVE: jitter-delay anti-detection
│   ├── FacebookClient.ts        ← DEAD: Graph API, unused
│   ├── FacebookSender.ts        ← DEAD: Graph API, unused
│   ├── MessengerPoller.ts       ← DEAD: old fca-unofficial polling loop
│   ├── auth/                    ← AuthManager, AppStateProvider, SessionManager
│   ├── cookie/                  ← CookieSender, CookieHttpClient  ← DEAD
│   ├── mirai/                   ← MiraiTransport, MiraiSender  ← ACTIVE
│   └── reconnect/               ← ReconnectManager
├── handlers/
│   ├── message.handler.ts   ← GLOBAL STATE: set*/get* singleton pattern
│   └── group.handler.ts
├── logger/               ← LoggerManager (pino-based)
├── middleware/           ← IMiddleware + toMiddlewareFn adapter
├── plugins/
│   ├── PluginManager.ts
│   ├── PluginLoader.ts
│   ├── PluginContext.ts  ← dependency bag for plugins
│   └── definitions/     ← 14 plugins + _keep.ts stub
│       ├── addmember/   ├── admin/     ├── badeia/
│       ├── black/       ├── commands/  ├── control/
│       ├── kick/        ├── lockdown/  ├── management/
│       ├── music/       ├── owner/     ├── qroubat/
│       ├── requests/    └── uptime/
├── prefix/              ← PrefixStore ← GLOBAL SINGLETON
├── protection/          ← ProtectionRegistry ← GLOBAL SINGLETON
├── routes/              ← Express health/webhook routes
├── scheduler/           ← TaskScheduler, RecurringTask, DelayedTask
├── security/
│   ├── CredentialManager.ts   ← DEAD: no imports found
│   └── CredentialGuard.ts     ← DEAD: no imports found
├── types/               ← shared TS interfaces
├── ui/                  ← BotUI.ts (brand constants, toBold helper)
└── users/               ← UserService, IUserService
```

**Total plugin definitions:** 14 plugins across ~120 KB of plugin code  
**Total models:** 7 (ban, black-config, bot-config, botadmin, command-stats, group-settings, user)  
**Total repositories:** 8 (BaseRepository + 7 domain repos)

---

## 2. Dead Code Inventory

These files are confirmed dead — they are not imported by any active code path in `src/`.

### 2.1 `src/facebook/FacebookClient.ts` (908 B)
- **What it does:** Wraps the Facebook Graph API (`/me/messages`) with axios.
- **Why dead:** The bot uses FCA (cookie-based unofficial API) via `MiraiTransport`, not the Graph API. This class is never imported.
- **Action:** Delete.

### 2.2 `src/facebook/FacebookSender.ts` (954 B)
- **What it does:** Implements `ISender` using `FacebookClient` (Graph API POST).
- **Why dead:** Same reason as above. `MiraiSender` is the active `ISender` implementation.
- **Action:** Delete.

### 2.3 `src/facebook/MessengerPoller.ts`
- **What it does:** A polling loop using the old `fca-unofficial` package (not `@dongdev/fca-unofficial`).
- **Why dead:** Production uses `MiraiTransport` (MQTT/WebSocket). This poller is wired to the wrong FCA fork and is not connected to the event pipeline.
- **Action:** Delete.

### 2.4 `src/facebook/cookie/CookieSender.ts`
- **What it does:** Sends messages via cookie-authenticated HTTP calls.
- **Why dead:** Not imported. The production sender is `MiraiSender → MiraiTransport`.
- **Action:** Delete.

### 2.5 `src/facebook/cookie/CookieHttpClient.ts`
- **What it does:** HTTP client for cookie-based requests.
- **Why dead:** Only consumed by `CookieSender`, which is also dead.
- **Action:** Delete.

### 2.6 `src/security/CredentialManager.ts`
- **What it does:** Aggregates credential loaders with 5-minute TTL cache and placeholder-pattern detection (e.g. rejects `"YOUR_TOKEN_HERE"`).
- **Why dead:** Zero imports found in `src/`. The concept is sound but the implementation was abandoned when the project moved to `config/env.ts` (Zod-validated env).
- **Action:** Delete (concepts already covered by `env.ts` validation).

### 2.7 `src/security/CredentialGuard.ts`
- **What it does:** Validates that no credential matches known placeholder patterns via regex.
- **Why dead:** Same as `CredentialManager.ts` — no imports.
- **Action:** Delete.

### 2.8 `src/plugins/definitions/_keep.ts` (83 B)
- **What it does:** Empty stub to keep the directory in git.
- **Action:** Delete once real plugins exist in the directory (already the case).

---

## 3. Global State / Module-Level Singletons

These are the highest-risk items. Module-level singletons survive process restarts only if the process stays alive, meaning any crash wipes them. They also make testing impossible and create hidden coupling.

### 3.1 `src/handlers/message.handler.ts` — set*/get* pattern

```typescript
// Current pattern (approximate):
let _sender: ISender | null = null;
let _pipeline: CommandPipeline | null = null;

export function setSender(s: ISender) { _sender = s; }
export function getSender() { return _sender!; }
// … repeated for pipeline, contextBuilder, etc.
```

**Problem:** These are effectively global mutable variables. Any module that imports `getSender()` gets the same object and any mutation is invisible to callers.  
**Fix:** Convert to a class `MessageHandler` that receives its dependencies via constructor injection, then wire it in `index.ts`.

### 3.2 `src/protection/ProtectionRegistry.ts` — module-level Map

```typescript
// Current (approximate):
const registry = new Map<string, ProtectionState>();
export function setProtection(threadId, state) { registry.set(threadId, state); }
export function getProtection(threadId) { return registry.get(threadId); }
```

**Problem:** Shared across the entire process. The `management` plugin already persists to MongoDB on every state change — the in-memory Map is only a local cache. But because it is module-level, it cannot be garbage-collected or isolated per bot instance.  
**Fix:** Expose `ProtectionRegistry` as a class instantiated once in `index.ts` and injected into `PluginContext`. The `management` plugin already receives `PluginContext` — no interface change required.

### 3.3 `src/plugins/definitions/control/` — GroupControlRegistry

- Same pattern as ProtectionRegistry: a module-level Map tracking muted threads and the list of threads the bot is in.
- **Fix:** Same approach — class + constructor injection.

### 3.4 `src/prefix/PrefixStore.ts` — module-level singleton

- Stores the command prefix as a module-level variable.
- Already backed by `bot-config` MongoDB model via `BotConfigRepository`.
- **Fix:** The `PrefixStore` is already small; wrapping it in a class and injecting it is straightforward.

---

## 4. The God File: `src/index.ts` (25 KB)

`index.ts` currently does all of the following in sequence:

1. Env validation (`config/env.ts`)
2. Logger setup
3. MongoDB connection (`DatabaseManager`)
4. One-time migration (`runMigrationIfNeeded`)
5. Repository instantiation (8 repositories)
6. Service instantiation (UserService, AdminStore, BanStore, LockdownStore, PrefixStore)
7. FCA session bootstrap (`AuthManager`, `AppStateProvider`, `SessionManager`)
8. Transport creation (`MiraiTransport`, `MiraiSender`, `HumanBehaviorSender`)
9. Context builder wiring (`ContextBuilder.setOwnerIds`, `ContextBuilder.setAdminStore`)
10. Middleware pipeline assembly (banned, lockdown, admin-only)
11. Plugin registration (14 plugins via `PluginLoader`)
12. Event handler registration (`FacebookGateway`, `FcaEventAdapter`)
13. Reconnect logic (`ReconnectManager`)
14. Express server startup

**Problem:** A 25 KB bootstrap function is untestable, unreadable, and breaks the Single Responsibility Principle. Any exception in step N leaves steps N+1..14 partially initialized with no cleanup.

**Proposed decomposition:**
```
src/
├── bootstrap/
│   ├── bootstrapDatabase.ts     ← steps 3-4
│   ├── bootstrapRepositories.ts ← step 5
│   ├── bootstrapServices.ts     ← step 6
│   ├── bootstrapFacebook.ts     ← steps 7-9
│   ├── bootstrapPipeline.ts     ← step 10
│   ├── bootstrapPlugins.ts      ← step 11
│   └── bootstrapServer.ts       ← steps 12-14
└── index.ts                     ← orchestrator: calls bootstrap/* in order
```
Each bootstrap module returns a typed result object and is independently testable.

---

## 5. Dual Persistence Remnants

Three stores maintain both file-based and MongoDB persistence:

| Store | File | MongoDB Model |
|---|---|---|
| AdminStore | `data/admin-store.json` | `botadmin` |
| BanStore | `data/bans.json` | `ban` |
| LockdownStore | `data/lockdown.json` | `group-settings.lockdown` |

`migration.ts` performs a one-time copy from JSON files to MongoDB, stamped with `data/.migration-done`. **After the migration runs, the JSON files are no longer the source of truth.** However, the store implementations still maintain file writes as a fallback.

**Problem:** File writes on Railway's ephemeral filesystem are silently lost on redeploy. Any data written to `data/*.json` after deployment is gone on the next restart. MongoDB should be the only persistence.

**Action:** After confirming migration ran (`data/.migration-done` exists), remove the file-write code paths from AdminStore, BanStore, and LockdownStore. Read-at-startup from MongoDB; write to MongoDB only.

---

## 6. Duplicated FCA Helper Wrappers

Both `src/plugins/definitions/admin/index.ts` and `src/plugins/definitions/management/index.ts` independently define Promise wrappers around FCA callback-based methods:

```typescript
// In admin/index.ts:
function fetchThreadInfo(api, threadId): Promise<ThreadInfo> { ... }
function setAdminStatus(api, threadId, userId, isAdmin): Promise<void> { ... }

// In management/index.ts — near-identical implementations:
function fetchThreadInfo(api, threadId): Promise<ThreadInfo> { ... }
```

**Action:** Extract to `src/facebook/fcaHelpers.ts` (or `src/facebook/api-helpers/`). Import in both plugins. This eliminates 40-60 lines of duplication and ensures any FCA behavior change is fixed in one place.

---

## 7. Architectural Issues (Secondary)

### 7.1 ReconnectManager has no `reconnectInterval` in FCA config

The `reconnectInterval` field present in the `youssfp41-ctrl/Sixsu` fork is absent from this repo's `fca-config`. `ReconnectManager` implements reconnect logic at the application layer, but FCA's own internal keep-alive/reconnect (`reconnectInterval: 3600`) is not set. This means MQTT disconnects (which are the primary `login_blocked` cause) rely entirely on application-layer reconnect, which may be slower than FCA's own reconnect path.

**Action:** Add `reconnectInterval: 3600` to `fca-config.json` (this was the working configuration in the reference fork).

### 7.2 `migration.ts` uses lazy `require()` for circular dep avoidance

```typescript
const getModels = () => ({
  BotConfigModel: require("./models/bot-config.model").BotConfigModel,
  // …
});
```

This was added to avoid circular dependency at startup. While it works, it bypasses TypeScript's type system and produces brittle runtime errors if a model path changes.

**Action:** Break the circular dependency properly by initializing models after `mongoose.connect()` resolves, not at module load time. The `DatabaseManager` already manages connection order — migration should be called only after `DatabaseManager.connect()` returns, passing model references explicitly.

### 7.3 `ContextBuilder` receives `adminStore` post-construction

```typescript
// index.ts (approximate):
const contextBuilder = new ContextBuilder(sender);
contextBuilder.setOwnerIds([...]);
contextBuilder.setAdminStore(adminStore);  // injected after construction
```

The double-injection pattern means there is a window between construction and `setAdminStore` where admin role overrides don't work. For the reconnect path, if `ContextBuilder` is reused across reconnects, `adminStore` injection must be re-verified.

**Action:** Move `ownerIds` and `adminStore` into the constructor signature. Mark them as required parameters.

### 7.4 `PluginContext.scheduleRecurring` — no deduplication guard

`black/index.ts` calls `pCtx.scheduleRecurring(key, ...)` per thread. If the bot reconnects mid-interval, the plugin's `init()` runs again and could schedule a duplicate recurring task under the same key. Whether `TaskScheduler` deduplicates by key is not confirmed.

**Action:** Confirm `TaskScheduler.scheduleRecurring` is idempotent (upserts by key). If not, add a guard.

### 7.5 `requests/index.ts` — fragile tag enumeration

The requests plugin iterates `["PENDING", "SPAM", "OTHER", "ARCHIVED"]` tag names to find pending group invites, with a 14-second timeout per tag. FCA behavior on tag enumeration varies significantly by account type and Facebook state. On accounts that have had MQTT blocked, tag fetches may silently return empty.

**Action:** Add explicit logging when a tag returns 0 results so operators can distinguish "no requests" from "FCA silent failure."

---

## 8. What Is Working Well (Do Not Refactor Without Reason)

| Component | Why It's Good |
|---|---|
| `CommandPipeline.ts` | Clean middleware chain, per-step logging, trace IDs, handles minArgs/maxArgs |
| `ContextBuilder.ts` | Role override hierarchy (owner > admin > user) is correct; fallback user prevents silent drops |
| `BotUI.ts` | Single source of truth for bot messaging style; `toBold()` and category metadata are reused correctly |
| `black/index.ts` | Strong decoupling via `IBlackConfigRepository` and `ISender` interfaces; no direct model imports |
| `management/index.ts` | MongoDB upsert with 3-attempt retry; watchdog for group name/nickname protection is well-isolated |
| `database/repositories/` | `BaseRepository<T>` with typed generics; all 7 repos extend it cleanly |
| `LoggerManager` | Pino-based, structured, consistent across all files (`req.log` in routes, `log` singleton elsewhere) |
| `TaskScheduler` | `RecurringTask` and `DelayedTask` are properly disposable; used by black plugin for per-thread timers |
| `env.ts` | Zod-validated environment — fails fast on missing/invalid config before any DB connection attempt |
| `FacebookEventNormalizer.ts` | Isolates FCA's raw event shape from the rest of the system; single place to fix FCA API drift |

---

## 9. Refactoring Plan (Prioritized)

All items below are ordered by risk-adjusted value. Items marked **[SAFE]** have no behavior change — only structural reorganization.

### Phase 1 — Immediate (low risk, high gain)

| # | Task | Files Affected | Risk |
|---|---|---|---|
| 1.1 | Delete 7 dead files (§2) | 7 files | None |
| 1.2 | Add `reconnectInterval: 3600` to `fca-config.json` | 1 file | Very low |
| 1.3 | Extract FCA helper wrappers → `src/facebook/fcaHelpers.ts` | admin, management plugins + new file | Low |
| 1.4 | Remove file-write paths from AdminStore/BanStore/LockdownStore | 3 store files | Low |

### Phase 2 — Structural (medium risk)

| # | Task | Files Affected | Risk |
|---|---|---|---|
| 2.1 | Convert `ProtectionRegistry` to class + inject via PluginContext | protection/, management plugin | Medium |
| 2.2 | Convert `GroupControlRegistry` to class + inject | control plugin | Medium |
| 2.3 | Convert `PrefixStore` to class + inject | prefix/, CommandPipeline | Low |
| 2.4 | Fix `ContextBuilder` constructor (require ownerIds + adminStore) | context/, index.ts | Low |
| 2.5 | Fix `migration.ts` circular deps — pass models explicitly | database/migration.ts, DatabaseManager | Medium |

### Phase 3 — Architecture (higher risk, requires careful testing)

| # | Task | Files Affected | Risk |
|---|---|---|---|
| 3.1 | Decompose `index.ts` → `bootstrap/` modules | index.ts + 7 new files | High |
| 3.2 | Convert `message.handler.ts` set*/get* → class | message.handler.ts, index.ts | Medium |
| 3.3 | Confirm TaskScheduler key deduplication; add guard if missing | TaskScheduler, black plugin | Low |
| 3.4 | Add tag-fetch logging to requests plugin (§7.5) | requests/index.ts | None |

### Out of Scope (not touched)

- Plugin business logic (command behavior is correct and preserved as-is)
- MongoDB schema / model changes (models are clean)
- Repository implementations (all 8 repos are well-structured)
- Logger, context, command pipeline (already good)
- Authentication / AppState flow (login_blocked is a Facebook-side block, not a code bug)

---

## 10. Login-Blocked Root Cause (Informational)

The recurring `login_blocked` on MQTT is **not a code bug**. Facebook's MQTT layer independently validates session cookies at a higher security level than HTTP. The bot's cookies authenticate HTTP calls successfully but are flagged on the MQTT WebSocket handshake after 1-2 hours. This is a Facebook-side decision based on:

- IP reputation (Railway shared egress IPs)
- Device fingerprint mismatch (bot sends desktop browser fingerprint but behaves differently from a browser)
- Session age and usage patterns

Code-level mitigations already in place:
- `HumanBehaviorSender` adds random jitter delays (anti-pattern detection) ✓
- `ReconnectManager` handles reconnect at application layer ✓
- `AppStateProvider` re-reads cookies on reconnect ✓

Remaining mitigation (not yet applied): `reconnectInterval: 3600` in fca-config (Phase 1, item 1.2).

---

## 11. File-Level Disposition Table

| File | Status | Phase |
|---|---|---|
| `src/index.ts` | Decompose → `bootstrap/` | Phase 3 |
| `src/app.ts` | Keep as-is | — |
| `src/facebook/FacebookClient.ts` | **DELETE** | Phase 1 |
| `src/facebook/FacebookSender.ts` | **DELETE** | Phase 1 |
| `src/facebook/MessengerPoller.ts` | **DELETE** | Phase 1 |
| `src/facebook/cookie/CookieSender.ts` | **DELETE** | Phase 1 |
| `src/facebook/cookie/CookieHttpClient.ts` | **DELETE** | Phase 1 |
| `src/facebook/FacebookGateway.ts` | Keep | — |
| `src/facebook/FacebookConnection.ts` | Keep | — |
| `src/facebook/FacebookEventNormalizer.ts` | Keep | — |
| `src/facebook/HumanBehaviorSender.ts` | Keep | — |
| `src/facebook/mirai/MiraiTransport.ts` | Keep | — |
| `src/facebook/mirai/MiraiSender.ts` | Keep | — |
| `src/facebook/auth/AuthManager.ts` | Keep | — |
| `src/facebook/auth/AppStateProvider.ts` | Keep | — |
| `src/facebook/auth/SessionManager.ts` | Keep | — |
| `src/facebook/reconnect/ReconnectManager.ts` | Keep | — |
| `src/security/CredentialManager.ts` | **DELETE** | Phase 1 |
| `src/security/CredentialGuard.ts` | **DELETE** | Phase 1 |
| `src/handlers/message.handler.ts` | Refactor (class) | Phase 3 |
| `src/handlers/group.handler.ts` | Keep | — |
| `src/protection/ProtectionRegistry.ts` | Refactor (class) | Phase 2 |
| `src/prefix/PrefixStore.ts` | Refactor (class) | Phase 2 |
| `src/context/ContextBuilder.ts` | Fix constructor | Phase 2 |
| `src/context/Context.ts` | Keep | — |
| `src/commands/CommandPipeline.ts` | Keep | — |
| `src/commands/CommandRegistry.ts` | Keep | — |
| `src/database/migration.ts` | Fix circular deps | Phase 2 |
| `src/database/DatabaseManager.ts` | Keep | — |
| `src/database/models/*.ts` (7 files) | Keep | — |
| `src/database/repositories/*.ts` (8 files) | Keep | — |
| `src/plugins/definitions/_keep.ts` | **DELETE** | Phase 1 |
| `src/plugins/definitions/admin/index.ts` | Extract FCA helpers | Phase 1 |
| `src/plugins/definitions/management/index.ts` | Extract FCA helpers | Phase 1 |
| `src/plugins/definitions/black/index.ts` | Keep | — |
| `src/plugins/definitions/control/index.ts` | Refactor registry | Phase 2 |
| `src/plugins/definitions/requests/index.ts` | Add logging | Phase 3 |
| All other plugins (10 files) | Keep | — |
| `src/ui/BotUI.ts` | Keep | — |
| `src/logger/LoggerManager.ts` | Keep | — |
| `src/cache/*.ts` | Keep | — |
| `src/errors/*.ts` | Keep | — |
| `src/scheduler/*.ts` | Keep + confirm deduplication | Phase 3 |
| `src/users/*.ts` | Keep | — |
| `src/config/env.ts` | Keep | — |
| `src/middleware/*.ts` | Keep | — |
| `src/routes/*.ts` | Keep | — |

---

*This report is the required basis for all refactoring changes. No code changes have been made. Implementation follows this document, phase by phase, with explicit authorization before each phase.*
