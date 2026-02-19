/**
 * Claude State Reducer — backward compatibility shim.
 *
 * The reducer has been moved to core/session-state-reducer.ts since it
 * operates only on core types (SessionState, UnifiedMessage).
 */

export { reduce } from "../../core/session-state-reducer.js";
