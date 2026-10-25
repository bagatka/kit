# Changelog

## 0.1.0

First version: the options a browser or an app registers or signs in with a passkey, each with a
challenge of its own, as WebAuthn's JSON (`PublicKeyCredentialCreationOptionsJSON`,
`PublicKeyCredentialRequestOptionsJSON`); the checks of both ceremonies' answers
(`RegistrationResponseJSON`, read from its attestation object, and `AuthenticationResponseJSON`),
as browsers, Android and Apple's platforms send them; and `softwareAuthenticator`, a device for
tests.
