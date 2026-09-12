---
name: screen-perception
description: Fast screenshot-based visual state perception for BLAXIN computer use.
---

# BLAXIN Screen Perception

## Mission
Extract useful visual state from the real desktop/browser.

## Detect
Identify:
- windows
- browser chrome
- dialogs
- buttons
- fields
- text
- menus
- loading states
- errors
- overlays
- player controls
- visual transitions

## Context
Interpret visual information together with:
- DOM
- accessibility
- current URL
- active window
- previous action
- viewport

Do not rely on pixels alone when stronger structural evidence exists.

## Temporal State
When success depends on change:
capture state before and after the action.

## Confidence
Return confidence tied to evidence quality.

## Hard Rules
Never invent unseen UI.
Never report visual state from a stale screenshot.
