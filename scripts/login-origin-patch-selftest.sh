#!/usr/bin/env bash
# Self-test for patch-dsh-login-origin.js — runs against synthetic bundles so it
# never touches the live dsh install.
set -eu

PATCH="${1:-/lzcapp/pkg/content/patch-dsh-login-origin.js}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

BUNDLE="node_modules/@deepseek-ai/dsh-client-ui-settings-account/lib/client.js"
NEEDLE_A='const result = await ctx.remote.account.startSignIn(client(), desktop && transport?.streamBaseUrl !== void 0 ? new URL(transport.streamBaseUrl).origin : window.location.origin, desktop ? "desktop" : "web");'

make_root() {
  root="$WORK/$1"
  mkdir -p "$root/node_modules/@deepseek-ai/dsh-client-ui-settings-account/lib"
  printf '%s\n' "$2" >"$root/$BUNDLE"
  printf '%s\n' "$root"
}

pass=0
fail=0
check() {
  if [ "$2" = "$3" ]; then
    echo "  ok    $1"
    pass=$((pass + 1))
  else
    echo "  FAIL  $1 (expected '$3', got '$2')"
    fail=$((fail + 1))
  fi
}

echo "1. happy path"
root="$(make_root good "$NEEDLE_A")"
out="$(DSH_MODULE_ROOT="$root" node "$PATCH" 2>&1)" && rc=0 || rc=$?
check "exit 0" "$rc" "0"
check "reports pinned origin" "$(printf '%s' "$out" | grep -c 'pinned web callbackOrigin to http://127.0.0.1:3081')" "1"
check "needle replaced" "$(grep -c 'window.location.origin, desktop ? "desktop" : "web")' "$root/$BUNDLE" || true)" "0"
check "marker present once" "$(grep -c 'dsh-lazycat-login-origin-v1' "$root/$BUNDLE")" "1"

echo "2. idempotent re-run"
out="$(DSH_MODULE_ROOT="$root" node "$PATCH" 2>&1)" && rc=0 || rc=$?
check "exit 0" "$rc" "0"
check "says already applied" "$(printf '%s' "$out" | grep -c 'already applied')" "1"
check "marker still once" "$(grep -c 'dsh-lazycat-login-origin-v1' "$root/$BUNDLE")" "1"

echo "3. DSH_LOGIN_ORIGIN override"
root="$(make_root alt "$NEEDLE_A")"
DSH_MODULE_ROOT="$root" DSH_LOGIN_ORIGIN='http://localhost:9999' node "$PATCH" >/dev/null 2>&1 || true
check "uses localhost:9999" "$(grep -c '"http://localhost:9999", desktop ?' "$root/$BUNDLE" || true)" "1"

echo "4. reject non-loopback override"
root="$(make_root bad "$NEEDLE_A")"
out="$(DSH_MODULE_ROOT="$root" DSH_LOGIN_ORIGIN='https://evil.example.com' node "$PATCH" 2>&1)" && rc=0 || rc=$?
check "non-zero exit" "$([ "$rc" -ne 0 ] && echo yes || echo no)" "yes"
check "explains why" "$(printf '%s' "$out" | grep -c 'must be http://<loopback>:<port>')" "1"
check "bundle untouched" "$(grep -c 'window.location.origin, desktop ? "desktop" : "web")' "$root/$BUNDLE")" "1"

echo "5. reject zero port"
root="$(make_root zero "$NEEDLE_A")"
DSH_MODULE_ROOT="$root" DSH_LOGIN_ORIGIN='http://127.0.0.1:0' node "$PATCH" >/dev/null 2>&1 && rc=0 || rc=$?
check "non-zero exit" "$([ "$rc" -ne 0 ] && echo yes || echo no)" "yes"

echo "6. no anchor -> fail closed"
root="$(make_root none 'const unrelated = 1;')"
out="$(DSH_MODULE_ROOT="$root" node "$PATCH" 2>&1)" && rc=0 || rc=$?
check "non-zero exit" "$([ "$rc" -ne 0 ] && echo yes || echo no)" "yes"
check "reports layout change" "$(printf '%s' "$out" | grep -c 'no client bundle contains the startSignIn call site')" "1"

echo "7. ambiguous anchor -> fail closed"
root="$(make_root dup "$NEEDLE_A
$NEEDLE_A")"
out="$(DSH_MODULE_ROOT="$root" node "$PATCH" 2>&1)" && rc=0 || rc=$?
check "non-zero exit" "$([ "$rc" -ne 0 ] && echo yes || echo no)" "yes"
check "reports ambiguous" "$(printf '%s' "$out" | grep -c 'ambiguous')" "1"
check "bundle untouched" "$(grep -c 'window.location.origin, desktop ?' "$root/$BUNDLE")" "2"

echo
echo "passed: $pass  failed: $fail"
[ "$fail" -eq 0 ]
