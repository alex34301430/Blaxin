---
name: secret-redaction
description: Detects and removes credential and secret material before persistence, logging, events or model context exposure.
---

# BLAXIN Secret Redaction

## Mission
Prevent secrets from escaping into memory, logs, events, diagnostics or model-visible context.

## Detect
Identify at least:
- passwords
- API keys
- access tokens
- refresh tokens
- bearer tokens
- cookies
- authorization headers
- private keys
- credential values
- sensitive environment variables
- OTP/verification secrets where applicable

## Redaction
Replace secret values with:

[REDACTED]

or another safe equivalent.

## Redaction Boundary
Apply BEFORE:
- persistence
- logging
- event emission
- telemetry
- error storage
- conversation history
- memory writes
- benchmark artifacts

## Structural Redaction
Redact sensitive fields by key name as well as suspicious value patterns.

Examples:
password
token
secret
apiKey
authorization
cookie
privateKey
credential

## Testing
Use synthetic credentials in tests.

Verify secret values are absent from serialized outputs.

## Hard Rules
Do not print the detected secret to diagnose it.
Do not rely solely on UI masking.
Redaction must happen before the data reaches durable storage.
