import { agentsInTheCloudDataPath, getAgentsInTheCloudRuntimeContext } from "@agents-in-the-cloud/core";
import { readJsonSettings, updateJsonSettings } from "@agents-in-the-cloud/core/json-settings";
import { Value } from "typebox/value";
import { updateChannelSchema, type UpdateChannel } from "./update-channel.ts";

function settingsPath(): string {
  return agentsInTheCloudDataPath(getAgentsInTheCloudRuntimeContext(), "update.json");
}

export async function readStoredUpdateChannel(): Promise<UpdateChannel | undefined> {
  // Retain the serialized field in existing update.json files.
  const { releaseChannel: updateChannel } = await readJsonSettings(settingsPath());
  if (updateChannel === undefined) return undefined;
  if (!Value.Check(updateChannelSchema, updateChannel)) throw new Error("Invalid update settings");
  return updateChannel;
}

export async function writeStoredAppRepository(repository: string): Promise<void> {
  await updateJsonSettings(settingsPath(), (settings) => { settings.appRepository = repository; });
}

export async function writeStoredUpdateChannel(channel: UpdateChannel): Promise<void> {
  await updateJsonSettings(settingsPath(), (settings) => { settings.releaseChannel = channel; });
}
