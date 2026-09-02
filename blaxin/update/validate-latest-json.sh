#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════
# BLAXIN — Validate latest.json for Tauri updater
#
# Usage:
#   bash blaxin/update/validate-latest-json.sh [path-to-latest.json]
#
# Checks:
#   - File exists and is valid JSON
#   - Has required fields (version, notes, pub_date, platforms)
#   - Signature is non-empty and has minisign format
#   - URL points to correct artifact
#   - Version matches expected version (if provided)
# ═══════════════════════════════════════════════════════════════════════

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

JSON_FILE="${1:-blaxin/update/latest.json}"
EXPECTED_VERSION="${2:-}"
ERRORS=0

error() { echo -e "${RED}✗ $*${NC}" >&2; (( ERRORS++ )); }
warn()  { echo -e "${YELLOW}⚠ $*${NC}"; }
ok()    { echo -e "${GREEN}✓ $*${NC}"; }

echo "Validating: ${JSON_FILE}"
echo ""

# Check file exists
if [[ ! -f "${JSON_FILE}" ]]; then
    error "File not found: ${JSON_FILE}"
    exit 1
fi

# Check valid JSON
if ! python3 -c "import json; json.load(open('${JSON_FILE}'))" 2>/dev/null; then
    error "File is not valid JSON"
    exit 1
fi
ok "Valid JSON"

# Check required fields
for field in version notes pub_date platforms; do
    if python3 -c "
import json
data = json.load(open('${JSON_FILE}'))
assert '${field}' in data, 'Missing field: ${field}'
" 2>/dev/null; then
        ok "Has field: ${field}"
    else
        error "Missing required field: ${field}"
    fi
done

# Check platforms
if python3 -c "
import json, sys
data = json.load(open('${JSON_FILE}'))
platforms = data.get('platforms', {})
if 'linux-x86_64' not in platforms:
    print('Missing platform: linux-x86_64')
    sys.exit(1)
p = platforms['linux-x86_64']
if 'url' not in p:
    print('Missing url in platform')
    sys.exit(1)
if 'signature' not in p:
    print('Missing signature in platform')
    sys.exit(1)
" 2>/dev/null; then
    ok "Platform configuration valid"
else
    error "Platform configuration invalid"
fi

# Check signature is non-empty and has minisign format
SIG_CHECK=$(python3 -c "
import json, sys
data = json.load(open('${JSON_FILE}'))
sig = data.get('platforms', {}).get('linux-x86_64', {}).get('signature', '')
if not sig:
    print('EMPTY')
    sys.exit(1)
lines = sig.strip().split('\n')
if len(lines) < 2:
    print('INVALID_FORMAT')
    sys.exit(1)
print(f'OK:{len(sig)}:{len(lines)}')
" 2>&1) || true

if [[ "${SIG_CHECK}" == "EMPTY" ]]; then
    error "Signature is empty — updater will not work"
elif [[ "${SIG_CHECK}" == "INVALID_FORMAT" ]]; then
    error "Signature does not have minisign format (needs at least 2 lines)"
elif [[ "${SIG_CHECK}" == OK:* ]]; then
    SIG_LEN=$(echo "${SIG_CHECK}" | cut -d: -f2)
    SIG_LINES=$(echo "${SIG_CHECK}" | cut -d: -f3)
    ok "Signature valid: ${SIG_LEN} chars, ${SIG_LINES} lines"
else
    error "Unexpected signature check result: ${SIG_CHECK}"
fi

# Check URL format
URL_CHECK=$(python3 -c "
import json, sys
data = json.load(open('${JSON_FILE}'))
url = data.get('platforms', {}).get('linux-x86_64', {}).get('url', '')
if not url.startswith('https://github.com/'):
    print('INVALID_URL')
    sys.exit(1)
if '.AppImage' not in url:
    print('NOT_APPIMAGE')
    sys.exit(1)
print('OK')
" 2>&1) || true

if [[ "${URL_CHECK}" == "OK" ]]; then
    ok "URL format valid"
elif [[ "${URL_CHECK}" == "NOT_APPIMAGE" ]]; then
    error "URL does not point to an AppImage"
else
    error "URL format invalid"
fi

# Check version if expected version provided
if [[ -n "${EXPECTED_VERSION}" ]]; then
    ACTUAL_VERSION=$(python3 -c "
import json
data = json.load(open('${JSON_FILE}'))
print(data.get('version', ''))
" 2>/dev/null)
    
    if [[ "${ACTUAL_VERSION}" == "${EXPECTED_VERSION}" ]]; then
        ok "Version matches: ${ACTUAL_VERSION}"
    else
        warn "Version mismatch: expected ${EXPECTED_VERSION}, got ${ACTUAL_VERSION}"
    fi
fi

echo ""
if (( ERRORS > 0 )); then
    echo -e "${RED}Validation FAILED with ${ERRORS} error(s)${NC}"
    exit 1
else
    echo -e "${GREEN}Validation PASSED${NC}"
    exit 0
fi
