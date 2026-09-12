---
name: intent-understanding
description: Converts natural user requests into explicit goals, constraints and execution intent for BLAXIN Jarvis.
---

# BLAXIN Intent Understanding

## Mission
Understand what the user actually wants before selecting an execution strategy.

## Extract
Identify:
- primary objective
- desired outcome
- constraints
- preferences
- urgency
- scope
- implicit dependencies
- risky actions
- approval requirements

## Distinguish
Separate:

USER WANTS
from

EXECUTION PLAN

The user should express the goal.

Jarvis/Agent should determine how to achieve it.

## Ambiguity
When ambiguity materially changes the outcome:
- infer only when safe and strongly supported
- otherwise ask a targeted clarification

Do not ask unnecessary questions.

## Context
Use:
- current conversation
- active mission
- relevant memory
- environment state

Do not inject unrelated history.

## Risk
Detect requests involving:
- deletion
- account changes
- financial actions
- credential use
- external publishing
- sensitive data

Route them through Security Guardian.

## Output
Return:
intent
goal
constraints
expectedOutcome
risk
ambiguities
approvalRequirement
recommendedRoute

## Hard Rules
Never invent user intent.
Never confuse a possible action with the user's actual goal.
