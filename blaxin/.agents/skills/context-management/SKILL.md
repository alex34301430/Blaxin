---
name: context-management
description: Efficient hierarchical context management for Jarvis, BLAXIN Agent and Agency workers.
---

# BLAXIN Context Management

## Mission
Provide each execution component with the smallest sufficient context required for reliable reasoning.

## Context Layers
Maintain separation between:
- current user request
- active mission
- recent execution context
- relevant memory
- environment state
- worker-specific context
- security context

## Context Selection
Before providing context:
1. identify current objective
2. identify required facts
3. retrieve relevant memory
4. remove unrelated history
5. remove secrets
6. preserve important constraints
7. preserve unresolved blockers

## Hierarchy
Jarvis should receive:
- user intent
- priorities
- mission status
- high-level results

Existing BLAXIN Agent should receive:
- execution objective
- required context
- tools
- constraints
- verification requirements

Specialists should receive:
- only task-relevant context
- required evidence
- scoped permissions
- expected output

## Compression
Prefer structured summaries over massive raw transcripts.

Preserve:
- decisions
- constraints
- evidence
- failures
- checkpoints

Discard:
- redundant chatter
- irrelevant history
- duplicate tool output

## Staleness
Environment-dependent context must be revalidated after:
- navigation
- major UI change
- browser context change
- mission pause/resume
- significant elapsed time

## Security
Never include:
- passwords
- tokens
- private keys
- unnecessary credential material

## Hard Rules
Do not overload the model with irrelevant context.
Do not remove critical constraints merely to reduce tokens.
Do not treat stale context as current truth.
