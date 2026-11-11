#!/usr/bin/env bash
# Upgrade (or roll back) this host's buzz-relay, buzz-admin, buzz (CLI) and
# sprig (agent harness for the buzz-agent@ units) from source.
#
# Upgrade:
#   1. git fetch + fast-forward (or --rebase) the checked-out branch
#   2. cargo build --release buzz-relay, buzz-admin, buzz-cli (binary `buzz`),
#      sprig
#   3. stage commit-stamped binaries in /opt/buzz/bin (live links untouched)
#   4. stop buzz-relay, back up the database (pg_dump) and relay.env
#   5. run DB migrations with the NEW buzz-admin (`buzz-admin migrate`)
#   6. repoint /opt/buzz/bin/{buzz-relay,buzz-admin,buzz} and the all-users
#      /usr/local/bin links at the new build, start the relay, wait for
#      /_readiness
#   7. restart running buzz-agent@ units so they use the new sprig
#   If 5 or 6 fails, it automatically falls back: restores the pre-upgrade
#   database, repoints the links at the previous build and restarts it.
#
# Rollback (manual fallback to the build before the last upgrade):
#   ./update-buzz-relay.sh --rollback            restore DB + previous binaries
#   ./update-buzz-relay.sh --rollback --no-db    previous binaries only
#   --rollback DIR picks a specific backup run instead of the latest.
#   Restoring the DB discards everything written since that upgrade (a dump of
#   the current state is saved first).
#
# Run as your normal user (not root); sudo is used for install/service/DB steps.
#
# Usage: ./update-buzz-relay.sh [options]
#   typical: ./update-buzz-relay.sh --rebase origin/main
#   --repo DIR        source checkout to build (default: this script's dir)
#   --rebase REF      rebase the current branch onto REF (e.g. origin/main)
#                     instead of fast-forwarding from its upstream; use this
#                     to carry local patches forward
#   --no-pull         build the current HEAD without fetching/pulling
#   --no-auto-rollback  on failure, leave things as they are for inspection
#   --keep N          keep the N newest builds of each binary (default 3)
#   --keep-backups N  keep the N newest backup runs (default 5)
#   --rollback [DIR]  roll back instead of upgrading (see above)
#   --no-db           with --rollback: do not restore the database
#   --yes             do not ask for confirmation
#   -h, --help        show this help
#
# Env overrides: BUZZ_BACKUP_ROOT (default ~/buzz-backups/relay-upgrades),
#   BUZZ_PG_CONTAINER (default buzz-postgres).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$SCRIPT_DIR"
REBASE_REF=""
DO_PULL=1
AUTO_ROLLBACK=1
KEEP=3
KEEP_BACKUPS=5
MODE=upgrade
ROLLBACK_DIR=""
RESTORE_DB=1
ASSUME_YES=0

INSTALL_DIR=/opt/buzz/bin
PUBLIC_BIN=/usr/local/bin
SERVICE=buzz-relay.service
SERVICE_USER=buzz
SERVICE_DIR=/var/lib/buzz
ENV_FILE=/etc/buzz/relay.env
PG_CONTAINER="${BUZZ_PG_CONTAINER:-buzz-postgres}"
BACKUP_ROOT="${BUZZ_BACKUP_ROOT:-$HOME/buzz-backups/relay-upgrades}"
# Cargo packages to build, and the binaries they produce (installed + linked).
PACKAGES=(buzz-relay buzz-admin buzz-cli sprig)
BINARIES=(buzz-relay buzz-admin buzz sprig)
# sprig is multicall: these fixed links select its personality by argv[0].
SPRIG_PERSONALITIES=(buzz-acp buzz-agent buzz-dev-mcp)
# Binaries that must already be installed (the service and migrations need
# them); others may be installed for the first time.
REQUIRED=(buzz-relay buzz-admin)
declare -A PREV=()   # binary -> previously live build file ("" = none)
READY_TIMEOUT=180

