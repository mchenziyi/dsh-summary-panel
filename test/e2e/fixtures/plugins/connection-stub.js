/**
 * The `connection` service the panel injects: the trust fence in front of its
 * GET routes. An isolated headless run has no browser peer, so nothing is a
 * foreign origin and every request is admitted.
 */

export const name = 'e2e-connection-stub';

export function apply(ctx) {
  ctx.effect(() => ctx.provide('connection', {
    requestRejection: () => undefined,
  }));
}
