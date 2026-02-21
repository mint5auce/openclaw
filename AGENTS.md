# AGENTS Instructions: openclaw-fly-ha-only

## Scope
Canonical OpenClaw repo and linked worktree source.

## Active worktree model
- /Users/jonh/Development/openclaw/openclaw-main -> main
- /Users/jonh/Development/openclaw/openclaw-ha -> custom/ha
- /Users/jonh/Development/openclaw/openclaw-ifttt -> custom/ifttt
- /Users/jonh/Development/openclaw/openclaw-deploy-prod -> deploy/prod

## Safety rules
- Deploy operations must run from openclaw-deploy-prod only.
- For production deploys, use app `bogle-oc-bot` from the deploy/prod worktree runbook.
- Before deploy-related changes: verify clean status and branch.
- Do not remove or relocate worktrees without explicit user confirmation.
- Prefer fast-forward/rebase/cherry-pick workflows over ad-hoc branch rewrites.
