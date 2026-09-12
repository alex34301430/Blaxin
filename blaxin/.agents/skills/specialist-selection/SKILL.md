---
name: specialist-selection
description: Selects appropriate BLAXIN Agency specialists based on task requirements and measurable capability.
---

# BLAXIN Specialist Selection

## Mission
Choose specialists by actual capability, not UI labels.

## Selection Factors
Consider:
- required domain
- available tools
- previous success rate
- context compatibility
- current workload
- timeout risk
- security scope
- verification capability

## Examples
Browser task → Browser specialist
Visual ambiguity → Vision specialist
Coding task → Coding specialist
Test validation → Test specialist
Security-sensitive task → Security specialist
Failure diagnosis → Debug/Recovery specialist

## Multi-Agent Selection
Use multiple specialists only when their responsibilities are genuinely distinct.

Example:
Research → Coding → Testing → Verification

## Output
Return:
selectedSpecialists
reason
responsibilities
toolScopes
expectedOutputs
verificationPlan

## Hard Rules
Do not assign tasks outside a worker's scope.
Do not create duplicate work unnecessarily.
