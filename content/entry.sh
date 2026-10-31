#!/bin/sh
# LazyCat DSH entrypoint.
#
#   1. provide the Documents directory dsh asks for on first use, and keep the
#      Workspace + the agent's default working directory inside it
#   2. reconcile the bundled plugin market with the running dsh release
#      (keeps /data/profiles usable across app upgrades)
#   2b. point the agent's fallback working directory at the Workspace
#   2c. re-create working directories recorded by older releases
#   3. patch the Settings persistence selector for the box-assigned app domain
#   4. start "dsh web" on loopback and expose it through the auth auto-proxy
set -eu

DSH_HOME_DIR="${DSH_HOME:-/data}"
TPL=/opt/dsh-profile-template/profiles
WEBPROF="$DSH_HOME_DIR/profiles/web"
MARKET_DIR="$WEBPROF/node_modules/dshmarket"
DOCS_DIR="${DSH_DOCUMENTS_DIR:-$DSH_HOME_DIR/documents}"
# DOCS_DIR is resolved in section 1 (netdisk app documents when available).
# --- 0. legacy /root: keep it on the persistent volume ------------------------
# Releases up to 1.1.15 ran dsh with HOME=/root (HOME was never exported), so a
# Workspace created in the Web UI was recorded as /root/<name>. /root lived on
# the container's writable layer: a restart or an upgrade threw it away, while
# the workspace registry and every session header kept the path, so continuing
# an old session failed with "working-directory: directory does not exist"
# (review #22166).
#
# The manifest now bind-mounts the persistent home onto /root itself. A bind
# mount keeps the path spelled /root/work1 (a symlink would not: dsh realpaths
# every record and then /root/work1 and /data/home/work1 would be different
# strings, so the workspace would silently drop its sessions).
PERSIST_HOME="$DSH_HOME_DIR/home"
mkdir -p "$PERSIST_HOME"
# 1.1.18 test builds left /root as a symlink; the bind mount replaces it.
if [ -L /root ]; then rm -f /root; fi
if [ -d /root ] && [ "$(stat -c '%d:%i' /root 2>/dev/null)" = "$(stat -c '%d:%i' "$PERSIST_HOME" 2>/dev/null)" ]; then
  echo "legacy HOME: /root is the persistent home"
