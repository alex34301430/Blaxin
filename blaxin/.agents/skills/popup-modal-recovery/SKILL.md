---
name: popup-modal-recovery
description: Detection and safe handling of browser and desktop popups, dialogs and overlays.
---

# BLAXIN Popup and Modal Recovery

## Mission
Detect UI interruptions that block normal execution and recover safely.

## Detect
Look for:
- modal dialogs
- cookie banners
- permission prompts
- sign-in prompts
- overlays
- alert dialogs
- extension popups
- download prompts
- unexpected windows

## Classification
Classify as:
BENIGN
RELEVANT
SECURITY_SENSITIVE
UNKNOWN

## Handling
For benign interruptions:
- inspect
- choose appropriate action
- observe result

For security-sensitive or consequential prompts:
- invoke security policy
- ASK when required
- never bypass

## Recovery
After dismissal/handling:
- verify overlay is gone
- re-ground original target
- continue mission

## Hard Rules
Never click arbitrary "Allow", "Accept", "Confirm" buttons without understanding context.
