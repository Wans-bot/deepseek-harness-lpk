#!/usr/bin/env bash
# 全新安装 dsh 到 lzcbox 并做容器内自检（不卸载，供后续 https 验收用）
set -uo pipefail
source /home/wans/lpk-env/env.sh >/dev/null 2>&1
PKG=f00700f.deepseek-harness
LPK="${1:?usage: deploy-fresh.sh <lpk>}"
BOX=lzcbox
SSHOPT="-o StrictHostKeyChecking=no -o ConnectTimeout=15"
B="$(basename "$LPK")"

scp $SSHOPT "$LPK" "$BOX:/root/$B" >/dev/null || exit 1
echo "uploaded $B ($(sha256sum "$LPK" | cut -c1-16))"

ssh $SSHOPT "$BOX" "bash -s -- '$PKG' '$B'" <<'REMOTE' 2>&1 | /usr/bin/grep -v "Welcome to Lazycat\|Root is yours\|casually tweak\|AI agents\|setlocale"
set -uo pipefail
PKG="$1"; B="$2"
export DOCKER_HOST=unix:///lzcsys/run/lzc-docker/docker.sock
echo "=== 1) uninstall any previous instance + wipe its data ==="
if lpk-manager list 2>/dev/null | /usr/bin/grep -q "$PKG"; then
  lpk-manager uninstall "$PKG" 2>&1 | tail -3
fi
for d in /lzcsys/data/appvar/"$PKG" /lzcsys/data/appcache/"$PKG" /lzcsys/data/document/wans/.apps/"$PKG"; do
  [ -e "$d" ] || continue
  echo "  removing $d"; rm -rf "$d"
done
echo "=== 2) install ==="
lpk-manager install "/root/$B" 2>&1 | tail -12
echo "install exit=$?"
echo "=== 3) wait for containers ==="
prefix=$(echo "$PKG" | tr -d '.')
for i in $(seq 1 40); do
  st=$(lzc-docker ps -a --filter "name=${prefix}" --format "{{.Names}} {{.Status}}" | tr '\n' ' ')
  up=$(lzc-docker ps --filter "name=${prefix}" --format "{{.Names}}" | wc -l)
  echo "  [$i] $st"
  [ "$up" -ge 1 ] && break
  sleep 5
done
echo "=== 4) mounts + entry log ==="
for c in $(lzc-docker ps -a --filter "name=${prefix}" --format "{{.Names}}"); do
  echo "--- $c"
  lzc-docker inspect "$c" --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}
{{end}}' | /usr/bin/grep -i "document\|/data" 
  lzc-docker inspect "$c" --format '{{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} err={{.State.Error}}'
done
echo "=== 5) in-container checks ==="
app=$(lzc-docker ps -a --filter "name=${prefix}-app-1" --format "{{.Names}}" | head -1)
echo "app container: $app"
lzc-docker exec "$app" sh -c 'echo "DOCS_ROOT:"; ls -la /lzcapp/documents 2>&1 | head -6; echo "DOCS_DIR:"; ls -la /data/documents 2>&1 | head -4; echo "xdg:"; xdg-user-dir DOCUMENTS; echo "id: $(id -u)"' 2>&1 | head -20
echo "=== 6) entry log tail ==="
lzc-docker logs "$app" 2>&1 | tail -25
REMOTE
