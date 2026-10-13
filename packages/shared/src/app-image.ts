/** Where AgentsInTheCloud app images are published, unless an image says otherwise. */
export const upstreamAppRepository = "ghcr.io/lucasmeijer/agents-in-the-cloud";

/** App image label: the repository whose channel tags update that app, so a fork's images keep following the fork. */
export const appRepositoryLabel = "org.agents-in-the-cloud.app-repository";

/** Images from before the label existed were all published upstream. */
export function appRepository(labels: Record<string, string> | null | undefined): string {
  const repository = labels?.[appRepositoryLabel];
  if (repository === undefined) return upstreamAppRepository;
  if (!/^[a-z0-9.-]+(:\d+)?(\/[a-z0-9._-]+)+$/.test(repository)) throw new Error(`Invalid app repository label: ${repository}`);
  return repository;
}
