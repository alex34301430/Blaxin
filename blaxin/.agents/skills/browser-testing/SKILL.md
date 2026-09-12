---
name: browser-testing
description: Real-browser regression testing for BLAXIN navigation, grounding, synchronization and verification.
---

# BLAXIN Browser Testing

## Mission
Validate browser behavior using real execution paths whenever feasible.

## Test Categories
Test:
- navigation
- search
- target grounding
- click
- typing
- scroll
- popup handling
- tab switching
- browser synchronization
- verification
- recovery

## Real-State Principle
Prefer real browser state over mocked browser results for critical workflows.

## Synchronization Tests
Explicitly detect:
- visible page vs CDP mismatch
- stale page handle
- wrong active tab
- about:blank desynchronization
- disconnected browser

## YouTube Benchmark
Verify:
- YouTube opens
- search works
- correct result selected
- player opens
- playback starts
- currentTime advances where accessible

## Hard Rules
Never mark browser workflow successful based only on tool return values.
