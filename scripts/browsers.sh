#!/usr/bin/env bash
# The two Chromes haevn's peers drive, and whether each is reachable (HVN-167).
#
#   scripts/browsers.sh check       every check; exit 1 if any fails
#   scripts/browsers.sh quick       sockets only, silent when all is well (for .envrc)
#   scripts/browsers.sh start-dev   start the test-profile Chrome if it is not running
#
# prod = αιamblichus's Chrome:  SURF_SOCKET=/tmp/surf-prod.sock surf …   (read-only, with his say-so)
# test = the test profile:      SURF_SOCKET=/tmp/surf-dev.sock surf …    and the DevTools MCP on 9223
# A bare `surf` (/tmp/surf.sock) must fail. The wrappers behind the sockets are DOT-90's to manage;
# the rules are in skills/browser-check/SKILL.md.
set -u

PROD_SOCK=/tmp/surf-prod.sock
DEV_SOCK=/tmp/surf-dev.sock
DEFAULT_SOCK=/tmp/surf.sock
DEV_DIR="$HOME/.local/share/haevn-dev-chrome"
DEV_PORT=9223

fails=0
ok() { [ "${QUIET:-0}" = 1 ] || printf '  ok    %s\n' "$1"; }
bad() { printf '  FAIL  %s\n        → %s\n' "$1" "$2" >&2; fails=$((fails + 1)); }

# A socket file can outlive its host, so connect to it rather than test that it exists.
live() {
  [ -S "$1" ] || return 1
  python3 -I -c 'import socket,sys
s=socket.socket(socket.AF_UNIX); s.settimeout(1)
try: s.connect(sys.argv[1])
except OSError: sys.exit(1)' "$1"
}

check_sockets() {
  if live "$PROD_SOCK"; then ok "prod surf: $PROD_SOCK"
  else bad "prod surf: no live $PROD_SOCK" "is Chrome running? Reload Surf in chrome://extensions (re-add it if it is gone); check the wrapper's SURF_SOCKET (DOT-90)"; fi

  if live "$DEV_SOCK"; then ok "test surf: $DEV_SOCK"
  else bad "test surf: no live $DEV_SOCK" "scripts/browsers.sh start-dev, then reload Surf in that profile"; fi

  if live "$DEFAULT_SOCK"; then
    bad "a bare \`surf\` works: $DEFAULT_SOCK is live" "a surf install or update reset a wrapper; re-apply it (DOT-90), then reload Surf"
  else ok "a bare \`surf\` has no browser ($DEFAULT_SOCK)"; fi
}

dev_chrome_up() { curl -fsS --max-time 1 "http://127.0.0.1:$DEV_PORT/json/version" >/dev/null 2>&1; }

check_dev_chrome() {
  if dev_chrome_up; then ok "test Chrome: DevTools on $DEV_PORT"
  else bad "test Chrome: nothing on port $DEV_PORT" "scripts/browsers.sh start-dev"; fi
}

case "${1:-check}" in
  quick)
    QUIET=1 check_sockets
    [ "$fails" -eq 0 ] || echo "haevn browsers: $fails problem(s); run scripts/browsers.sh check" >&2
    ;;
  check)
    echo "haevn browsers"
    check_sockets
    check_dev_chrome
    [ "$fails" -eq 0 ] && echo "all reachable" || echo "$fails problem(s)"
    ;;
  start-dev)
    if dev_chrome_up; then echo "test Chrome already running on $DEV_PORT"; exit 0; fi
    open -na "Google Chrome" --args --user-data-dir="$DEV_DIR" --remote-debugging-port="$DEV_PORT" --no-first-run
    echo "started the test Chrome ($DEV_DIR, port $DEV_PORT)"
    ;;
  *)
    echo "usage: scripts/browsers.sh [check|quick|start-dev]" >&2; exit 2 ;;
esac
[ "$fails" -eq 0 ]
