# Changelog

## 0.1.0

First version: Effect AI from a Cloudflare Worker through its AI binding.
`CloudflareBindingLanguageModel` provides Effect's `LanguageModel` on Workers AI, for text, streamed
text, and structured output, with Workers AI's request settings per layer and `withConfigOverride`
per part of a program; `CloudflareBindingClient` provides `@effect/ai-cloudflare`'s
`CloudflareClient`, so its `CloudflareDecisionModel` runs Clef's decisions through the binding. Each call's span carries OpenTelemetry's GenAI attributes: the model, its settings, the finish
reason and the tokens.
