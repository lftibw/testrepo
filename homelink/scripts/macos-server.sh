#!/bin/bash
# HomeLink macOS server helper.
#
# Runs HomeLink as a launchd user agent so it starts at login, restarts if it
# crashes, and keeps serving HomeKit while the MacBook is on.
#
#   ./scripts/macos-server.sh install    install deps + register the service
#   ./scripts/macos-server.sh start|stop|restart
#   ./scripts/macos-server.sh status     service state + portal URL + PIN
#   ./scripts/macos-server.sh logs       tail the app log
#   ./scripts/macos-server.sh uninstall  remove the service (keeps ./data)

set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.homelink.bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$APP_DIR/data/logs"
NODE_BIN="$(command -v node || true)"

die() { echo "error: $*" >&2; exit 1; }

require_node() {
  [ -n "$NODE_BIN" ] || die "Node.js not found. Install it with: brew install node  (or from https://nodejs.org)"
  local major
  major="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 18 ] || die "Node.js 18+ required, found $("$NODE_BIN" --version)"
}

write_plist() {
  mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$APP_DIR/src/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>$APP_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG_DIR/homelink.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/homelink.log</string>
</dict>
</plist>
EOF
}

pin() {
  "$NODE_BIN" -p 'try { JSON.parse(require("fs").readFileSync("'"$APP_DIR"'/data/config.json")).bridge.pincode } catch { "(starts on first run)" }'
}

web_port() {
  "$NODE_BIN" -p 'try { JSON.parse(require("fs").readFileSync("'"$APP_DIR"'/data/config.json")).webPort || 8580 } catch { 8580 }'
}

case "${1:-}" in
  install)
    require_node
    echo "→ Installing dependencies…"
    (cd "$APP_DIR" && npm install --omit=dev)
    write_plist
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST"
    echo
    echo "✓ HomeLink installed as a background service (starts at login, auto-restarts)."
    sleep 2
    echo "  Portal:      http://localhost:$(web_port)  (or http://$(hostname).local:$(web_port) from your phone)"
    echo "  HomeKit PIN: $(pin)"
    echo
    echo "  If macOS asks whether 'node' may accept incoming connections, click Allow —"
    echo "  that's HomeKit pairing traffic from your iPhone/Apple TV."
    ;;
  start)
    launchctl load "$PLIST" 2>/dev/null || true
    launchctl start "$LABEL"
    echo "✓ started — portal at http://localhost:$(web_port)"
    ;;
  stop)
    launchctl stop "$LABEL" 2>/dev/null || true
    launchctl unload "$PLIST" 2>/dev/null || true
    echo "✓ stopped"
    ;;
  restart)
    launchctl stop "$LABEL" 2>/dev/null || true
    launchctl start "$LABEL"
    echo "✓ restarted"
    ;;
  status)
    if launchctl list "$LABEL" >/dev/null 2>&1; then
      echo "● service loaded ($(launchctl list "$LABEL" | grep -E '"PID"' || echo 'not running'))"
    else
      echo "○ service not loaded — run: $0 install"
    fi
    echo "  Portal:      http://localhost:$(web_port)"
    echo "  HomeKit PIN: $(pin)"
    ;;
  logs)
    tail -n 50 -f "$LOG_DIR/homelink.log"
    ;;
  uninstall)
    launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "✓ service removed (config/pairing in $APP_DIR/data kept intact)"
    ;;
  *)
    grep '^#   ' "$0" | sed 's/^#   //'
    exit 1
    ;;
esac
