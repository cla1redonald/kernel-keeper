#!/bin/zsh
# Optional wrapper for local scheduled patrols (cron/launchd/hooks).
# Does NOT replace your patrol script - call this instead of (or after) it
# when you want a push notification. All channels opt-in via env vars:
#   SLACK_WEBHOOK_URL   → posts the one-line summary to Slack
#   TEAMS_WEBHOOK_URL   → posts the one-line summary to Teams
#   PATROL_MAIL_TO      → mails the digest via the system `mail` command
#   PATROL_MACOS_NOTIFY=1 → macOS notification centre banner
# Usage: KERNEL_KEEPER_CLI=/path/to/kernel-keeper/dist/cli.js local-notify.sh <bundle-or-estate-path> [kernel-keeper args...]
set -u
TARGET="$1"; shift
REPORT="$(mktemp)/patrol-report.md"; mkdir -p "$(dirname "$REPORT")"
SUMMARY=$(node "${KERNEL_KEEPER_CLI:?set KERNEL_KEEPER_CLI to the path of dist/cli.js}" "$TARGET" "$@" --out "$REPORT" --quiet)
STATUS=$?

[ -n "${SLACK_WEBHOOK_URL:-}" ] && curl -fsS -X POST "$SLACK_WEBHOOK_URL" \
  -H 'Content-Type: application/json' -d "{\"text\": \"🛡️ $SUMMARY\"}" >/dev/null

[ -n "${TEAMS_WEBHOOK_URL:-}" ] && curl -fsS -X POST "$TEAMS_WEBHOOK_URL" \
  -H 'Content-Type: application/json' \
  -d "{\"type\":\"message\",\"attachments\":[{\"contentType\":\"application/vnd.microsoft.card.adaptive\",\"content\":{\"type\":\"AdaptiveCard\",\"version\":\"1.4\",\"body\":[{\"type\":\"TextBlock\",\"text\":\"🛡️ $SUMMARY\",\"wrap\":true}]}}]}" >/dev/null

[ -n "${PATROL_MAIL_TO:-}" ] && mail -s "Kernel patrol: $SUMMARY" "$PATROL_MAIL_TO" < "$REPORT"

[ "${PATROL_MACOS_NOTIFY:-0}" = "1" ] && osascript -e "display notification \"$SUMMARY\" with title \"Kernel patrol\"" 2>/dev/null

exit $STATUS
