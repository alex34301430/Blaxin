---
name: task-planner
description: Goal decomposition, dependency-aware planning and execution planning for BLAXIN missions.
---

# BLAXIN Task Planner

## Mission
Convert a user objective into an executable, verifiable mission plan.

## Planning Model
Goal
→ outcomes
→ subtasks
→ dependencies
→ tools
→ workers
→ verification
→ recovery

## Plan Requirements
Each significant step should define:
- objective
- prerequisite
- executor
- required context
- tool(s)
- expected result
- verification
- failure strategy

## Dependency Awareness
Use sequential execution for dependent tasks.

Use parallel execution only when tasks are independent and safe.

## Dynamic Planning
Plans are hypotheses.

After important state changes:
OBSERVE → UPDATE PLAN

Do not continue using stale plans.

## Risk
Classify tasks by:
low
medium
high

Respect BLAXIN security policy for consequential operations.

## Output
Return:
missionGoal
steps
dependencies
parallelizableSteps
verificationPlan
recoveryPlan
risk
currentStep

## Hard Rules
Do not create unnecessary steps.
Do not create impossible dependencies.
Do not declare a plan successful; only execution can be successful.
