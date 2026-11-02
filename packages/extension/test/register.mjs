import { registerHooks } from 'node:module';

// Sources are TypeScript imported without extensions; Node strips the types.
// Gem's published JS also imports without extensions, those resolve to `.js`.
registerHooks({
  resolve: (specifier, context, nextResolve) => {
    if (specifier.startsWith('agentdeck/')) {
      const path = `../../agentdeck/src/${specifier.slice('agentdeck/'.length)}.ts`;
      return { url: new URL(path, import.meta.url).href, shortCircuit: true };
    }
    if (specifier.startsWith('.') && !/\.[cm]?[jt]s$|\.json$/.test(specifier)) {
      const ext = context.parentURL?.includes('/node_modules/') ? '.js' : '.ts';
      return nextResolve(`${specifier}${ext}`, context);
    }
    return nextResolve(specifier, context);
  },
});
