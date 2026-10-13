# AgentsInTheCloud releases

The app’s **Update channel** follows either the published `latest` image or the image promoted to `stable`. Those image tags remain the publication boundary.

```sh
bun run release             # latest
bun run release --stable    # latest and stable
bun run release --check     # validate the builder without publishing
```

The image repositories and the GitHub repository that releases publish to come from
`packages/shared/src/publishing.ts`. Installations also update from there, so a fork
changes those two lines to release and update from its own account. See
[Running your own fork](forks.md).

This branch publishes `ghcr.io/lucasmeijer/agents-in-the-cloud:latest` and
immutable commit/staging tags. `--stable` also advances its `stable` tag after
VM acceptance. Atelier hotfix releases remain on `main` and use their original
image repositories and release command. These two lanes have separate log
directories, locks and builder context names. `--check` may be combined with
`--stable` and never publishes.

The renamed runtime is published separately with `images/patched-docker/publish.sh`.
App, System and workspace images pin its multi-platform digest; commit updated
pins before releasing.

## App and System versions

The app and System are released and updated separately. System reports its compatibility version (`systemVersion` in `packages/shared/src/system-version.ts`) in its `/status` response and as the `org.agents-in-the-cloud.system-version` image label. App images carry `org.agents-in-the-cloud.required-system-version`. The in-app updater won't install an app that needs a newer System and tells people to run the installer instead; System refuses to start such an app too. The installer updates System from the installation's Update channel (`agents-in-the-cloud-system:latest` or `:stable`), then moves the app to that channel's newest image.

Publish System to a channel before any app that needs it: `images/system/publish.sh` moves `latest`, and `--stable` moves `stable` as well. `bun run release` refuses to move an app channel whose System is too old or not published yet.

For the VM test, publish this branch's app and separately publish its System image
as `ghcr.io/lucasmeijer/agents-in-the-cloud-system:latest` (`images/system/publish.sh` moves latest); this release command
publishes only the app and its workspace dependency. Use the branch's installer
(which defaults to latest images) and record both tested image digests. The new
installation starts empty: do not mount Atelier storage or import its settings.
Test installation, workspace creation/parking, updates, restart and uninstall
before promoting to stable. Publishing to the renamed repositories does not
replace the public Atelier installer or advance Atelier's update tags.
The installer supports removing a legacy Atelier installation with `--uninstall`.

Existing `ATELIER_*` environment/build-argument names remain unchanged; defaults,
storage names, labels and runtime protocols do not adopt Atelier state.

Publishing requires the existing `GH_PACKAGE_TOKEN` with GHCR package write access.
Docker, Buildx, Bun and Git are required and supplied by the Atelier workspace.
The release CLI runs on Linux and macOS; it calls the native OS locking API through
Bun rather than requiring a `flock` executable. No GitHub Actions or host Docker
socket is needed.

## What runs

Set `ATELIER_RELEASE_HELPER=builder@hostname` (or an SSH config alias). The helper
must allow noninteractive SSH with an already trusted host key, and its SSH user
must have Docker access. It must run Linux on the opposite architecture from the
local Docker daemon: arm64 for an amd64 workstation, or amd64 for an ARM laptop.
Both daemons need registry access. Missing, unreachable, or wrong-architecture
helpers fail before publishing; there is no emulation fallback.

The command fetches `origin/rename-agents-in-the-cloud` and records its exact SHA. It uses the integrated
Docker BuildKit builders (`docker` driver) for the current Docker context and a
persistent SSH context derived from the helper destination. No separate BuildKit
container is created. Inside Atelier this preserves the patched daemon's EROFS
snapshotter and shared-cache configuration.

Every invocation checks both daemon architectures and builder drivers, then exercises
COPY, RUN (including `uname -m` verification), and local image export on each node.
The probe image is `agents-in-the-cloud-release-probe:check` on each daemon. `--check` stops
here: it fetches Git and may pull the Ubuntu probe base, but never logs into or
writes to the registry. It does not prove write credentials or that a full
application build succeeds.

A real release builds an isolated detached worktree of that SHA, not your working
files, and removes the worktree afterward. Your branch and local edits are left
alone. It uses the existing image-building script to reuse/build the deterministic
workspace image and upload the app as `ghcr.io/lucasmeijer/agents-in-the-cloud:sha-<full-sha>`.
Each image is built and pushed in two native slices, with `-amd64` and `-arm64`
staging tags, then combined by digest into a multi-platform manifest. The workspace
manifest is assembled first so both app slices pin the same workspace digest.
Channel tags are not passed to the build. An existing commit image is reused, not
overwritten, and its two architectures and revision labels must pass verification.
Rerunning after a completed upload therefore skips the application rebuild.

Before promotion, the command verifies the rename branch has not moved. If it has, the command
fails without updating channels; rerun to release the new branch head. Otherwise it
promotes the verified digest to latest (and stable with `--stable`) and checks its registry digest.
Channel updates are **not atomic**. Status records each channel separately. A
failed promotion may have reached the registry even if its response was lost;
there is no automatic rollback. Inspect the tag/digest or rerun the same release.

An OS lock prevents overlapping releases from the same Git common directory,
including linked worktrees. **It is not a distributed lock:** do not run releases
from two independent workspaces simultaneously. The branch-head check reduces stale
promotions but cannot eliminate a race with another workspace's publisher.

Build caches remain with each Docker daemon. SSH contexts and probe images are
retained for reuse. The script does not provision Docker or modify the helper's
storage configuration.

## Live progress for people and agents

The script is an ordinary foreground CLI: stdout is live and simultaneously saved.
It needs neither tmux nor Atelier to function. For long runs in Atelier, start it
in a persistent tmux session, **present that session with Atelier's `present`
tool**, and read the status file periodically. Screenshots are unnecessary.

```sh
tmux new-session -d -s agents-in-the-cloud-release 'cd /work; bun run release; result=$?; printf "\nRelease exited %s\n" "$result"; exec bash'
```

The agent then calls `present` with `kind: "tmux", session: "agents-in-the-cloud-release"`.
For evaluation without publishing, use `bun run release --check` instead.
The interactive shell keeps the final transcript visible; the log/status files
remain the authoritative result if the session closes. Ctrl-C interrupts a running
release and forwards termination to its command group; rerun to recover.

At startup the CLI prints absolute log and status paths. Each run has a directory
under Git's common directory, `agents-in-the-cloud-releases/<timestamp>-<pid>/`, containing:

- `release.log`: complete live command output (including ANSI phase headings).
- `status.json`: atomically updated phase, elapsed seconds, commit, builder,
  requested channels, individual promotion outcomes, digest and error. A heartbeat
  updates it every five seconds while a command is busy.
- `probe/`: build context for the non-publishing builder smoke checks.

Find the latest invocation without knowing its timestamp:

```sh
common=$(git rev-parse --path-format=absolute --git-common-dir)
run=$(cat "$common/agents-in-the-cloud-releases/last-run.txt")
cat "$run/status.json"
tail -n 20 "$run/release.log"
```

A successful check ends in `state: checked`, a successful release in `published`,
and handled failures in `failed`. Channels stay `pending` in check mode. If the
process is forcibly killed, a stale heartbeat with `state: running` is not evidence
that it is still alive. Logs are local to the workspace; preserve them externally
if needed. Credentials go only to Docker login's stdin, never command arguments.
