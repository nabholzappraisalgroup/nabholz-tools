## Multi-agent sync rules
This repo is also edited and deployed by Hermes (an agent on a separate VPS).
Two tools edit this codebase, so sync discipline is mandatory.
### Before editing
- ALWAYS git pull first so the working copy matches the latest on GitHub. The other
  editor may have pushed changes since the last session. Never edit from a stale state.
- If the pull reveals unexpected changes, surface them to me before proceeding.
### Before pushing
- Confirm the working copy is current (pull again if the session has been open a while).
- Never force-push. Never overwrite changes I didn't make. If a push would conflict, stop
  and tell me rather than resolving silently.
### After deploying
- Railway auto-deploys on push. Confirm the deploy and, for prompt/config changes, verify
  the live version via the /export endpoint.
### Validation discipline
- Fix locally, validate across 3+ runs on known-answer files, review diffs, commit to
  branch, deploy deliberately.
