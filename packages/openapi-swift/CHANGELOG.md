# Changelog

## 0.1.1

Reads two shapes Effect's `HttpApi` writes for plain Schemas, which 0.1.0 refused:
- an `allOf` of checks alone, written for a Schema's second check or a `format` beside a check, is
  the type beside it, such as `String`;
- an `integer`, `number` or `boolean` with an `enum` of its own type's values, such as
  `Schema.Literal(true)` or `Schema.Literals([1, 2])`, is `Int`, `Double` or `Bool`.

An `allOf` with any other keyword, and an `enum` of other values, are still refused; the reason for
a number's or a boolean's now names its type, such as "an enum of other values than booleans".

Fixes, which 0.1.0 had too:
- a keyword beside a nullable value or Effect's number, such as an `allOf` with a `type`, and one
  beside a constant property, are refused, as they are beside any other type;
- each named value type is read once, however many refer to it, so a document is read in time
  linear in its size, as `swiftClient` promises, and a problem in one is listed once.

## 0.1.0

First version: `swiftClient` writes a typed Swift 6 client from an OpenAPI 3.1 document, as Effect's
`HttpApi` writes one, or lists every problem that keeps it from writing one.
