import { registerHooks } from 'node:module';

// Sources are TypeScript imported without extensions; Node strips the types.
registerHooks({
  resolve: (specifier, context, nextResolve) => {
    if (specifier.startsWith('agentdeck/')) {
      const path = `../../agentdeck/src/${specifier.slice('agentdeck/'.length)}.ts`;
      return { url: new URL(path, import.meta.url).href, shortCircuit: true };
    }
    if (specifier.startsWith('.') && !/\.[cm]?[jt]s$|\.json$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});
