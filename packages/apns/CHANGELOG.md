# Changelog

## 0.1.0

First version: `Apns` sends a push of any type APNs takes, with a provider token signed once for 50
minutes from a token-signing key, and answers accepted, inactive, or rejected with Apple's reason;
credentials APNs refuses fail with `ApnsCredentialsRefused`, never as an answer about the push. Its
errors say whether to send again (`isRetryable`), and it is traced by push, never with the device
token (PATTERNS.md, "Calling a service").
