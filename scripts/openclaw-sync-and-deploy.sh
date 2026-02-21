#!/usr/bin/env bash

set -euo pipefail

BASE_DIR="${OPENCLAW_BASE_DIR:-$HOME/Development}"
CANONICAL_REPO="${OPENCLAW_CANONICAL_REPO:-$BASE_DIR/openclaw-fly-ha-only}"
MAIN_DIR="${OPENCLAW_MAIN_DIR:-$BASE_DIR/openclaw-main}"
HA_DIR="${OPENCLAW_HA_DIR:-$BASE_DIR/openclaw-ha}"
IFTTT_DIR="${OPENCLAW_IFTTT_DIR:-$BASE_DIR/openclaw-ifttt}"
DEPLOY_DIR="${OPENCLAW_DEPLOY_DIR:-$BASE_DIR/openclaw-deploy-prod}"
HUCKLEBRIDGE_OPENCLAWCHAT_DIR="${OPENCLAW_HUCKLEBRIDGE_OPENCLAWCHAT_DIR:-$BASE_DIR/hucklebridge-openclawchat}"
UPSTREAM_REMOTE="${OPENCLAW_UPSTREAM_REMOTE:-origin}"
PUSH_REMOTE="${OPENCLAW_PUSH_REMOTE:-origin}"
FLY_APP="${OPENCLAW_FLY_APP:-bogle-oc-bot}"

SKIP_PUSH=1
SKIP_DEPLOY=0
REBASE_HA=0
DEPLOY_ARGS=(--local-only --depot=false --now)

usage() {
  cat <<'EOF'
Usage: openclaw-sync-and-deploy.sh [options]

Sync OpenClaw worktrees, push custom branches, and deploy deploy/prod to Fly.

Options:
  --app <name>          Fly app name (default: bogle-oc-bot or OPENCLAW_FLY_APP)
  --push-remote <name>  Remote for pushes (default: origin or OPENCLAW_PUSH_REMOTE)
  --rebase-ha           Rebase custom/ha onto latest main (default: off)
  --push                Enable git push of custom/deploy branches (default: off)
  --skip-push           Skip pushing branches
  --skip-deploy         Skip Fly deploy
  -h, --help            Show help

Environment overrides:
  OPENCLAW_BASE_DIR
  OPENCLAW_CANONICAL_REPO
  OPENCLAW_MAIN_DIR
  OPENCLAW_HA_DIR
  OPENCLAW_IFTTT_DIR
  OPENCLAW_DEPLOY_DIR
  OPENCLAW_HUCKLEBRIDGE_OPENCLAWCHAT_DIR
  OPENCLAW_UPSTREAM_REMOTE
  OPENCLAW_PUSH_REMOTE
  OPENCLAW_FLY_APP
EOF
}

while (($# > 0)); do
  case "$1" in
    --app)
      FLY_APP="${2:-}"
      shift 2
      ;;
    --push-remote)
      PUSH_REMOTE="${2:-}"
      shift 2
      ;;
    --rebase-ha)
      REBASE_HA=1
      shift
      ;;
    --push)
      SKIP_PUSH=0
      shift
      ;;
    --skip-push)
      SKIP_PUSH=1
      shift
      ;;
    --skip-deploy)
      SKIP_DEPLOY=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

log() {
  printf '\n[%s] %s\n' "$(date +%H:%M:%S)" "$*"
}

fail() {
  echo "Error: $*" >&2
  exit 1
}

