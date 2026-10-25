/**
 * A GitHub App, through GitHub's REST API: where it is installed, the repositories each
 * installation reaches, and the tokens it acts with; its creation from a manifest; and its webhooks'
 * signatures. Its JWTs are signed with RS256 through Web Crypto.
 */
export type { AppManifestForm, AppManifestOptions, CreatedApp } from "./app-manifest.ts"
export { appManifest, convertManifest, installLink } from "./app-manifest.ts"
export { AppSlug } from "./app-slug.ts"
export type { GitHubAppCredentials, GitHubAppCrypto, Installation, IssuedToken } from "./github-app.ts"
export { GitHubApp } from "./github-app.ts"
export {
  GitHubAppCredentialsInvalid,
  GitHubAppCredentialsRefused,
  GitHubForbidden,
  GitHubRefused,
  GitHubUnavailable,
} from "./github-errors.ts"
export { InstallationId } from "./installation-id.ts"
export { Repository } from "./repository.ts"
export type { WebhookCrypto } from "./webhook-signature.ts"
export { verifyWebhook } from "./webhook-signature.ts"
