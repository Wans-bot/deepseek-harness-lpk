#!/usr/bin/env bash
# Uninstall -> reinstall with the SAME lpk and prove the workspace (user documents) survives.
set -uo pipefail
export DOCKER_HOST=unix:///lzcsys/run/lzc-docker/docker.sock
APP=f00700f.deepseek-harness
PREFIX=f00700fdeepseek-harness
DOC=/lzcsys/data/document/wans/.apps/$APP

echo "== 1) workspace before"; find "$DOC" -maxdepth 2 -type f -printf '%P (%s bytes) ' 2>/dev/null; echo
printf '   install-hello=[%s] ui-hello=[%s]\n' "$(cat "$DOC"/deepseek-harness/default-workspace/install-hello.txt 2>&1)" \
  "$(cat "$DOC"/deepseek-harness/default-workspace/ui-hello.txt 2>&1)"

echo "== 2) uninstall (keep user documents)"
lpk-manager uninstall "$APP" 2>&1 | tail -3
sleep 3
lzc-docker ps -a --format '{{.Names}} ==' --filter "name=$PREFIX" | head -5
echo "== 3) documents after uninstall"; find "$DOC" -maxdepth 2 -type f -printf '%P ' 2>/dev/null; echo

echo "== 4) reinstall"
lpk-manager install /root/f00700f.deepseek-harness-1.1.14.lpk 2>&1 | tail -5
for i in $(seq 1 24); do
  st=$(lzc-docker ps --filter "name=$PREFIX" --format '{{.Names}} {{.Status}}' | tr '\n' ' ')
  case "$st" in *"health: starting"*|*unhealthy*|"") sleep 5;; *) echo "  up: $st"; break;; esac
done

echo "== 5) documents after reinstall"; find "$DOC" -maxdepth 2 -type f -printf '%P ' 2>/dev/null; echo
printf '   install-hello=[%s]\n' "$(cat "$DOC"/deepseek-harness/default-workspace/install-hello.txt 2>&1)"
echo "== 6) entry log"; lzc-docker logs "$PREFIX-app-1" 2>&1 | head -4
lzc-docker logs "$PREFIX-dsh-1" 2>&1 | head -3
