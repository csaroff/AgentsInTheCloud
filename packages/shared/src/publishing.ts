/**
 * Where this checkout publishes its images and releases, and where installations update from.
 * Forks change these two lines to their own registry account and GitHub repository.
 */
export const imageNamespace = "ghcr.io/csaroff";
export const githubRepository = "csaroff/AgentsInTheCloud";

export const appRepository = `${imageNamespace}/agents-in-the-cloud`;
export const systemRepository = `${imageNamespace}/agents-in-the-cloud-system`;
export const runtimeRepository = `${imageNamespace}/agents-in-the-cloud-docker`;
