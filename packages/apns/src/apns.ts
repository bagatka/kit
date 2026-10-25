import type { JwtCrypto } from "@bagatka/jwt"
import { importSigningKey, signJwt } from "@bagatka/jwt"
import type { Redacted } from "effect"
import { Clock, Context, DateTime, Duration, Effect, Layer, Option, Schema, SynchronizedRef } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"

import type { ApnsEnvironment, ApnsPush } from "./push.ts"
import { topicOf } from "./push.ts"

/**
 * The part of the platform's Web Crypto, `crypto.subtle`, that provider tokens are signed with: the
 * one `@bagatka/jwt` takes.
 */
export type ApnsCrypto = JwtCrypto

/**
 * A token-signing key from Apple's developer site: its `.p8` file's text, or the base64 inside it
 * alone; its 10-character key ID; and the 10-character ID of the team it belongs to.
 */
export interface ApnsCredentials {
  readonly key: Redacted.Redacted
  readonly keyId: string
  readonly teamId: string
}

/**
 * The credentials can't sign provider tokens APNs takes: the key isn't a P-256 key in PKCS #8, or
 * an ID isn't 10 capital letters and digits. `reason` says which, never with the key in it.
 * Building the layer again won't help: fix the settings.
 */
export class ApnsCredentialsInvalid extends Schema.TaggedError<ApnsCredentialsInvalid>()("ApnsCredentialsInvalid", {
  reason: Schema.String,
}) {
  override get message(): string {
    return `The APNs credentials were refused: ${this.reason}`
  }

  /** Asking again won't help. */
  get isRetryable(): boolean {
    return false
  }
}

/**
 * APNs refused the provider token the credentials signed, answering 403 `InvalidProviderToken`:
 * the key was revoked, or isn't the key ID's, or the team ID isn't its team's. Every push fails so
 * until the settings change, so it is never an answer about the push: sending again won't help, and
 * the device token is fine. `reason` is Apple's.
 */
export class ApnsCredentialsRefused extends Schema.TaggedError<ApnsCredentialsRefused>()("ApnsCredentialsRefused", {
  reason: Schema.String,
}) {
  override get message(): string {
    return `APNs refused the credentials' provider token: ${this.reason}`
  }

  /** Asking again won't help. */
  get isRetryable(): boolean {
    return false
  }
}

/** APNs took the push. `apnsId` is the ID APNs gave it, which its delivery logs name. */
export const ApnsAccepted = Schema.TaggedStruct("Accepted", { apnsId: Schema.UndefinedOr(Schema.String) })

/**
 * The device token is no longer active for the app, as APNs's 410 says: `Unregistered`, or
 * `ExpiredToken`. Stop sending to it, unless the app registered it again after `since`, when APNs
 * found it inactive.
 */
export const ApnsInactive = Schema.TaggedStruct("Inactive", {
  reason: Schema.String,
  since: Schema.UndefinedOr(Schema.DateTimeUtc),
})

/**
 * APNs refused the push for `reason`, such as `BadDeviceToken`, `DeviceTokenNotForTopic`, or
 * `PayloadTooLarge` (Apple's "Handling notification responses from APNs" lists them): sending it
 * again as it is won't change that. Neither proves the device token is gone: the first also answers
 * a token sent to the wrong environment, the second a push sent with the wrong bundle ID.
 */
export const ApnsRejected = Schema.TaggedStruct("Rejected", { status: Schema.Int, reason: Schema.String })

/** What APNs answered a push. */
export const ApnsAnswer = Schema.Union([ApnsAccepted, ApnsInactive, ApnsRejected])
export type ApnsAnswer = typeof ApnsAnswer.Type

/**
 * APNs didn't take the push now: it couldn't be reached, didn't answer in 10 seconds, answered too
 * many requests or a server error, or answered what isn't APNs's. Sending it again later may work;
 * Apple asks for 15 minutes after a server error.
 */
