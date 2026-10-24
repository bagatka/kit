/**
 * The part of a Workers AI binding this package calls: Cloudflare's `Ai` binding, `env.AI` in a
 * Worker, has it, and tests pass a fake.
 */
export interface WorkersAiBinding {
  /**
   * Runs `model` on `inputs`, answering with its output: an object, or for `stream: true` the bytes
   * of its server-sent events. Rejects with an error whose message carries Workers AI's code, such
   * as `3040: Capacity temporarily exceeded, please try again.`. `options.signal` aborts the run.
   */
  run(
    model: string,
    inputs: Readonly<Record<string, unknown>>,
    options?: { readonly signal?: unknown },
  ): Promise<unknown>
}
