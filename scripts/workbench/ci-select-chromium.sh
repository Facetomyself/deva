#!/usr/bin/env bash
# Hosted-runner acceptance only. Prefer the installed browser binary (not a Snap launcher),
# and use that SAME Chrome build for Chromium's private pipe and for the matching ChromeDriver.
set -euo pipefail
: "${GITHUB_ENV:?GitHub Actions environment file required}"
chrome=''
for candidate in /opt/google/chrome/chrome "${CHROME_BIN:-}" "$(command -v google-chrome || :)" \
    "$(command -v google-chrome-stable || :)" /usr/lib/chromium/chromium; do
  if [[ -n "$candidate" && "$candidate" == /* && -f "$candidate" && -x "$candidate" ]]; then
    chrome="$candidate"; break
  fi
done
if [[ -z "$chrome" ]]; then printf '%s\n' 'No installed Google Chrome/Chromium binary found on the acceptance runner.' >&2; exit 1; fi
"$chrome" --version
printf 'CHROME_BIN=%s\nCHROMIUM_PATH=%s\n' "$chrome" "$chrome" >> "$GITHUB_ENV"
