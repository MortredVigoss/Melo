import { syncSchema } from './syncContract.generated.js';
import { validateSchema } from './schemaValidator.js';
const matches = (value, kind) => { try { validateSchema(value,syncSchema.$defs[kind],syncSchema); return true; } catch { return false; } };
export const validSyncID = value => matches(value,'id');
// Legacy reminder messages are immutable identities, never filesystem paths.
// Keep the exception confined to messages, not projects, agents or devices.
export const validMessageID = value => matches(value,'messageId');