export class ApnsUnavailable extends Schema.TaggedError<ApnsUnavailable>()("ApnsUnavailable", {
  reason: Schema.String,
}) {
  override get message(): string {
    return `APNs didn't take the push: ${this.reason}`
  }

  /** Asking again later may work. */
  get isRetryable(): boolean {
    return true
  }
}

const hosts: Readonly<Record<ApnsEnvironment, string>> = {
  development: "api.sandbox.push.apple.com",
  production: "api.push.apple.com",
}

// APNs takes a provider token for an hour, and refuses one renewed more often than every 20 minutes.
const tokenLasts = Duration.toMillis(Duration.minutes(50))

const appleId = /^[A-Z0-9]{10}$/

// An answer's body: one of Apple's reasons, a word in camel case, and for 410 a time in epoch
// milliseconds. Anything else isn't APNs's.
const ErrorBody = Schema.fromJsonString(
  Schema.Struct({
    reason: Schema.String.check(Schema.isPattern(/^[A-Za-z]{1,64}$/)),
    timestamp: Schema.optional(Schema.DateTimeUtcFromMillis),
  }),
)

// What a header takes from a push, as APNs takes it.
const bundleIdShape = /^[A-Za-z0-9.-]{1,155}$/
const collapseIdShape = /^[\x20-\x7e]{1,64}$/

interface Signed {
  readonly token: string
  readonly signedAt: number
}

/** Sends pushes to Apple devices through Apple's Push Notification service, with a token-signing key. */
export class Apns extends Context.Service<
  Apns,
  {
    /**
     * Sends one push and returns APNs's answer: accepted, inactive, or rejected with Apple's
     * reason. Fails with `ApnsUnavailable` when APNs may take it later, and with
     * `ApnsCredentialsRefused` when APNs refuses the credentials themselves, which every push will
     * until the settings change. Pushes share a provider token, signed once for 50 minutes, even
     * when sent together; one APNs calls expired is signed again, and the push sent once more.
     */
    readonly send: (push: ApnsPush) => Effect.Effect<ApnsAnswer, ApnsUnavailable | ApnsCredentialsRefused>
  }
