#!/usr/bin/env bash
# Runs the API (and the built web UI) in the background, detached from this terminal, so closing the terminal
# does not stop answers or video processing. Usage: scripts/bg.sh start|stop|restart|status|logs
# Options: PORT=3001 (default from .env), --no-build to skip rebuilding the web app.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN="$ROOT/.run"; PIDFILE="$RUN/server.pid"; LOG="$RUN/server.log"
mkdir -p "$RUN"

port() { echo "${PORT:-$(grep -E '^PORT=' "$ROOT/.env" 2>/dev/null | cut -d= -f2 | tr -d '"' )}" | sed 's/^$/3001/'; }
alive() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }

start() {
  if alive; then echo "Already running (pid $(cat "$PIDFILE")) on http://localhost:$(port)"; return 0; fi
  if [ "${1:-}" != "--no-build" ]; then
    echo "Building the web app…"; (cd "$ROOT/web" && npx vite build >/dev/null 2>&1) || { echo "Web build failed (run: pnpm --filter web build)"; return 1; }
  fi
  : > "$LOG"
  # setsid gives the server its own session, so closing this terminal (SIGHUP) cannot reach it.
  PORT="$(port)" setsid -f bash -c 'echo $$ > "'"$PIDFILE"'"; cd "'"$ROOT"'/server" && exec ./node_modules/.bin/tsx --env-file=../.env src/index.ts >> "'"$LOG"'" 2>&1'
  for _ in $(seq 1 60); do
    curl -sS -m 2 "http://localhost:$(port)/api/health" >/dev/null 2>&1 && { echo "Running (pid $(cat "$PIDFILE")) on http://localhost:$(port)"; return 0; }
    sleep 1
  done
  echo "Started, but it did not answer within 60 s (the database may be slow). Check: scripts/bg.sh logs"
}

stop() {
  if ! alive; then echo "Not running"; rm -f "$PIDFILE"; return 0; fi
  PID="$(cat "$PIDFILE")"
  kill -TERM -- "-$PID" 2>/dev/null || kill -TERM "$PID" 2>/dev/null   # whole session: launcher and node
  for _ in $(seq 1 20); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
  kill -0 "$PID" 2>/dev/null && kill -KILL -- "-$PID" 2>/dev/null
  rm -f "$PIDFILE"; echo "Stopped (unfinished work resumes on the next start)"
}

status() {
  if alive; then
    echo "Running (pid $(cat "$PIDFILE")) on http://localhost:$(port)"
    curl -sS -m 3 "http://localhost:$(port)/api/health" || echo "(not answering yet)"; echo
  else echo "Not running"; fi
}

case "${1:-}" in
  start) shift; start "$@" ;;
  stop) stop ;;
  restart) stop; shift; start "$@" ;;
  status) status ;;
  logs) tail -n 100 -f "$LOG" ;;
  *) echo "Usage: scripts/bg.sh start|stop|restart|status|logs [--no-build]"; exit 1 ;;
esac
