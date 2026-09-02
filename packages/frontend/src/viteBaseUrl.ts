/** Vite injects `import.meta.env`; node --test does not. */
export function viteBaseUrl(): string {
  const env: unknown = Reflect.get(import.meta, 'env');
  if (typeof env !== 'object' || env === null) {
    return '/';
  }
  const baseUrl: unknown = Reflect.get(env, 'BASE_URL');
  return typeof baseUrl === 'string' && baseUrl.length > 0 ? baseUrl : '/';
}
