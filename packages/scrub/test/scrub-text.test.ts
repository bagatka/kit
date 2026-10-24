import { assert, describe, it } from "@effect/vitest"

import { isSecretName, scrubText } from "../src/index.ts"
import { fake } from "./fake.ts"

// The runtime's clock for measuring, which tests outside a runtime with its types can't name.
declare const performance: { readonly now: () => number }

// Every value is made up. Values shaped like a provider's keys carry a `·` in their prefix that
// `fake` removes, so secret scanners don't take them for real keys.
const key = "FAKE0fake1FAKE2fake3FAKE4fake5FAKE6"

// Each form on the list (README, "Recognizes"), a few cases each, and what is left of them.
const recognized: ReadonlyArray<readonly [string, string]> = [
  // Authorization header values: what follows the scheme, or the whole value.
  ["Authorization: Bearer abcDEF1234567890", "Authorization: Bearer [token]"],
  ["Proxy-Authorization: Basic YTpi", "Proxy-Authorization: Basic [token]"],
  ['{"authorization":"Zq8xV2mK7pR4tY9w","method":"GET"}', '{"authorization":"[token]","method":"GET"}'],
  ["authorization=Zq8xV2mK7pR4tY9w method=GET", "authorization=[token] method=GET"],
  ["Authorization: AWS4-HMAC-SHA256 Credential=AK·IAFAKEFAKEFAKE1234/x", "Authorization: AWS4-HMAC-SHA256 [token]"],
  // Bearer, Basic and Token elsewhere.
  ["retry with Bearer abcDEF1234567890 now", "retry with Bearer [token] now"],
  ["sent Basic YTpi, Token 5|abcDEF", "sent Basic [token], Token [token]"],
  ["q=bearer+token+abcdef12&x=1 q=Token+expired+after+3600", "q=bearer+token+[token]&x=1 q=Token+expired+after+3600"],
  ["sent Bearer abcd.efg", "sent Bearer [token]"],
  // JWTs, signed and unsigned.
  ["t=e·yJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZGEifQ.ZmFrZSBzaWduYXR1cmU end", "t=[token] end"],
  ["unsigned eyJhbGciOiJub25lIn0.e30.", "unsigned [token]"],
  // Keys by their published prefixes.
  [`sk_li·ve_${key} rk_te·st_${key} whs·ec_${key}`, "[token] [token] [token]"],
  [`sk-pr·oj-${key} gh·p_${key} github_p·at_${key}`, "[token] [token] [token]"],
  [
    `AK·IAFAKEFAKEFAKE1234 AS·IAFAKEFAKEFAKE1234 xox·b-${key} xa·pp-1-${key} AIz·a${key}`,
    "[token] ".repeat(4) + "[token]",
  ],
  // Secret parameters by name, also in a URL encoded into another.
  [
    "GET /cb?code=4/0AY0e&state=x#access_token=abc;session=s",
    "GET /cb?code=[secret]&state=x#access_token=[secret];session=[secret]",
  ],
  ["next=%2Fcb%3Ftoken%3Dabc&X-Amz-Signature=fa1e", "next=%2Fcb%3Ftoken%3D[secret]&X-Amz-Signature=[secret]"],
  [
    "?accessToken=a&refresh_token=b&clientSecret=c&apikey=d",
    "?accessToken=[secret]&refresh_token=[secret]&clientSecret=[secret]&apikey=[secret]",
  ],
  // URL passwords.
  ["postgres://app:Xy7/Kq+9zW2@db:5432/notes", "postgres://app:[secret]@db:5432/notes"],
  ["(redis://:1pw@cache)", "(redis://:[secret]@cache)"],
  // Values of named secrets.
  ["user=bob password=hunter2 DB_SECRET: abc,", "user=bob password=[secret] DB_SECRET: [secret],"],
  [String.raw`{"api_key": "ab\"c", "clientSecret":'x'}`, `{"api_key": "[secret]", "clientSecret":'[secret]'}`],
  [String.raw`{\"password\":\"hunter2\"}`, String.raw`{\"password\":\"[secret]\"}`],
  ["token: abc123def456", "token: [secret]"],
  // Cookie headers, to the end of the line.
  ['Cookie: theme="dark"; session=abc\nnext', "Cookie: [secret]\nnext"],
  ["Set-Cookie: sid=abc; Path=/", "Set-Cookie: [secret]"],
  ["> Cookie:a=1; sid=abc", "> Cookie:[secret]"],
  // Private keys, whole or cut short.
  ["key -----BEGIN RSA PRIV·ATE KEY-----\nMIIE+/=\n-----END RSA PRIV·ATE KEY----- ok", "key [token] ok"],
  ["cut -----BEGIN PRIV·ATE KEY-----\nMIIE", "cut [token]"],
  // Emails, also with `%40`, and glued to another.
  ["to anna.k+notes@example.co.uk, ?to=bob%40example.com", "to [email], ?to=[email]"],
  ["ada@example.com_bob@example.com", "[email]_[email]"],
  // Card numbers.
  ["4242 4242 4242 4242 and 4242-4242-4242-4242", "[card] and [card]"],
  ["5555 5555 5555 4444 pan%3A4242424242424242", "[card] pan%3A[card]"],
  ["pan_4242424242424242 exp 12/27", "pan_[card] exp 12/27"],
  // After a JSON or a percent escape.
  [
    String.raw`{"msg":"retry:\nBearer abcDEF1234567890 key:\tgh·p_${key} to:\nada@example.com", "pan":"\n4242424242424242"}`,
    String.raw`{"msg":"retry:\nBearer [token] key:\t[token] to:\n[email]", "pan":"\n[card]"}`,
  ],
  [
    "Authorization=Bearer%20abcDEF1234567890&next=%2Fcb%3Fcode%3Dx",
    "Authorization=Bearer%20[token]&next=%2Fcb%3Fcode%3D[secret]",
  ],
]

