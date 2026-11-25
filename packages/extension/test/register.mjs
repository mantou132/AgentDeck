import { registerHooks } from 'node:module';

const appRoot = new URL('../../agentdeck/', import.meta.url).href;

// Sources are TypeScript imported without extensions; Node strips the types.
// Gem's published JS also imports without extensions, those resolve to `.js`.
registerHooks({
  resolve: (specifier, context, nextResolve) => {
    if (specifier.startsWith('agentdeck/')) {
      const rest = specifier.slice('agentdeck/'.length);
      const ext = rest.endsWith('.json') ? '' : '.ts';
      return { url: new URL(`../../agentdeck/src/${rest}${ext}`, import.meta.url).href, shortCircuit: true };
    }
    if (specifier.startsWith('src/')) {
      const ext = specifier.endsWith('.json') ? '' : '.ts';
      const base = context.parentURL?.startsWith(appRoot) ? '../../agentdeck/' : '../';
      return { url: new URL(`${base}${specifier}${ext}`, import.meta.url).href, shortCircuit: true };
    }
    if (specifier.startsWith('.') && !/\.[cm]?[jt]s$|\.json$/.test(specifier)) {
      const ext = context.parentURL?.includes('/node_modules/') ? '.js' : '.ts';
      return nextResolve(`${specifier}${ext}`, context);
    }
    return nextResolve(specifier, context);
  },
});
