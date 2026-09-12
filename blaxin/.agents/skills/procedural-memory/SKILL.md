---
name: procedural-memory
description: Converts verified successful workflows into reusable BLAXIN procedures.
---

# BLAXIN Procedural Memory

## Mission
Store reliable how-to procedures that improve future task execution.

## Procedure Structure
Include:
- name
- purpose
- prerequisites
- inputs
- sequence
- tool requirements
- expected states
- verification
- common failures
- recovery
- confidence

## Promotion Rule
Only promote a workflow to procedural memory when:
- the task succeeded
- success was verified
- the procedure is reusable

Repeated verified success should increase confidence.

## Reuse
When a similar task appears:
1. retrieve relevant procedure
2. compare current environment
3. adapt if necessary
4. execute
5. verify

Never replay blindly.

## Hard Rules
A remembered procedure is a starting strategy, not permission to skip observation.
