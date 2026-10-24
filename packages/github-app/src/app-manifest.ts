import { Effect, Schema } from "effect"
import type { Redacted } from "effect"
import { HttpClient } from "effect/http"

import { ManifestConversionAnswer } from "./answers.ts"
import type { AppSlug } from "./app-slug.ts"
import { GitHubRefused } from "./github-errors.ts"
import { ask, failure, reasonOf, readSecrets } from "./github-rest.ts"

/** What a GitHub App created from a manifest is to be. */
export interface AppManifestOptions {
  /** Its name on GitHub, which no other app may have. */
  readonly name: string
  /** Its homepage. */
  readonly url: string
  /**
   * Where GitHub sends the person back once the app exists, with `code`, for `convertManifest`,
   * and `state`. Without it, the flow can't finish.
   */
  readonly redirectUrl: string
  /** Where GitHub sends someone back after they authorize the app as themselves. */
  readonly callbackUrl?: string
  /** Where GitHub sends someone after they install the app, with an `installation_id` to check. */
  readonly setupUrl?: string
  /** Where GitHub posts its webhooks; absent, the app has no webhook. */
  readonly webhookUrl?: string
  /** What the app may read or write, by GitHub's permission names: `{ actions: "write", contents: "read" }`. */
  readonly permissions: Readonly<Record<string, "read" | "write">>
  /** The webhook events it subscribes to, such as `workflow_run`, which reach it at `webhookUrl`. */
  readonly events?: ReadonlyArray<string>
  /** Whether any account may install it, or only the one that owns it. */
  readonly public: boolean
  /** An unguessable random string the page keeps, to check when GitHub sends the person back. */
  readonly state: string
  /**
   * The organization that will own the app, by its login, letters, digits and `-`; absent, the
   * account of whoever submits the form.
   */
  readonly organization?: string
}

/**
 * The form a page posts to GitHub to create the app: `<form method="post" action={action}>` with
 * one field, `manifest`, whose value is `manifest`.
 */
export interface AppManifestForm {
  /** GitHub's page for a new app, of a person or of the organization, with `state`. */
  readonly action: string
  /** The manifest, as JSON text. */
  readonly manifest: string
}

/** A GitHub App created from a manifest, with its secrets, which GitHub shows only this once. */
export interface CreatedApp {
  /** Its ID, which `GitHubAppCredentials.appId` takes. */
  readonly id: number
  /** Its name in URLs, which `installLink` takes. */
  readonly slug: AppSlug
  readonly name: string
  /** Its page on GitHub. */
  readonly url: string
  readonly clientId: string
  readonly clientSecret: Redacted.Redacted
  /** Its private key, PKCS #1 PEM, which `GitHubAppCredentials.privateKey` takes. */
  readonly privateKey: Redacted.Redacted
  /** The secret its webhooks are signed with, for `verifyWebhook`; absent when GitHub gave none. */
  readonly webhookSecret?: Redacted.Redacted
}

const site = "https://github.com"

const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(Schema.JsonObject))

/**
 * The form that creates a GitHub App from a manifest (GitHub's manifest flow): the page posts it,
 * the person names and confirms the app on GitHub, and GitHub sends them to `redirectUrl` with a
 * `code` for `convertManifest` and the `state`, which the page checks against its own.
 */
export const appManifest = Effect.fn("appManifest")(function* (options: AppManifestOptions) {
  if (options.organization !== undefined && !/^[A-Za-z0-9-]{1,39}$/.test(options.organization)) {
    return yield* Effect.die("An organization's login is 1 to 39 letters, digits and '-'")
  }
  const manifest = {
    name: options.name,
    url: options.url,
    // `hook_attributes` needs a `url`, so without one it is left out, for an app without a webhook.
    // GitHub's manifest documentation doesn't say what it makes of that; its registration with URL
    // parameters says a new app's webhook is inactive unless set active.
    ...(options.webhookUrl === undefined ? {} : { hook_attributes: { url: options.webhookUrl } }),
    redirect_url: options.redirectUrl,
    ...(options.callbackUrl === undefined ? {} : { callback_urls: [options.callbackUrl] }),
    ...(options.setupUrl === undefined ? {} : { setup_url: options.setupUrl }),
    public: options.public,
    default_permissions: options.permissions,
    ...(options.events === undefined ? {} : { default_events: options.events }),
  }
  const text = yield* encodeManifest(manifest).pipe(Effect.orDie)
  const owner =
    options.organization === undefined
      ? "/settings"
      : `/organizations/${encodeURIComponent(options.organization)}/settings`
  const form: AppManifestForm = {
    action: `${site}${owner}/apps/new?state=${encodeURIComponent(options.state)}`,
    manifest: text,
  }
  return form
})

/**
 * The app GitHub created from a manifest, for the `code` it sent the person back with: its ID,
 * names, and secrets. One request, unauthenticated. GitHub takes a code once, within an hour of
 * issuing it; refused with 404 for one it doesn't, or that isn't a code at all, and 422 for one it
 * can't convert.
 */
export const convertManifest = Effect.fn("convertManifest")(function* (code: string) {
  const client = yield* HttpClient.HttpClient
  // A code is letters and digits GitHub made; anything else isn't one, and stays out of the path.
  const codeLike = /^[A-Za-z0-9_-]{1,200}$/.test(code)
  if (!codeLike) {
    return yield* new GitHubRefused({ status: 404, reason: "That isn't a code GitHub sends back from a manifest" })
  }
  // The code holds the app's secrets until it is converted: it stays out of messages and traces.
  const answer = yield* ask(client, {
    method: "POST",
    path: `/app-manifests/${code}/conversions`,
    shownAs: "/app-manifests/{code}/conversions",
  }).pipe(Effect.provideService(HttpClient.TracerDisabledWhen, () => true))
  if (answer.status === 404 || answer.status === 422) {
    const reason = yield* reasonOf(answer)
    return yield* new GitHubRefused({ status: answer.status, reason })
  }
  if (answer.status !== 201) {
    return yield* failure(answer)
  }
  const created = yield* readSecrets(ManifestConversionAnswer, answer)
  return createdAppOf(created)
})

/** The page where someone installs the app with this slug on an account they choose. */
export const installLink = (slug: AppSlug): string => `${site}/apps/${slug}/installations/new`

const createdAppOf = (answer: ManifestConversionAnswer): CreatedApp => ({
  id: answer.id,
  slug: answer.slug,
  name: answer.name,
  url: answer.html_url,
  clientId: answer.client_id,
  clientSecret: answer.client_secret,
  privateKey: answer.pem,
  ...(answer.webhook_secret === null ? {} : { webhookSecret: answer.webhook_secret }),
})
