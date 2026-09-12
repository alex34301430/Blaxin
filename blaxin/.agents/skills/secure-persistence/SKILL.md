---
name: secure-persistence
description: Safe schema-versioned persistence for BLAXIN sessions, missions, memory and audit state.
---

# BLAXIN Secure Persistence

## Mission
Persist useful BLAXIN state while preventing data loss, corruption and secret leakage.

## Separation
Prefer distinct stores for:
- session/context
- mission state
- memory
- audit events
- credentials/secrets

Do not combine all state into one raw conversation JSON.

## Write Pipeline
DATA
→ CLASSIFY
→ REDACT
→ VALIDATE
→ SERIALIZE
→ ATOMIC WRITE
→ VERIFY

## Schema
Every persisted structure should have:
- schema version
- validation
- migration path where needed

## Migration
When schema changes:
1. preserve original
2. validate old state
3. migrate
4. validate migrated state
5. activate new state

If migration fails:
- keep original intact
- use safe fallback
- record non-sensitive diagnostic state

## Atomicity
Avoid partially-written state.

Use temporary file + atomic rename or equivalent mechanism.

## Permissions
Persist sensitive runtime state with restrictive permissions.

## Recovery
A corrupted state file must not permanently prevent BLAXIN from starting.

## Existing Session Security
The known server/.blaxin-state/session.json issue must be treated as a security regression.

Existing unsafe content should be handled through a safe migration/redaction strategy, not blindly ignored.

## Hard Rules
Never persist secrets in normal session/memory state.
Never silently destroy user state.
Never accept malformed persisted state as trusted runtime state.