run() {
  echo "+ $*"
  "$@"
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

require_repo_dir() {
  local path="$1"
  [[ -e "$path/.git" ]] || fail "not a git repository directory: $path"
}

require_dir() {
  local path="$1"
  [[ -d "$path" ]] || fail "required directory not found: $path"
}

require_clean_tree() {
  local path="$1"
  local label="$2"
  if [[ -n "$(git -C "$path" status --porcelain)" ]]; then
    fail "$label has uncommitted changes: $path"
  fi
}

ensure_branch() {
  local repo="$1"
  local branch="$2"
  local start_point="$3"
  if git -C "$repo" show-ref --verify --quiet "refs/heads/$branch"; then
    return
  fi
  run git -C "$repo" branch "$branch" "$start_point"
}

ensure_worktree() {
  local path="$1"
  local branch="$2"
  if [[ -e "$path/.git" ]]; then
    return
  fi
  run git -C "$CANONICAL_REPO" worktree add "$path" "$branch"
}

merge_if_needed() {
  local target_dir="$1"
  local branch="$2"
  if git -C "$target_dir" merge-base --is-ancestor "$branch" HEAD; then
    log "deploy/prod already contains $branch"
    return
  fi
  if ! git -C "$target_dir" merge --no-edit "$branch"; then
    git -C "$target_dir" merge --abort >/dev/null 2>&1 || true
    fail "merge conflict while integrating $branch into deploy/prod ($target_dir)"
  fi
}

safe_rebase() {
  local repo_dir="$1"
  local onto="$2"
  if ! git -C "$repo_dir" rebase "$onto"; then
    git -C "$repo_dir" rebase --abort >/dev/null 2>&1 || true
    fail "rebase conflict in $repo_dir onto $onto"
  fi
}

sync_if_git_repo() {
  local path="$1"
  local label="$2"
  if [[ ! -e "$path/.git" ]]; then
    log "$label exists but is not a git repo; skipping git sync ($path)"
    return
  fi

  require_clean_tree "$path" "$label"
  local branch
  branch="$(git -C "$path" branch --show-current || true)"
  if [[ -z "$branch" ]]; then
    log "$label is detached HEAD; skipping pull ($path)"
    return
  fi

  log "Syncing $label ($branch)"
  run git -C "$path" fetch origin
  run git -C "$path" pull --ff-only origin "$branch"
}

need_cmd git
need_cmd fly

require_repo_dir "$CANONICAL_REPO"
require_dir "$HUCKLEBRIDGE_OPENCLAWCHAT_DIR"

log "Fetching latest refs in canonical repo"
run git -C "$CANONICAL_REPO" fetch "$UPSTREAM_REMOTE"

MAIN_START="$UPSTREAM_REMOTE/main"

log "Ensuring required branches exist"
ensure_branch "$CANONICAL_REPO" main "$MAIN_START"
ensure_branch "$CANONICAL_REPO" custom/ha main
ensure_branch "$CANONICAL_REPO" custom/ifttt main
ensure_branch "$CANONICAL_REPO" deploy/prod custom/ha

log "Ensuring required worktrees exist"
ensure_worktree "$MAIN_DIR" main
ensure_worktree "$HA_DIR" custom/ha
ensure_worktree "$IFTTT_DIR" custom/ifttt
ensure_worktree "$DEPLOY_DIR" deploy/prod

require_repo_dir "$MAIN_DIR"
require_repo_dir "$HA_DIR"
require_repo_dir "$IFTTT_DIR"
require_repo_dir "$DEPLOY_DIR"

require_clean_tree "$MAIN_DIR" "main worktree"
require_clean_tree "$HA_DIR" "custom/ha worktree"
require_clean_tree "$IFTTT_DIR" "custom/ifttt worktree"
require_clean_tree "$DEPLOY_DIR" "deploy/prod worktree"

sync_if_git_repo "$HUCKLEBRIDGE_OPENCLAWCHAT_DIR" "hucklebridge-openclawchat"

log "Updating main worktree to latest $UPSTREAM_REMOTE/main"
run git -C "$MAIN_DIR" switch main
run git -C "$MAIN_DIR" fetch "$UPSTREAM_REMOTE"
run git -C "$MAIN_DIR" pull --ff-only "$UPSTREAM_REMOTE" main

log "Updating custom/ha branch"
run git -C "$HA_DIR" switch custom/ha
run git -C "$HA_DIR" fetch "$UPSTREAM_REMOTE"
if ((REBASE_HA == 1)); then
  log "Rebasing custom/ha onto latest main (--rebase-ha)"
  safe_rebase "$HA_DIR" "$UPSTREAM_REMOTE/main"
else
  log "Skipping custom/ha rebase (default). Use --rebase-ha to enable."
fi

log "Fast-forwarding custom/ifttt to latest main"
run git -C "$IFTTT_DIR" switch custom/ifttt
run git -C "$IFTTT_DIR" fetch "$UPSTREAM_REMOTE"
run git -C "$IFTTT_DIR" merge --ff-only "$UPSTREAM_REMOTE/main"

log "Refreshing deploy/prod base and merging custom branches"
run git -C "$DEPLOY_DIR" switch deploy/prod
run git -C "$DEPLOY_DIR" fetch "$UPSTREAM_REMOTE"
safe_rebase "$DEPLOY_DIR" "$UPSTREAM_REMOTE/main"
merge_if_needed "$DEPLOY_DIR" custom/ha
merge_if_needed "$DEPLOY_DIR" custom/ifttt

if ((SKIP_PUSH == 0)); then
  log "Pushing custom and deploy branches to $PUSH_REMOTE"
  git -C "$CANONICAL_REPO" remote get-url "$PUSH_REMOTE" >/dev/null 2>&1 || {
    fail "push remote not configured: $PUSH_REMOTE"
  }
  run git -C "$CANONICAL_REPO" push "$PUSH_REMOTE" custom/ha
  run git -C "$CANONICAL_REPO" push "$PUSH_REMOTE" custom/ifttt
  run git -C "$CANONICAL_REPO" push "$PUSH_REMOTE" deploy/prod
else
  log "Skipping pushes (--skip-push)"
fi

if ((SKIP_DEPLOY == 0)); then
  log "Deploying deploy/prod to Fly app: $FLY_APP"
  (
    cd "$DEPLOY_DIR"
    run fly deploy -a "$FLY_APP" "${DEPLOY_ARGS[@]}"
  )
else
  log "Skipping Fly deploy (--skip-deploy)"
fi

log "Done"