// Prose and look-alikes, left as they are.
const kept = [
  "Invalid token signature",
  "basic authentication required, Refresh token rotation failed",
  "Token expired after 3600 seconds. Token expired: sign in again",
  'WWW-Authenticate: Bearer realm="api"',
  "refreshing token user_id=42; Bearer abc",
  "see eyeglasses.store.com, Bearer abc.def, Token ABCD",
  "token: expired, token=undefined, code: 404, key: user_id, cookie_consent: true",
  '{"password":null,"secret":{"name":"x"}}',
  "GET http://localhost:3000/users/@me 200 logo@2x.png",
  "Order 4111111111111112, ParentId 0000000000000000, Build 1234567812345670",
  "backup-2024-10-23-123006 loss=0.4242424242424242 6666666666666",
  "installed react@18.3.1 trace 550e8400-e29b-41d4-a716-446655440000 from 203.0.113.42",
]

// A megabyte of `unit` repeated.
const fill = (unit: string) => unit.repeat(Math.ceil(1_000_000 / unit.length)).slice(0, 1_000_000)

describe("scrubText", () => {
  it("removes each form on the list", () => {
    for (const [text, scrubbed] of recognized) {
      assert.strictEqual(scrubText(fake(text)), fake(scrubbed), text)
    }
  })

  it("leaves prose and look-alikes as they are", () => {
    for (const text of kept) {
      assert.strictEqual(scrubText(text), text)
    }
  })

  it("removes keys with the caller's own prefixes, matched as written", () => {
    const prefixes = ["notes.", "acme_live_", "", "x".repeat(101)]
    assert.strictEqual(scrubText("k acme_live_Zk3Pq9TzX2mV8wYb4LdR", prefixes), "k [token]")
    // The same set again, from its compiled pattern; every key in the text.
    for (const round of [1, 2]) {
      const text = "k acme_live_Zk3Pq9TzX2mV8wYb4LdR, acme_live_Zk3Pq9TzX2mV8wYb4LdR"
      assert.strictEqual(scrubText(text, ["acme_live_"]), "k [token], [token]", String(round))
    }
    for (const text of ["notesXios.app.abcdefghijklmnopqrstuvwxyz", "acme_live_short", "x".repeat(130)]) {
      assert.strictEqual(scrubText(text, prefixes), text)
    }
    // Another set compiles its own pattern; a prefix of 100 characters is taken, a 101st prefix
    // isn't.
    assert.strictEqual(scrubText("k other_Zk3Pq9TzX2mV8wYb4LdR", ["other_"]), "k [token]")
    assert.strictEqual(scrubText("y".repeat(116), ["y".repeat(100)]), "[token]")
    const many = Array.from({ length: 101 }, (_, index) => `p${index}_`)
    assert.strictEqual(scrubText("k p100_Zk3Pq9TzX2mV8wYb4LdR", many), "k p100_Zk3Pq9TzX2mV8wYb4LdR")
    // A JavaScript caller's prefixes that aren't strings are ignored.
    const javaScript: { scrubText(text: string, ownKeyPrefixes: unknown): string } = { scrubText }
    assert.strictEqual(
      javaScript.scrubText("k acme_live_Zk3Pq9TzX2mV8wYb4LdR", [undefined, 42, "acme_live_"]),
      "k [token]",
    )
  })

  it("never throws, and a second scrub changes nothing, whatever the string", () => {
    const fragments = [
      ...recognized.flatMap(([text, scrubbed]) => [fake(text), fake(scrubbed)]),
      ...kept,
      ...'password token Bearer authorization cookie = : " + @ - . _ \\ \\n %3D [secret] [token] 4242'.split(" "),
      " ",
      "\r\n",
      String.fromCharCode(0xd800),
    ]
    // A Lehmer generator (MINSTD), exact in a double: the same texts on every machine.
    let state = 12_345
    const next = (bound: number) => {
      state = (state * 48_271) % 2_147_483_647
      return state % bound
    }
    for (let round = 0; round < 20_000; round += 1) {
      const text = Array.from({ length: 1 + next(8) }, () => fragments[next(fragments.length)]).join("")
      const once = scrubText(text)
      assert.strictEqual(scrubText(once), once, JSON.stringify(text))
    }
  })

  it("returns an empty string for what isn't a string, without calling into it", () => {
    const javaScript: { scrubText(text: unknown, ownKeyPrefixes?: unknown): string } = { scrubText }
    const { proxy, revoke } = Proxy.revocable({}, {})
    revoke()
    for (const value of [undefined, null, 42, new Error("Bearer abcDEF1234567890"), proxy]) {
      assert.strictEqual(javaScript.scrubText(value, "acme_"), "")
    }
  })

  // Linear, a megabyte of each worst case takes milliseconds; the bound is generous, so a slow
  // machine passes and a quadratic pattern doesn't.
  it("takes time linear in the text's length, whatever the text is made of", () => {
    const crafted: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
      ["a.".repeat(250_000) + "@" + "a".repeat(500_000), []],
      [fill("eyJ-"), []],
      [fill("ey" + "A".repeat(5_000) + " "), []],
      [fill("Bearer "), []],
      [fill("token a-b-b-b-b-b-b-b-b "), []],
      [fill(fake("-----BEGIN RSA PRIV·ATE KEY-----")), []],
      [fill("a://user:"), []],
      [fill("a://u:p"), []],
      [fill("authorization:" + " ".repeat(1_000)), []],
      [fill("?token=%3F"), []],
      [fill('"password":"'), []],
      [fill("a%40"), []],
      [fill("a".repeat(64) + "@" + "a.".repeat(126) + "1 "), []],
      [fill("4242 "), []],
      [fill("a".repeat(15) + " "), Array.from({ length: 50 }, (_, index) => "a".repeat(index + 1))],
    ]
    for (const [text, prefixes] of crafted) {
      const start = performance.now()
      scrubText(text, prefixes)
      assert.isBelow(performance.now() - start, 1_000, text.slice(0, 40))
    }
  })

  // A repetition of anything but one character class makes V8 throw and JavaScriptCore stop
  // matching after a few million characters; a group repeated inside a lookahead makes
  // JavaScriptCore stop after a few megabytes of ordinary lines. `bun run test` runs this on both
  // engines.
  it("keeps scrubbing after 16 million characters of anything", () => {
    const run = 16_000_000
    const lines = (line: string) => line.repeat(Math.ceil(run / line.length))
    const after = '\n{"password":"hunter2"} retry with token abcDEF1234567890'
    const scrubbed = '\n{"password":"[secret]"} retry with token [token]'
    for (const text of [
      "Bearer " + "A".repeat(run),
      '{"secret":"' + "x".repeat(run) + '"}',
      "acme_live_" + "a".repeat(run),
      lines("WARN token re-issued for user 42\n"),
      lines("search q=token a-b-b-b-b-b-b-b-b "),
    ]) {
      assert.strictEqual(scrubText(text + after, ["acme_live_"]).slice(-scrubbed.length), scrubbed, text.slice(0, 20))
    }
  })
})

describe("isSecretName", () => {
  it("knows the names whose values are credentials, and no others", () => {
    for (const name of [
      "http.request.header.authorization",
      "proxy-authorization",
      "set-cookie",
      "password",
      "clientSecret",
      "x-api-key",
      "accessToken",
      "AWS_SECRET_ACCESS_KEY",
      "private_key",
      "jwt",
      "passphrase",
      "connection_string",
      "SessionId",
    ]) {
      assert.isTrue(isSecretName(name), name)
    }
    for (const name of ["max_tokens", "gen_ai.usage.input_tokens", "http.route", "keyword", "monkey", "otp", "ssn"]) {
      assert.isFalse(isSecretName(name), name)
    }
    const javaScript: { isSecretName(name: unknown): boolean } = { isSecretName }
    assert.isFalse(javaScript.isSecretName(42))
  })
})
