---
name: parallel-execution
description: Safe dependency-aware parallel execution for BLAXIN Agency workers.
---

# BLAXIN Parallel Execution

## Mission
Reduce latency by executing genuinely independent work concurrently.

## Before Parallelizing
Confirm:
- tasks are independent
- no shared mutable state conflict
- permissions are compatible
- resource limits are safe
- outputs can be merged

## Never Parallelize
When:
- task B depends on task A
- both modify the same sensitive resource
- ordering affects correctness
- security approval is sequential
- browser actions require one active context

## Synchronization
Parallel workers
→ collect results
→ validate
→ synthesize
→ verify combined outcome

## Failure
One worker failure must not automatically invalidate unrelated work.

Assess dependency impact before continuing.

## Output
Return:
workers
parallelGroups
dependencies
results
failedWorkers
synthesisStatus

## Hard Rules
Never trade correctness for concurrency.
Never allow conflicting computer actions simultaneously.
