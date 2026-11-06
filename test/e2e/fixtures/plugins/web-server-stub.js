/**
 * The `webServer` service the panel injects, reduced to what a headless run
 * needs: it accepts exact GET routes and remembers them.
 *
 * A headless session serves no HTTP, so no socket is opened and no port is
 * taken. The routes stay observable through `routes` for a scenario that wants
 * to assert the panel mounted them.
 */

export const name = 'e2e-web-server-stub';

export function apply(ctx) {
  const routes = [];
  ctx.effect(() => ctx.provide('webServer', {
    register(route) {
      routes.push(route);
      return () => {
        const index = routes.indexOf(route);
        if (index !== -1) routes.splice(index, 1);
      };
    },
    routes,
  }));
}
