---
name: memory-engine
description: Layered, evidence-aware and privacy-safe memory orchestration for BLAXIN.
---

# BLAXIN Memory Engine

## Mission
Manage useful long-term and task-specific memory without turning raw conversation or secrets into permanent memory.

## Memory Layers
JARVIS MEMORY:
- stable preferences
- communication preferences
- durable goals
- long-term context

AGENT EXECUTION MEMORY:
- task outcomes
- successful procedures
- execution observations
- useful environment facts

MISSION STATE:
- current mission
- checkpoints
- pending/completed steps

PROCEDURAL MEMORY:
- reusable workflows
- verified task procedures

FAILURE MEMORY:
- failures
- causes
- recovery strategies
- recurrence patterns

ENVIRONMENT MEMORY:
- stable computer/browser/tool capabilities

SECRET STORE:
- credentials
- tokens
- private keys
- authentication material

Secrets must never be treated as normal memory.

## Memory Write Policy
Before writing memory:
1. classify information
2. check sensitivity
3. determine whether it has durable value
4. remove unnecessary raw content
5. redact secrets
6. attach provenance
7. store only the minimum necessary information

## Provenance
Useful memory should record where it came from and when it was observed.

Do not treat unsupported inference as established fact.

## Retrieval
Retrieve only memory relevant to the current task.

Prefer:
- recent verified facts
- successful procedures
- current mission state

Avoid injecting unrelated history into model context.

## Contradictions
When memories conflict:
- prefer newer verified evidence
- lower confidence in unsupported information
- re-observe environment when necessary

## Forgetting
Support deletion or invalidation of obsolete memory.

## Hard Rules
Never store passwords, tokens, cookies or private keys as ordinary memory.
Never persist unnecessary raw conversation/tool dumps.
Prefer minimal useful memory over maximal storage.
