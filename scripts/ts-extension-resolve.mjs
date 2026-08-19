/**
 * Resolution hook for `node --test`: the rest of the project uses "bundler
 * resolution" (relative imports with no extension, like `from './math'`),
 * which is what Vite/tsc understand with `moduleResolution: "bundler"`.
 * Node's native ESM loader doesn't — it requires the exact extension.
 * Rather than rewriting `core/` imports just for the test runner (which
 * would break the rest of the codebase's convention and could drift out of
 * sync), this hook falls back to `.ts` when normal resolution fails.
 */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
      try {
        return await nextResolve(`${specifier}.ts`, context);
      } catch {
        // Falls through to the original error: more useful than this one.
      }
    }
    throw err;
  }
}
