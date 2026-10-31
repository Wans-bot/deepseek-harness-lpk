#!/bin/sh
# dsh web entrypoint:
# 0. 首次启动时把镜像内置的插件市场模板初始化到 /data（开箱即带 dshmarket）
# 1. start dsh web on loopback (127.0.0.1:3081)
# 2. wait for the printed token line
# 3. start the auth-autoinject proxy on 0.0.0.0:3080 -> dsh
set -eu

LOG=/tmp/dsh.log
: > "$LOG"

# 内置插件市场: /data 是全新卷时，从镜像内的模板初始化 web profile，
# 使应用开箱即带 dshmarket 插件市场（用户无需手动 dsh plugin add）。
# 只在尚未安装 dshmarket 时执行，不会覆盖用户已有插件。
TPL=/opt/dsh-profile-template/profiles
DSH_HOME_DIR="${DSH_HOME:-/data}"
if [ -d "$TPL" ] && [ ! -d "$DSH_HOME_DIR/profiles/web/node_modules/dshmarket" ]; then
  echo "seeding bundled plugin market into $DSH_HOME_DIR/profiles"
  mkdir -p "$DSH_HOME_DIR/profiles"
  cp -a "$TPL/." "$DSH_HOME_DIR/profiles/" 2>/dev/null || true
fi

# dsh web 出于安全策略禁止 0.0.0.0，只监听 loopback。
# 懒猫子域名（LAZYCAT_APP_DOMAIN，如 dsh.wans.heiyu.space）必须加入 --trusted-host，
# 否则 /api 与 WebSocket 会被 DNS-rebinding/Host fence 以 403 拒绝。
TRUSTED_HOST="${LAZYCAT_APP_DOMAIN:-}"
if [ -z "$TRUSTED_HOST" ]; then
  TRUSTED_HOST="${LAZYCAT_BOX_DOMAIN:-}"
fi

if [ -n "$TRUSTED_HOST" ]; then
  dsh web --no-open --host 127.0.0.1 --port 3081 --trusted-host "$TRUSTED_HOST" > "$LOG" 2>&1 &
else
  dsh web --no-open --host 127.0.0.1 --port 3081 > "$LOG" 2>&1 &
fi
DSH_PID=$!

# 等待 token 行出现 (dsh web: http://127.0.0.1:3081/?token=...)
TOKEN=""
i=0
while [ $i -lt 120 ]; do
  TOKEN=$(grep -o 'token=[A-Za-z0-9_-]*' "$LOG" 2>/dev/null | tail -1 | cut -d= -f2 || true)
  if [ -n "$TOKEN" ]; then
    break
  fi
  if ! kill -0 "$DSH_PID" 2>/dev/null; then
    echo "dsh exited early:" >&2
    tail -40 "$LOG" >&2
    exit 1
  fi
  i=$((i + 1))
  sleep 1
done

if [ -z "$TOKEN" ]; then
  echo "failed to obtain dsh launch token in time:" >&2
  tail -60 "$LOG" >&2
  exit 1
fi

export DSH_TOKEN="$TOKEN"
export DSH_PUBLIC_HOST="$TRUSTED_HOST"
exec node /dsh-proxy.mjs
