# Changelog

## 0.1.1

`isSecretName` and named values in text know keys in the plural: `api_keys`, `private_keys` and the
other keys. `isSecretName` also knows tokens in the plural, as kinds of token (`access_tokens`,
`refresh_tokens`, `id_tokens`, `auth_tokens`) and as the whole name (`tokens`); named values in text
don't. Counts of tokens (`max_tokens`, `input_tokens`) still aren't secret names.

## 0.1.0

First version: `scrubText` removes what its README's closed list recognizes from text, in time linear
in the text's length, and `isSecretName` tells whether a name holds a secret.
