#!/usr/bin/env bash
# Restart the app and verify workspace files + sessions survive.
set -uo pipefail
export DOCKER_HOST=unix:///lzcsys/run/lzc-docker/docker.sock
APP=f00700f.deepseek-harness
WS=/lzcsys/data/document/wans/.apps/$APP/deepseek-harness/default-workspace

echo "== BEFORE"; ls -1 "$WS" 2>&1; printf 'ui-hello=[%s] ' "$(cat "$WS/ui-hello.txt" 2>&1)"; echo
sessions_before=$(lzc-docker exec ${APP}-dsh-1 sh -c 'ls -1 /data/sessions 2>/dev/null | wc -l' 2>/dev/null)
echo "sessions_before=$sessions_before"

lpk-manager stop $APP; sleep 4
echo "== STOPPED"; lzc-docker ps -a --filter "name=${APP//./}" --format '{{.Names}} {{.Status}}'
lpk-manager start $APP; sleep 20
for i in $(seq 1 12); do
  st=$(lzc-docker ps --filter "name=${APP//./}" --format '{{.Names}} {{.Status}}' | tr '\n' ' ')
  echo "  [$i] $st"
  echo "$st" | grep -q "health: starting" || echo "$st" | grep -q "unhealthy" || break
  sleep 5
done

echo "== AFTER"; ls -1 "$WS" 2>&1; printf 'ui-hello=[%s] hello=[%s] ' "$(cat "$WS/ui-hello.txt" 2>&1)" "$(cat "$WS/hello.txt" 2>&1)"; echo
sessions_after=$(lzc-docker exec ${APP}-dsh-1 sh -c 'ls -1 /data/sessions 2>/dev/null | wc -l' 2>/dev/null)
echo "sessions_after=$sessions_after"
lzc-docker exec ${APP}-dsh-1 sh -c 'grep -c . /tmp/dsh-entry.log 2>/dev/null; tail -3 /var/log/dsh-harness.log 2>/dev/null' 2>/dev/null | head -5
