/**
 * bootstrapStores
 *
 * Creates the in-memory stores (BanStore, LockdownStore, AdminStore) and the
 * UserService. MongoDB repository wiring happens in bootstrapPlugins after the
 * Bot lifecycle has started.
 */
import { CacheManager }  from "../cache/CacheManager";
import { BanStore }       from "../middleware/built-in/banned.middleware";
import { LockdownStore }  from "../middleware/built-in/lockdown.middleware";
import { AdminStore }     from "../middleware/built-in/admin-store";
import { UserRepository } from "../database/repositories/user.repository";
import { UserService }    from "../users/UserService";
import { LoggerManager }  from "../logger/LoggerManager";

const log = LoggerManager.getLogger("Boot.Stores");

export interface StoresBootstrap {
  banStore:     BanStore;
  lockdownStore: LockdownStore;
  adminStore:   AdminStore;
  userSvc:      UserService;
}

export function bootstrapStores(adminIds: string[], cache: CacheManager): StoresBootstrap {
  const banStore      = new BanStore();
  const lockdownStore = new LockdownStore();
  const adminStore    = new AdminStore(adminIds);
  log.info("Stores: AdminStore ready.", { adminCount: adminStore.size() });

  const userRepo = new UserRepository();
  const userSvc  = new UserService(userRepo, cache.store("users"));

  return { banStore, lockdownStore, adminStore, userSvc };
}
