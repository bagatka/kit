/**
 * Passkeys for a site: the options a browser or an app registers or signs in with one, and the
 * checks of what it answers, on the platform's Web Crypto. Stateless: the caller keeps challenges
 * and passkeys.
 */
export {
  authenticationOptions,
  AuthenticationResponseJSON,
  challengeOf,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  registrationOptions,
  RegistrationResponseJSON,
  verifyAuthentication,
  verifyRegistration,
  WebAuthnRejected,
} from "./webauthn.ts"
export type { Expected, Passkey, RegistrationExpected, RegistrationInput, WebAuthnCrypto } from "./webauthn.ts"
export { softwareAuthenticator } from "./software-authenticator.ts"
export type { AuthenticatorCrypto, Ceremony, SoftwareAuthenticator } from "./software-authenticator.ts"
