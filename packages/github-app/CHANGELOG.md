# Changelog

## 0.1.0

First version: `GitHubApp` finds a GitHub App's installations and issues their tokens, with a JWT
signed once for 8 minutes from the app's key; `appManifest`, `convertManifest` and `installLink`
create and install an app; and `verifyWebhook` checks a delivery's signature. Each failure says who
acts, and whether to ask again (`isRetryable`, and `retryAfter` as a `Duration`); it is traced by
operation (PATTERNS.md, "Calling a service").
