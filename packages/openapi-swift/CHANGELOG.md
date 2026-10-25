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
- every part of reading and checking a document takes time linear in it, as `swiftClient`
  promises: each named type is read and judged once, however many refer to it, and a problem in one
  is listed once; types that hold themselves are found in one pass; and names, cases, parameters
  and errors are looked up rather than searched;
- a schema nested more than 100 deep, through references too, is refused, rather than exhausting
  the stack;
- keywords beside a union's members are refused for an error's union too, and `anyOf` and `oneOf`
  together, which said two things where one was read; and a null member with more than its type,
  whose keywords were dropped;
- schemas named `Self`, `KeyedDecodingContainer` or `RawValue`, which wrote Swift that doesn't
  compile, are refused.

## 0.1.0

First version: `swiftClient` writes a typed Swift 6 client from an OpenAPI 3.1 document, as Effect's
`HttpApi` writes one, or lists every problem that keeps it from writing one.
