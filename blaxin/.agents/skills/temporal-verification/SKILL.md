---
name: temporal-verification
description: Reusable BLAXIN skill for reliable autonomous execution.
---

# temporal-verification

## Purpose
Provide a focused, reusable capability for BLAXIN.

## Rules
- Inspect real runtime state before acting.
- Never guess when evidence is insufficient.
- Use the narrowest required tools and context.
- Verify consequential actions.
- Return SUCCESS, FAILURE, or UNKNOWN honestly.
- Escalate or recover when execution fails.
- Never expose or persist secrets.

## Inputs
Accept the task objective, relevant context, available tools, and constraints.

## Process
1. Understand the objective.
2. Inspect current state.
3. Plan the required operation.
4. Execute using authorized tools.
5. Observe the resulting state.
6. Verify the outcome.
7. Recover or escalate on failure.
8. Return a structured result.

## Output
Return:
- status
- result
- evidence
- verification
- failure/recovery information
- next action when applicable
