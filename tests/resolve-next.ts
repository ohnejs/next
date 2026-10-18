import { registerHooks } from 'node:module';

// `next` has no `exports` map, so plain Node needs the extension a bundler would add.
registerHooks({
  resolve: (specifier, context, nextResolve) =>
    nextResolve(/^next\/[a-z-]+$/.test(specifier) ? `${specifier}.js` : specifier, context),
});
