# Running your own fork

You can run your own build of AgentsInTheCloud and keep getting updates from it.

## 1. Point your fork at your account

In `packages/shared/src/publishing.ts`, change these two lines:

```ts
export const imageNamespace = "ghcr.io/your-account";
export const githubRepository = "your-account/AgentsInTheCloud";
```

## 2. Publish

You'll need:

- `GH_PACKAGE_TOKEN`: a GitHub token that can write packages.
- `ATELIER_RELEASE_HELPER`: an SSH host running Docker on the other CPU architecture (arm64 if you're on amd64, or the other way round), so both builds run natively.

Then, from your fork's `main`:

```sh
images/system/publish.sh   # System first
bun run release            # then the app (add --stable to publish to stable too)
```

## 3. Make your packages public

On GitHub, set `agents-in-the-cloud`, `agents-in-the-cloud-workspace` and `agents-in-the-cloud-system` to public. Installations download them without logging in.

## 4. Install from your images

This has to be a fresh install. An existing installation keeps the app it already has.

```sh
curl -fsSL https://agentsinthecloud.com/install.sh | bash -s -- \
  --app-image ghcr.io/your-account/agents-in-the-cloud:latest \
  --system-image ghcr.io/your-account/agents-in-the-cloud-system:latest
```

## 5. Update

Use **Download update** in the app, or run the installer again and choose update. Both follow your `latest` or `stable` channel.

Private images aren't supported yet.