die() { echo "error: $*" >&2; exit 1; }
log() { echo "==> $*"; }
warn() { echo "warning: $*" >&2; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="$(cd "${2:?--repo needs a dir}" && pwd)"; shift 2 ;;
    --rebase) REBASE_REF="${2:?--rebase needs a ref}"; shift 2 ;;
    --no-pull) DO_PULL=0; shift ;;
    --no-auto-rollback) AUTO_ROLLBACK=0; shift ;;
    --keep) KEEP="${2:?--keep needs a number}"; shift 2 ;;
    --keep-backups) KEEP_BACKUPS="${2:?--keep-backups needs a number}"; shift 2 ;;
    --rollback)
      MODE=rollback
      if [[ $# -gt 1 && "$2" != -* ]]; then ROLLBACK_DIR="$2"; shift; fi
      shift ;;
    --no-db) RESTORE_DB=0; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

[[ $EUID -ne 0 ]] || die "run as your normal user; sudo is invoked where needed"
[[ "$KEEP" =~ ^[1-9][0-9]*$ ]] || die "--keep must be a positive integer"
[[ "$KEEP_BACKUPS" =~ ^[1-9][0-9]*$ ]] || die "--keep-backups must be a positive integer"

# Check sudo up front so the run doesn't stall halfway through. Not `sudo -v`:
# with mixed sudoers rules it demands a password even when commands are NOPASSWD.
sudo -n true 2>/dev/null || sudo true || die "sudo is required"

# One upgrade/rollback at a time.
mkdir -p "$BACKUP_ROOT" && chmod 700 "$BACKUP_ROOT"
exec 9>"$BACKUP_ROOT/.lock"
flock -n 9 || die "another upgrade/rollback is running (lock: $BACKUP_ROOT/.lock)"

# --- database target, from the relay's own config ---------------------------
env_value() { # env_value KEY -> last value of KEY in $ENV_FILE, unquoted
  sudo sed -n "s/^$1=//p" "$ENV_FILE" | tail -1 | sed -E "s/^[\"']//; s/[\"']$//"
}
DATABASE_URL_VALUE="$(env_value DATABASE_URL)"
[[ -n "$DATABASE_URL_VALUE" ]] || die "DATABASE_URL not set in $ENV_FILE"
_url="${DATABASE_URL_VALUE#*://}"; _url="${_url%%\?*}"
PG_DB="${_url##*/}"
_creds="${_url%%@*}"; PG_USER="${_creds%%:*}"
[[ -n "$PG_DB" && -n "$PG_USER" && "$PG_DB" != "$_url" ]] \
  || die "could not parse database/user from DATABASE_URL"
docker inspect "$PG_CONTAINER" >/dev/null 2>&1 || die "postgres container $PG_CONTAINER not found"

BIND="$(env_value BUZZ_BIND_ADDR)"
BIND="${BIND:-127.0.0.1:3000}"
BIND="${BIND/0.0.0.0/127.0.0.1}"
HEALTH_PORT="$(env_value BUZZ_HEALTH_PORT)"

# --- helpers -----------------------------------------------------------------
pg() { docker exec -i "$PG_CONTAINER" "$@"; }

dump_db() { # dump_db FILE — consistent custom-format dump, verified readable
  pg pg_dump -U "$PG_USER" -Fc "$PG_DB" > "$1.partial" || { rm -f "$1.partial"; return 1; }
  [[ -s "$1.partial" ]] || { rm -f "$1.partial"; return 1; }
  pg pg_restore --list < "$1.partial" >/dev/null || { rm -f "$1.partial"; return 1; }
  chmod 600 "$1.partial" && mv "$1.partial" "$1"
}

restore_db() { # restore_db FILE — replace the database with FILE's contents
  log "restoring database $PG_DB from $1"
  # Explicit && chain: callers use `restore_db || ...`, which disables set -e.
  pg dropdb -U "$PG_USER" --maintenance-db=postgres --if-exists --force "$PG_DB" \
    && pg createdb -U "$PG_USER" --maintenance-db=postgres -O "$PG_USER" "$PG_DB" \
    && pg pg_restore -U "$PG_USER" -d "$PG_DB" --exit-on-error < "$1"
}

swap_link() { # swap_link TARGET LINK — atomic symlink replacement
  sudo ln -sfn "$1" "$2.new" && sudo mv -Tf "$2.new" "$2" || die "could not update link $2"
}

prev_var() { local v="${1//-/_}"; echo "PREV_${v^^}"; } # buzz-relay -> PREV_BUZZ_RELAY

# point_links SUFFIX|prev — link every binary to "<bin>-SUFFIX", or with
# "prev" to the build recorded in PREV (removing links a first install added).
# All targets are checked before any link moves, so a switch is never partial.
point_links() {
  local b target
  declare -A want=()
  for b in "${BINARIES[@]}"; do
    if [[ $1 == prev ]]; then target="${PREV[$b]:-}"; else target="$b-$1"; fi
    [[ -z "$target" || -x "$INSTALL_DIR/$target" ]] || die "missing $INSTALL_DIR/$target"
    want[$b]="$target"
  done
  for b in "${BINARIES[@]}"; do
    if [[ -z "${want[$b]}" ]]; then
      sudo rm -f "$INSTALL_DIR/$b" "$PUBLIC_BIN/$b" || die "could not remove links for $b"
    else
      swap_link "${want[$b]}" "$INSTALL_DIR/$b"
      swap_link "$INSTALL_DIR/$b" "$PUBLIC_BIN/$b"
    fi
  done
}

# Keep sprig's personality links pointing at the rotating sprig link.
ensure_sprig_links() {
  local p
  [[ -e "$INSTALL_DIR/sprig" ]] || return 0
  for p in "${SPRIG_PERSONALITIES[@]}"; do swap_link sprig "$INSTALL_DIR/$p"; done
}

# Restart agent units that are running, so they pick up the current sprig.
# Best-effort: an agent failing to restart must not fail a relay upgrade.
restart_agents() {
  local units
  units="$(systemctl list-units --type=service --state=active --plain --no-legend 'buzz-agent@*' | awk '{print $1}')"
  [[ -n "$units" ]] || return 0
  log "restarting agents: $(echo $units)"
  # shellcheck disable=SC2086
  sudo systemctl restart $units || warn "some agents failed to restart; check 'systemctl status buzz-agent@*'"
}

# load_state RUN_DIR — fill PREV and NEW_SHA from a backup run's state file.
load_state() {
  local b v PREV_RELAY="" PREV_ADMIN=""
  NEW_SHA=""
  for b in "${BINARIES[@]}"; do unset "$(prev_var "$b")"; done
  # shellcheck disable=SC1091
  . "$1/state"
  for b in "${BINARIES[@]}"; do v="$(prev_var "$b")"; PREV[$b]="${!v:-}"; done
  # State files from before buzz-cli was added used these names.
  [[ -n "${PREV[buzz-relay]}" ]] || PREV[buzz-relay]="$PREV_RELAY"
  [[ -n "${PREV[buzz-admin]}" ]] || PREV[buzz-admin]="$PREV_ADMIN"
  [[ -n "${PREV[buzz-relay]}" && -n "${PREV[buzz-admin]}" ]] \
    || die "$1/state does not name a previous buzz-relay and buzz-admin"
}

run_migrations() { # run_migrations ADMIN_FILE — same user + env as the service
  sudo systemd-run --quiet --wait --pipe --collect --service-type=exec \
    -p User="$SERVICE_USER" -p Group="$SERVICE_USER" \
    -p EnvironmentFile="$ENV_FILE" -p WorkingDirectory="$SERVICE_DIR" \
    "$INSTALL_DIR/$1" migrate
}

wait_ready() {
  local deadline=$((SECONDS + READY_TIMEOUT))
  log "waiting up to ${READY_TIMEOUT}s for http://$BIND/_readiness"
  until curl -fsS -o /dev/null --max-time 5 "http://$BIND/_readiness"; do
    (( SECONDS < deadline )) || return 1
    sleep 2
  done
}

confirm() { # confirm PROMPT
  [[ $ASSUME_YES -eq 1 ]] && return 0
  local reply
  read -r -p "$1 Type 'yes' to continue: " reply </dev/tty
  [[ "$reply" == yes ]] || die "aborted"
}

# fall_back RUN_DIR — restore pre-upgrade DB + previous binaries, restart.
fall_back() {
  local run="$1"
  load_state "$run"
  log "FALLING BACK to ${PREV[buzz-relay]} / ${PREV[buzz-admin]} / ${PREV[buzz]:-no buzz CLI}"
  sudo systemctl stop "$SERVICE" || true
  if [[ $RESTORE_DB -eq 1 ]]; then
    [[ -s "$run/db.dump" ]] || die "no database dump in $run; cannot restore"
    log "saving current database state to $run/db-before-rollback.dump"
    dump_db "$run/db-before-rollback.dump" \
      || warn "could not dump current state; continuing with restore"
    restore_db "$run/db.dump" || die "database restore FAILED; relay left stopped. Dump: $run/db.dump"
  fi
  # Called from `... || failed`, where set -e is off: check each step.
  point_links prev
  ensure_sprig_links
  sudo systemctl start "$SERVICE" || die "could not start $SERVICE after fallback"
  if wait_ready; then
    log "fallback complete: running $(readlink "$INSTALL_DIR/buzz-relay")"
    restart_agents
  else
    sudo journalctl -u "$SERVICE" -n 40 --no-pager >&2 || true
    die "relay is not ready even after fallback; inspect 'journalctl -u $SERVICE'"
  fi
}

# --- manual rollback -----------------------------------------------------------
if [[ $MODE == rollback ]]; then
  if [[ -z "$ROLLBACK_DIR" ]]; then
    ROLLBACK_DIR="$(ls -1d "$BACKUP_ROOT"/*/ 2>/dev/null | sort | tail -1)"
    [[ -n "$ROLLBACK_DIR" ]] || die "no backup runs in $BACKUP_ROOT"
  fi
  ROLLBACK_DIR="${ROLLBACK_DIR%/}"
  [[ -f "$ROLLBACK_DIR/state" ]] || die "$ROLLBACK_DIR has no state file"
  load_state "$ROLLBACK_DIR"
  echo "Backup run:  $ROLLBACK_DIR"
  echo "Upgrade was: ${PREV[buzz-relay]} -> buzz-relay-${NEW_SHA}"
  echo "Now live:    $(readlink "$INSTALL_DIR/buzz-relay")"
  for b in "${BINARIES[@]}"; do echo "  $b -> ${PREV[$b]:-(remove link)}"; done
  echo "Restore DB:  $([[ $RESTORE_DB -eq 1 ]] && echo "yes, $PG_DB from db.dump (later writes are lost)" || echo no)"
  confirm "Roll back?"
  fall_back "$ROLLBACK_DIR"
  exit 0
fi

# --- 1. fetch / update source ------------------------------------------------
git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1 || die "$REPO is not a git checkout"
cd "$REPO"
BRANCH="$(git branch --show-current)"
[[ -n "$BRANCH" ]] || die "detached HEAD in $REPO; check out a branch first"
log "repo: $REPO  branch: $BRANCH  (HEAD $(git rev-parse --short=9 HEAD))"

if [[ $DO_PULL -eq 1 ]]; then
  # Untracked files are fine; modified tracked files are not.
  git diff --quiet && git diff --cached --quiet \
    || die "uncommitted changes in $REPO; commit or stash first"
  log "fetching all remotes"
  git fetch --all --prune
  if [[ -n "$REBASE_REF" ]]; then
    log "rebasing $BRANCH onto $REBASE_REF"
    git rebase "$REBASE_REF" \
      || die "rebase stopped on a conflict; resolve it (or 'git rebase --abort') and re-run with --no-pull"
  else
    git rev-parse --abbrev-ref '@{upstream}' >/dev/null 2>&1 \
      || die "$BRANCH has no upstream; set one or use --rebase REF"
    log "fast-forwarding $BRANCH from $(git rev-parse --abbrev-ref '@{upstream}')"
    git merge --ff-only '@{upstream}' \
      || die "$BRANCH has diverged from its upstream; use --rebase REF to carry local commits"
  fi
fi

SHA="$(git rev-parse --short=9 HEAD)"
log "building $SHA: $(git log -1 --format=%s)"

# --- 2. build ---------------------------------------------------------------------
if [[ -f ./bin/activate-hermit ]]; then
  # shellcheck disable=SC1091
  . ./bin/activate-hermit >/dev/null
fi
# Stamp build identity: relay and admin read these via option_env! and report
# them (relay: /_status on the health port; buzz-admin: partition-audit).
BUZZ_SOURCE_SHA="$(git rev-parse HEAD)"
BUZZ_BUILD_ID="$(hostname -s)-$BRANCH-$(date -u +%Y%m%dT%H%M%SZ)"
export BUZZ_SOURCE_SHA BUZZ_BUILD_ID
cargo build --release $(printf -- '-p %s ' "${PACKAGES[@]}")
for b in "${BINARIES[@]}"; do
  [[ -x "target/release/$b" ]] || die "build did not produce target/release/$b"
done

# --- 3. stage binaries (live links unchanged) ---------------------------------------
for b in "${BINARIES[@]}"; do
  PREV[$b]="$(readlink "$INSTALL_DIR/$b" 2>/dev/null || true)"
done
for b in "${REQUIRED[@]}"; do
  [[ -n "${PREV[$b]}" ]] || die "$INSTALL_DIR/$b must be a symlink to a current build"
done
[[ "${PREV[buzz-relay]}" != "buzz-relay-$SHA" ]] || die "buzz-relay $SHA is already live; nothing to upgrade"

sudo install -d -m 755 "$INSTALL_DIR"
for b in "${BINARIES[@]}"; do
  log "staging $INSTALL_DIR/$b-$SHA"
  sudo install -m 755 -o root -g root "target/release/$b" "$INSTALL_DIR/$b-$SHA.tmp"
  sudo mv -f "$INSTALL_DIR/$b-$SHA.tmp" "$INSTALL_DIR/$b-$SHA"
done

# --- 4. stop + back up ---------------------------------------------------------------
RUN_DIR="$BACKUP_ROOT/$(date -u +%Y%m%dT%H%M%SZ)-$SHA"
mkdir -m 700 "$RUN_DIR"
{
  for b in "${BINARIES[@]}"; do echo "$(prev_var "$b")=${PREV[$b]}"; done
  echo "NEW_SHA=$SHA"
} > "$RUN_DIR/state"
sudo install -m 600 -o "$(id -u)" -g "$(id -g)" "$ENV_FILE" "$RUN_DIR/relay.env"

log "stopping $SERVICE"
sudo systemctl stop "$SERVICE"

log "backing up database $PG_DB to $RUN_DIR/db.dump"
if ! dump_db "$RUN_DIR/db.dump"; then
  warn "database backup failed; restarting the unchanged relay"
  sudo systemctl start "$SERVICE"
  die "aborted before any changes (staged binaries left in $INSTALL_DIR)"
fi
log "backup ok ($(du -h "$RUN_DIR/db.dump" | cut -f1))"

failed() { # failed REASON
  warn "$1"
  sudo journalctl -u "$SERVICE" -n 40 --no-pager >&2 || true
  if [[ $AUTO_ROLLBACK -eq 1 ]]; then
    fall_back "$RUN_DIR"
    die "upgrade to $SHA failed ($1); rolled back to ${PREV[buzz-relay]}"
  fi
  die "upgrade to $SHA failed ($1). Roll back with: $0 --rollback $RUN_DIR"
}

# --- 5. migrations -------------------------------------------------------------------
log "running database migrations with buzz-admin-$SHA"
run_migrations "buzz-admin-$SHA" || failed "database migrations failed"

# --- 6. switch + start ---------------------------------------------------------------
point_links "$SHA"
ensure_sprig_links
log "starting $SERVICE"
sudo systemctl start "$SERVICE"
wait_ready || failed "relay did not become ready within ${READY_TIMEOUT}s"

# Confirm the process now serving is the build we just installed.
if [[ -n "$HEALTH_PORT" ]]; then
  served="$(curl -fsS --max-time 5 "http://127.0.0.1:$HEALTH_PORT/_status" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["build"]["source_sha"])' 2>/dev/null || true)"
  if [[ -z "$served" ]]; then
    warn "could not read build identity from /_status on port $HEALTH_PORT"
  elif [[ "$served" != "$BUZZ_SOURCE_SHA" ]]; then
    failed "relay is ready but /_status reports source_sha $served, expected $BUZZ_SOURCE_SHA"
  else
    log "/_status confirms source_sha $served"
  fi
fi

restart_agents

# --- 7. prune ------------------------------------------------------------------------
# Old builds: keep the newest $KEEP, and never the live or previous build.
for b in "${BINARIES[@]}"; do
  live="$(readlink "$INSTALL_DIR/$b")"
  prev="${PREV[$b]:-}"
  # `|| true`: no candidates makes grep exit 1, which pipefail would turn into
  # a failed run after a successful upgrade.
  { ls -1t "$INSTALL_DIR" | grep -E "^$b-[0-9a-f]+$" | grep -vxF -e "$live" -e "$prev" || true; } \
    | tail -n +"$KEEP" | while read -r f; do
        log "pruning $INSTALL_DIR/$f"
        sudo rm -f "$INSTALL_DIR/$f"
      done
done
ls -1d "$BACKUP_ROOT"/*/ 2>/dev/null | sort | head -n -"$KEEP_BACKUPS" | while read -r d; do
  log "pruning backup $d"
  rm -rf "$d"
done

log "buzz-relay $SHA is up (previous: ${PREV[buzz-relay]})"
log "backup: $RUN_DIR   rollback: $0 --rollback"
for b in "${BINARIES[@]}"; do echo "    $PUBLIC_BIN/$b -> $(readlink -f "$PUBLIC_BIN/$b")"; done
