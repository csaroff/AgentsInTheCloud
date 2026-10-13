/**
 * Compatibility between the app and System, which are released and updated
 * independently. The in-app updater never installs an app that needs a newer
 * System; the installer updates System and then the app on its channel.
 */

/**
 * What this System offers the app. Bump it with every System addition the app
 * may rely on, and publish System to a channel before any app that needs it.
 *
 * - 0: any System from before versions were reported
 * - 1: the private-network-access host operation
 * - 2: channel updates pull the app repository recorded in update.json
 */
export const systemVersion = 2;

/** The lowest System version this app relies on. Raise it when the app starts using a newer System addition. */
export const requiredSystemVersion = 1;

/** App image label: the System version that app needs. */
export const requiredSystemVersionLabel = "org.agents-in-the-cloud.required-system-version";
/** System image label: that image's systemVersion. */
export const systemVersionLabel = "org.agents-in-the-cloud.system-version";

/** Reads a version label. Images from before versions existed have none and are version 0. */
export function parseSystemVersion(label: string | undefined): number {
  if (label === undefined) return 0;
  if (!/^\d+$/.test(label)) throw new Error(`Invalid System version: ${label}`);
  return Number(label);
}