>()("@bagatka/apns/apns") {
  /**
   * APNs with `credentials`, signing with `crypto` (`crypto.subtle`), on the `HttpClient` the host
   * provides, which must speak HTTP/2, as `fetch` does on deployed Workers, Node 26 and Deno 2, and
   * not on Bun 1.4, where every push is `ApnsUnavailable`. Fails with
   * `ApnsCredentialsInvalid` when the credentials can't sign tokens APNs takes.
   */
  static readonly layer = (
    credentials: ApnsCredentials,
    crypto: ApnsCrypto,
  ): Layer.Layer<Apns, ApnsCredentialsInvalid, HttpClient.HttpClient> =>
    Layer.effect(
      Apns,
      Effect.gen(function* () {
        const { keyId, teamId } = credentials
        if (!appleId.test(keyId) || !appleId.test(teamId)) {
          return yield* new ApnsCredentialsInvalid({
            reason: "The key ID and the team ID are each 10 capital letters and digits",
          })
        }
        const key = yield* importSigningKey(crypto, "ES256", credentials.key).pipe(
          Effect.mapError((invalid) => new ApnsCredentialsInvalid({ reason: invalid.reason })),
        )
        const client = yield* HttpClient.HttpClient
        const signed = yield* SynchronizedRef.make(Option.none<Signed>())

        // The provider token to send with: the one kept, unless it is 50 minutes old or is `stale`,
        // which APNs called expired. One signing at a time, so pushes sent together share a token.
        const providerToken = (stale: string | undefined) =>
          SynchronizedRef.modifyEffect(signed, (kept) =>
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis
              if (Option.isSome(kept) && kept.value.token !== stale && now - kept.value.signedAt < tokenLasts) {
                return [kept.value.token, kept] as const
              }
              const token = yield* signJwt(key, { kid: keyId }, { iss: teamId, iat: Math.floor(now / 1000) })
              return [token, Option.some({ token, signedAt: now })] as const
            }),
          )

        const attempt = Effect.fnUntraced(function* (push: ApnsPush, token: string) {
          // A push no APNs takes is the caller's bug, never one to send again later.
          if (!bundleIdShape.test(push.bundleId)) {
            return yield* Effect.die("A push's bundle ID is letters, digits, '-' and '.'")
          }
          if (push.collapseId !== undefined && !collapseIdShape.test(push.collapseId)) {
            return yield* Effect.die("A push's collapse ID is 1 to 64 characters of printable ASCII")
          }
          const expiration =
            push.expiresAt === undefined
              ? {}
              : {
                  "apns-expiration":
                    push.expiresAt === "immediately" ? "0" : String(DateTime.toEpochSeconds(push.expiresAt)),
                }
          const request = yield* HttpClientRequest.post(
            `https://${hosts[push.environment]}/3/device/${push.deviceToken}`,
          ).pipe(
            HttpClientRequest.setHeaders({
              authorization: `bearer ${token}`,
              "apns-topic": topicOf(push),
              "apns-push-type": push.pushType,
              "apns-priority": String(push.priority),
              ...expiration,
              ...(push.collapseId === undefined ? {} : { "apns-collapse-id": push.collapseId }),
            }),
            HttpClientRequest.bodyJson(push.payload),
            Effect.orDie,
          )
          // The whole answer, its body read too, within 10 seconds. The request's span is this
          // package's: the URL holds the device token, which Effect's span would export as
          // `url.full`, so it has OpenTelemetry's HTTP attributes with the path's template instead.
          const host = hosts[push.environment]
          const response = yield* client.execute(request).pipe(
            Effect.flatMap((answered) =>
              Effect.map(answered.text, (text) => ({ status: answered.status, headers: answered.headers, text })),
            ),
            Effect.tap((answered) =>
              Effect.annotateCurrentSpan({
                "http.response.status_code": answered.status,
                ...(answered.status >= 400 ? { "error.type": String(answered.status) } : {}),
              }),
            ),
            Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
            Effect.withSpan("POST", {
              kind: "client",
              attributes: {
                "http.request.method": "POST",
                "server.address": host,
                "server.port": 443,
                "url.scheme": "https",
                "url.template": "/3/device/{deviceToken}",
              },
            }),
            Effect.timeout(Duration.seconds(10)),
            Effect.mapError(
              (error) =>
                new ApnsUnavailable({
                  reason:
                    error._tag === "TimeoutError" ? "APNs didn't answer in 10 seconds" : "APNs couldn't be reached",
                }),
            ),
          )
          if (response.status === 200) {
            return ApnsAccepted.make({ apnsId: response.headers["apns-id"] })
          }
          const body = yield* Schema.decodeEffect(ErrorBody)(response.text).pipe(Effect.option)
          if (Option.isNone(body)) {
            return yield* new ApnsUnavailable({ reason: `APNs answered ${response.status} without a reason` })
          }
          const { reason, timestamp } = body.value
          if (response.status === 410) {
            return ApnsInactive.make({ reason, since: timestamp })
          }
          if (response.status === 429 || response.status >= 500) {
            return yield* new ApnsUnavailable({ reason: `APNs answered ${response.status}, ${reason}` })
          }
          if (response.status === 403 && reason === "InvalidProviderToken") {
            return yield* new ApnsCredentialsRefused({ reason })
          }
          return ApnsRejected.make({ status: response.status, reason })
        })

        const send = Effect.fn("Apns.send")(function* (push: ApnsPush) {
          yield* Effect.annotateCurrentSpan({ "apns.push_type": push.pushType, "apns.environment": push.environment })
          const token = yield* providerToken(undefined)
          const first = yield* attempt(push, token)
          const answer =
            first._tag === "Rejected" && first.reason === "ExpiredProviderToken"
              ? yield* attempt(push, yield* providerToken(token))
              : first
          // What APNs answered, which a successful span alone doesn't say.
          yield* Effect.annotateCurrentSpan({
            "apns.answer": answer._tag,
            ...(answer._tag === "Accepted" ? {} : { "apns.reason": answer.reason }),
          })
          return answer
        })

        return Apns.of({ send })
      }),
    )
}
