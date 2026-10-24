import type { DateTime } from "effect"
import { Schema } from "effect"

/** A device token, as the app registered it with APNs: hex, as the app sends it on. */
export const DeviceToken = Schema.String.check(Schema.isPattern(/^[0-9A-Fa-f]{1,200}$/)).pipe(
  Schema.brand("DeviceToken"),
)
export type DeviceToken = typeof DeviceToken.Type

/**
 * Which APNs a device token belongs to: development for builds Xcode installs, production for
 * TestFlight and the App Store.
 */
export type ApnsEnvironment = "development" | "production"

/**
 * What a push does on the device, as APNs's `apns-push-type` names it. `mdm`, which takes a
 * certificate's topic rather than an app's, isn't supported.
 */
export type ApnsPushType =
  | "alert"
  | "background"
  | "voip"
  | "liveactivity"
  | "location"
  | "widgets"
  | "controls"
  | "complication"
  | "fileprovider"
  | "pushtotalk"
  | "accessory"

// What APNs requires after the app's bundle ID in `apns-topic` for each push type.
const topicSuffixes: Readonly<Record<ApnsPushType, string>> = {
  alert: "",
  background: "",
  voip: ".voip",
  liveactivity: ".push-type.liveactivity",
  location: ".location-query",
  widgets: ".push-type.widgets",
  controls: ".push-type.controls",
  complication: ".complication",
  fileprovider: ".pushkit.fileprovider",
  pushtotalk: ".voip-ptt",
  accessory: ".push-type.accessory",
}

/** One push to one device. */
export interface ApnsPush {
  /** The device token the app registered. */
  readonly deviceToken: DeviceToken
  readonly environment: ApnsEnvironment
  /**
   * The app's bundle ID, letters, digits, `-` and `.`; the topic for `pushType` is made from it.
   */
  readonly bundleId: string
  readonly pushType: ApnsPushType
  /**
   * 10 to deliver at once; 5 when the device's power allows, which background pushes require; 1
   * never to wake the device.
   */
  readonly priority: 10 | 5 | 1
  /** The JSON payload: `aps` and anything of the app's own; at most 4 KB, or 5 KB for VoIP. */
  readonly payload: Schema.JsonObject
  /**
   * Pushes with one collapse ID show as one notification, the latest: at most 64 characters of
   * printable ASCII.
   */
  readonly collapseId?: string
  /**
   * Until when APNs keeps trying to deliver it; "immediately" to deliver it once, now, and never
   * keep it. When absent, APNs keeps it as its policy says, for up to 30 days.
   */
  readonly expiresAt?: DateTime.Utc | "immediately"
}

/** The `apns-topic` of `push`: its bundle ID, with the suffix its push type needs. */
export const topicOf = (push: ApnsPush): string => `${push.bundleId}${topicSuffixes[push.pushType]}`
