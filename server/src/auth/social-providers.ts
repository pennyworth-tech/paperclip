/**
 * Optional Google social provider.
 *
 * Deliberately import-free: `auth/better-auth.ts` is dynamic-imported only in
 * authenticated mode, but `routes/auth.ts` is always mounted and needs the same
 * flags to tell the unauthenticated sign-in page which buttons to render.
 * Keeping the resolvers here lets both import them statically without pulling
 * `better-auth` into every boot.
 *
 * Upstream default is unchanged: with neither env var set there is no social
 * provider, and email/password stays enabled.
 */

export interface GoogleSocialProviderConfig {
  clientId: string;
  clientSecret: string;
}

export function resolveGoogleSocialProvider(
  env: NodeJS.ProcessEnv = process.env,
): GoogleSocialProviderConfig | null {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/**
 * Email/password sign-in and sign-up switch. Defaults to enabled so an
 * un-configured instance behaves exactly as it did before this change;
 * `PAPERCLIP_AUTH_DISABLE_EMAIL_PASSWORD=true` closes it entirely, which
 * `PAPERCLIP_AUTH_DISABLE_SIGN_UP` alone cannot do.
 */
export function isEmailPasswordAuthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.PAPERCLIP_AUTH_DISABLE_EMAIL_PASSWORD?.trim().toLowerCase();
  return !(raw === "true" || raw === "1");
}

export interface AuthProviderFlags {
  google: boolean;
  emailPassword: boolean;
}

export function resolveAuthProviderFlags(env: NodeJS.ProcessEnv = process.env): AuthProviderFlags {
  return {
    google: resolveGoogleSocialProvider(env) !== null,
    emailPassword: isEmailPasswordAuthEnabled(env),
  };
}
