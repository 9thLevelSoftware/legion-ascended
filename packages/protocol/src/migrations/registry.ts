import { legionProtocol010To020 } from "./legion-0-2-0.js";
import { legionProtocol020To030 } from "./legion-0-3-0.js";
import type { ProtocolMigration } from "./index.js";

/**
 * Every migration Legion ships, in the order they chain.
 *
 * This list used to live in `legion-0-2-0.ts`, which was tolerable while that
 * was the only migration and became backwards the moment a second existed: a
 * file named for its target version cannot import its own successor. It lives
 * here so each migration file knows only about itself, and the barrel re-exports
 * the name so `@legion/protocol` consumers see no change.
 *
 * `findProtocolMigrationPath` chains these, so a 0.1.0 record reaches 0.3.0 by
 * applying both in order with nothing further to declare. `registerMigration`
 * refuses a second migration on the same `from -> to` pair, which is why each
 * hop dispatches on `record.kind` internally rather than being split per entity.
 */
export const LEGION_PROTOCOL_MIGRATIONS: readonly ProtocolMigration[] = [
  legionProtocol010To020,
  legionProtocol020To030
];