elif [ -e /root ]; then
  # No bind mount (container created by an older manifest): rescue whatever the
  # writable layer still holds so nothing is lost on the next recreate.
  for entry in /root/*; do
    [ -e "$entry" ] || continue
    cp -a -n "$entry" "$PERSIST_HOME/" 2>/dev/null || echo "WARN: could not copy $entry into $PERSIST_HOME" >&2
  done
  echo "WARN: /root is not the persistent home; old working directories are now at $PERSIST_HOME" >&2
fi
# --- 1. Documents directory for first-use Workspace creation ---------------
# dsh 0.2 resolves <Documents>/deepseek-harness/default-workspace through
# `xdg-user-dir DOCUMENTS`; the Debian base image has no xdg-user-dirs, so the
# first page load reports "Unable to create default workspace" and the empty
# state never seeds.
#
# Where Documents lives is also an audit requirement: the workspace has to be
# stored in the netdisk app documents (网盘 → 应用文稿), not only inside the
# app's private volume, otherwise an app update looks like data loss to the
# user. /data/documents therefore becomes a LINK onto the per-user documents
# mount, so dsh keeps one stable absolute path while the files themselves live
# on the netdisk (surviving restarts, updates and reinstalls). Do not bind
# /lzcapp/documents in the manifest: the platform mounts it per user.
DOCS_DIR="${DSH_DOCUMENTS_DIR:-$DSH_HOME_DIR/documents}"
DOCS_ROOT="${DSH_DOCUMENTS_ROOT:-/lzcapp/documents}"
DOCS_WAIT="${DSH_DOCUMENTS_WAIT:-90}"
mkdir -p /usr/local/bin

# The platform mounts this app's documents at $DOCS_ROOT/<deploy-user>
# (verified on the box: /lzcsys/data/document/wans/.apps/<pkg> ->
# /lzcapp/documents/wans). The container runs as root, so `id -u` is 0 and says
# nothing useful — discover the mount by looking for the directory the platform
# created instead of guessing a uid.
netdisk_docs_dir() {
  [ -d "$DOCS_ROOT" ] || return 1
  wanted="${DSH_DOCUMENTS_USER:-${LZC_UID:-}}"
  found=""
  count=0
  for candidate in "$DOCS_ROOT"/*; do
    [ -d "$candidate" ] || continue
    name=$(basename "$candidate")
    case "$name" in .*|node_modules) continue ;; esac
    count=$((count + 1))
    [ -n "$found" ] || found="$candidate"
    if [ -n "$wanted" ] && [ "$name" = "$wanted" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  if [ "$count" -gt 1 ] && [ -z "$wanted" ]; then
    echo "WARN: $count document mounts under $DOCS_ROOT; using $found" >&2
  fi
  [ -n "$found" ] || return 1
  printf '%s\n' "$found"
  return 0
}

# Wait for the platform to mount this app's per-user documents. Starting dsh
# before that mount exists is the failure this app was rejected for twice: the
# Workspace then lands on the private volume (or nowhere), the agent's files end
# up outside 网盘 and outside the Workspace panel, and after a restart they are
# nowhere the user can see them.
NETDISK_DOCS=""
waited=0
while :; do
  if NETDISK_DOCS=$(netdisk_docs_dir); then
    break
  fi
  NETDISK_DOCS=""
  if [ "$waited" -ge "$DOCS_WAIT" ]; then break; fi
  if [ "$waited" -eq 0 ]; then echo "waiting up to ${DOCS_WAIT}s for a documents mount under $DOCS_ROOT ..."; fi
  sleep 5
  waited=$((waited + 5))
done

# Union-migrate a private-volume Documents directory into the netdisk folder,
# then keep the old path working as a link. Files the netdisk copy does not have
# are copied first; the private copy is only dropped once every file is present
# on the netdisk. This converges installs that started before the mount existed.
migrate_private_documents() {
  [ -d "$DOCS_DIR" ] || return 0
  [ -L "$DOCS_DIR" ] && return 0
  mkdir -p "$NETDISK_DOCS"
  echo "migrating private-volume Documents ($DOCS_DIR) into $NETDISK_DOCS"
  cp -a -n "$DOCS_DIR/." "$NETDISK_DOCS/" 2>/dev/null || true
  leftovers=$(cd "$DOCS_DIR" 2>/dev/null && find . \( -type f -o -type l \) 2>/dev/null | sed 's|^\./||' | while IFS= read -r rel; do
    [ -e "$NETDISK_DOCS/$rel" ] || printf '%s ' "$rel"
  done)
  if [ -n "$leftovers" ]; then
    echo "WARN: $DOCS_DIR stays a directory; not migrated: $leftovers" >&2
    return 0
  fi
  rm -rf "$DOCS_DIR"
  ln -sfn "$NETDISK_DOCS" "$DOCS_DIR"
}

if [ -n "$NETDISK_DOCS" ]; then
  if [ -e "$DOCS_DIR" ] && [ ! -L "$DOCS_DIR" ]; then
    migrate_private_documents
  fi
  if [ -L "$DOCS_DIR" ] || [ ! -e "$DOCS_DIR" ]; then
    ln -sfn "$NETDISK_DOCS" "$DOCS_DIR"
    DOCS_EFFECTIVE="$NETDISK_DOCS"
    echo "Documents (workspace root) -> $NETDISK_DOCS"
  else
    DOCS_EFFECTIVE="$DOCS_DIR"
    echo "WARN: $DOCS_DIR stays a directory; netdisk copy is $NETDISK_DOCS" >&2
  fi
else
  mkdir -p "$DOCS_DIR"
  DOCS_EFFECTIVE="$DOCS_DIR"
  echo "WARN: no per-user documents mount under $DOCS_ROOT after ${DOCS_WAIT}s; Documents stays at $DOCS_DIR (not visible in 网盘)" >&2
fi

# The default Workspace has to exist before dsh boots. A missing one is why a
# first page load fails to seed and why sessions can fall back to the process
# cwd (/data), where nothing the user needs is reachable from the UI or 网盘.
WORKSPACE_DIR="${DSH_WORKSPACE_DIR:-$DOCS_EFFECTIVE/deepseek-harness/default-workspace}"
mkdir -p "$WORKSPACE_DIR"
echo "default workspace -> $WORKSPACE_DIR"

# Agent-visible HOME and TMPDIR stay on the private volume, so anything a task
# writes through `~` or a temp path also survives a restart or an app update.
mkdir -p "$DSH_HOME_DIR/home" "$DSH_HOME_DIR/tmp"
export HOME="$DSH_HOME_DIR/home"
export TMPDIR="$DSH_HOME_DIR/tmp"
export XDG_CONFIG_HOME="$HOME/.config"
export XDG_CACHE_HOME="$HOME/.cache"
export XDG_DATA_HOME="$HOME/.local/share"
export XDG_STATE_HOME="$HOME/.local/state"

# Never shadow a real xdg-user-dir: when upstream starts shipping one, it wins.
EXISTING_XDG=$(command -v xdg-user-dir || true)
if [ -z "$EXISTING_XDG" ] || [ "$EXISTING_XDG" = /usr/local/bin/xdg-user-dir ]; then
  cat > /usr/local/bin/xdg-user-dir <<SHIM
#!/bin/sh
# Minimal xdg-user-dir for this image: DSH asks for DOCUMENTS on first use.
case "\${1:-}" in
  DOCUMENTS) printf '%s\n' "$DOCS_EFFECTIVE" ;;
  *)         printf '%s\n' "\${HOME:-/root}" ;;
esac
SHIM
  chmod 0755 /usr/local/bin/xdg-user-dir
  echo "installed xdg-user-dir shim (DOCUMENTS=$DOCS_DIR)"
else
  echo "keeping system xdg-user-dir at $EXISTING_XDG"
fi

# --- 2. plugin market reconciliation ---------------------------------------
# Fresh install: seed the whole profile from the image template.
if [ -d "$TPL" ] && [ ! -d "$MARKET_DIR" ]; then
  echo "seeding bundled plugin market into $DSH_HOME_DIR/profiles"
  mkdir -p "$DSH_HOME_DIR/profiles"
  cp -a "$TPL/." "$DSH_HOME_DIR/profiles/" 2>/dev/null || true
fi

# Existing install: the market version carried in /data may be too old for the
# dsh release in this image (peer range mismatch => dsh skips the bundle and the
# Plugin Market page disappears). Re-vendor only the market subtree from the
# image when the shipped one is strictly newer; never touch the rest of /data.
if [ -f "$MARKET_DIR/package.json" ] && [ -d "$TPL/web/node_modules/dshmarket" ]; then
  HAVE=$(node -e "try{process.stdout.write(require('$MARKET_DIR/package.json').version)}catch(e){process.stdout.write('0.0.0')}" 2>/dev/null || echo 0.0.0)
  WANT=$(node -e "try{process.stdout.write(require('$TPL/web/node_modules/dshmarket/package.json').version)}catch(e){process.stdout.write('0.0.0')}" 2>/dev/null || echo 0.0.0)
  if [ "$HAVE" != "$WANT" ]; then
    NEWER=$(node -e "
      const semver=require('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/semver');
      try{process.stdout.write(semver.gt('$WANT','$HAVE')?'yes':'no')}catch(e){process.stdout.write('no')}
    " 2>/dev/null || echo no)
    if [ "$NEWER" = "yes" ]; then
      echo "reconciling plugin market $HAVE -> $WANT"
      mkdir -p "$WEBPROF/node_modules"
      rm -rf "$MARKET_DIR"
      cp -a "$TPL/web/node_modules/dshmarket" "$MARKET_DIR"
      # keep the market's own runtime deps aligned with the shipped ones
      for dep in js-yaml undici; do
        if [ -d "$TPL/web/node_modules/$dep" ]; then
          rm -rf "$WEBPROF/node_modules/$dep"
          cp -a "$TPL/web/node_modules/$dep" "$WEBPROF/node_modules/$dep"
        fi
      done
      node -e "
        const fs=require('node:fs');
        const p='$WEBPROF/package.json';
        try{
          const j=JSON.parse(fs.readFileSync(p,'utf8'));
          j.dependencies=j.dependencies||{};
          j.dependencies.dshmarket='$WANT';
          fs.writeFileSync(p, JSON.stringify(j,null,2)+'\n');
        }catch(e){}
      " 2>/dev/null || true
    else
      echo "keeping user plugin market $HAVE (image ships $WANT)"
    fi
  fi
fi

# --- 2b. keep the agent's default working directory inside the Workspace -----
# A Session without a recorded cwd (API/automation/first-load races) falls back
# to this service's defaultDirectory, which upstream defaults to the process cwd
# (/data). Writing there is invisible in the Workspace panel and in 网盘, and it
# is what "the file the AI wrote is gone" looks like from the outside. Point the
# fallback at the Workspace instead: the worst case then still lands where the
# user can see it.
PATCH_FILE="$WEBPROF/cordis.patch.yml"
WORKDIR_SCRIPT="/lzcapp/pkg/content/patch-dsh-working-directory.js"
# dsh keeps user settings (custom model providers, ui-settings-general, …) in the
# SAME file, appended after ours. The old implementation owned a marker block and
# rewrote everything between the markers, so every start deleted the user's
# models ("自定义模型在重启后消失"). Own one entry instead: patch exactly the
# `- id: working-directory` item and leave the rest byte-for-byte alone.
write_working_directory_patch() {
  mkdir -p "$WEBPROF"
  if [ ! -f "$WORKDIR_SCRIPT" ]; then
    # Refuse the old wipe-the-block behaviour: losing user settings is worse
    # than losing the default working directory.
    echo "WARN: $WORKDIR_SCRIPT missing; leaving $PATCH_FILE untouched" >&2
    return 1
  fi
  node "$WORKDIR_SCRIPT" "$PATCH_FILE" "$WORKSPACE_DIR"
}
if write_working_directory_patch; then :; else
  echo "WARN: could not write the working-directory patch; sessions may fall back to /data" >&2
fi
# --- 2c. re-create working directories recorded by older releases -----------
# Sessions opened before 1.1.16 point at /root/<name>; section 0 makes that path
# durable again, and this recreates whatever is still missing so an old session
# can be continued instead of failing the whole turn.
WORKDIR_REPAIR="/lzcapp/pkg/content/patch-dsh-workspace-dirs.js"
if [ -f "$WORKDIR_REPAIR" ]; then
  node "$WORKDIR_REPAIR" "$DSH_HOME_DIR/storages/workspace.json" "$DSH_HOME_DIR/sessions" || \
    echo "WARN: could not repair recorded working directories" >&2
fi

# --- 3. Settings persistence repair + market preview images ----------------
if [ -f /lzcapp/pkg/content/dsh-proxy.mjs ]; then
  cp -f /lzcapp/pkg/content/dsh-proxy.mjs /dsh-proxy.mjs
fi
# Auto-update posture: an upstream layout change must degrade a convenience
# patch, never take the app down. Both patches are idempotent and optional.
run_patch() {
  if ! node "$1"; then
    echo "WARN: $1 failed; continuing without it (upstream layout may have changed)" >&2
  fi
}
run_patch /lzcapp/pkg/content/patch-dsh-settings.js
# The market asks a third-party image resizer for every thumbnail; that host is
# not reachable from here, so point the previews at the app's own proxy. Runs
# after the market reconcile above, and is idempotent.
run_patch /lzcapp/pkg/content/patch-dsh-market-images.js

# --- 4. run -----------------------------------------------------------------
exec /entry.sh
