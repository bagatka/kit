# Changelog

## 0.1.0

First version: `AppStoreConnect` reads an app's builds and App Store versions, and prepares,
submits, and releases a version for iOS, macOS, tvOS, or visionOS, with a token signed once for 15
minutes from an API key. Each failure says who acts: `AppStoreConnectRefused` for a change Apple
won't take now, `AppStoreConnectCredentialsRefused` and `AppStoreConnectForbidden` for a key or a
team someone must fix, and `AppStoreConnectUnavailable` for asking again later. Its errors say
whether to ask again (`isRetryable`), and it is traced by operation (PATTERNS.md, "Calling a
service").
