/**
 * Resolution hook for `node --test`, adapted from the root project's
 * script of the same name for this package's own conventions:
 * `functions/`'s source uses NodeNext module resolution (real Node ESM,
 * unlike the root app's bundler resolution), where every relative import
 * already carries an explicit `.js` extension pointing at what the
 * compiled output will be called (`from './moderation.js'`, even though
 * only `moderation.ts` exists in `src/`) — required so the REAL deployed
 * Cloud Function (`lib/index.js`, run by plain Node with no bundler and
 * no loader hook) resolves its own imports correctly. Running tests
 * directly against `src/*.ts` instead of a `tsc`-built `lib/`, though,
 * means those `.js`-suffixed specifiers point at files that don't exist
 * yet — this hook redirects a failed `.js` resolution to the sibling
 * `.ts` file, and (matching the root script) also falls back to
 * appending `.ts` to a bare extensionless specifier, just in case.
 */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (specifier.startsWith('.')) {
      if (specifier.endsWith('.js')) {
        try {
          return await nextResolve(`${specifier.slice(0, -3)}.ts`, context);
        } catch {
          // Falls through to the original error below.
        }
      } else if (!/\.[a-z]+$/i.test(specifier)) {
        try {
          return await nextResolve(`${specifier}.ts`, context);
        } catch {
          // Falls through to the original error below.
        }
      }
    }
    throw err;
  }
}
