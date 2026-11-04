// Social sign-in with Google, Microsoft and Facebook (OAuth 2.0 authorization code
// flow with state + PKCE). Only providers with credentials configured are shown.
import crypto from 'node:crypto';
import { config } from './config.js';

const MS_CONSUMER_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';

const decodeJwt = (jwt) => JSON.parse(Buffer.from(String(jwt).split('.')[1] || '', 'base64url').toString('utf8') || '{}');

const PROVIDERS = {
  google: {
    label: 'Google',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
    extraParams: { prompt: 'select_account' },
    // The ID token comes straight from Google's token endpoint over TLS, so its
    // claims can be trusted without re-verifying the signature (OIDC Core 3.1.3.7).
    profile: async (tokens) => {
      const c = decodeJwt(tokens.id_token);
      return { subject: c.sub, email: c.email, emailVerified: c.email_verified === true, name: c.name, avatar: c.picture };
    },
  },
  microsoft: {
    label: 'Microsoft',
    authorizeUrl: () => `https://login.microsoftonline.com/${config.oauth.microsoft.tenant}/oauth2/v2.0/authorize`,
    tokenUrl: () => `https://login.microsoftonline.com/${config.oauth.microsoft.tenant}/oauth2/v2.0/token`,
    scope: 'openid email profile',
    extraParams: { prompt: 'select_account' },
    profile: async (tokens) => {
      const c = decodeJwt(tokens.id_token);
      // Work/school tenants let admins set arbitrary emails, so only personal
      // Microsoft accounts count as verified for linking to an existing account.
      return {
        subject: `${c.tid}:${c.oid || c.sub}`,
        email: c.email || c.preferred_username,
        emailVerified: c.tid === MS_CONSUMER_TENANT && Boolean(c.email),
        name: c.name,
        avatar: null,
      };
    },
  },
  facebook: {
    label: 'Facebook',
    authorizeUrl: 'https://www.facebook.com/v19.0/dialog/oauth',
    tokenUrl: 'https://graph.facebook.com/v19.0/oauth/access_token',
    scope: 'email public_profile',
    extraParams: {},
    profile: async (tokens) => {
      const res = await fetch(`https://graph.facebook.com/v19.0/me?fields=id,name,email,picture.type(large)&access_token=${encodeURIComponent(tokens.access_token)}`);
      const p = await res.json();
      if (!res.ok) throw new Error(p?.error?.message || 'Facebook profile request failed');
      // Facebook only returns emails that the user has confirmed.
      return { subject: p.id, email: p.email, emailVerified: Boolean(p.email), name: p.name, avatar: p.picture?.data?.url || null };
    },
  },
};

const creds = (name) => config.oauth[name];
const resolve = (v) => (typeof v === 'function' ? v() : v);
const redirectUri = (name) => `${config.baseUrl}/auth/${name}/callback`;

export function enabledProviders() {
  return Object.entries(PROVIDERS)
    .filter(([name]) => creds(name)?.clientId && creds(name)?.clientSecret)
    .map(([name, p]) => ({ name, label: p.label }));
}

export function isEnabled(name) {
  return enabledProviders().some((p) => p.name === name);
}

/** Build the provider URL and remember state/PKCE in the session. */
export function authorizationUrl(name, session) {
  const p = PROVIDERS[name];
  const state = crypto.randomBytes(16).toString('base64url');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  session.oauth = { name, state, verifier, at: Date.now() };
  const params = new URLSearchParams({
    client_id: creds(name).clientId,
    redirect_uri: redirectUri(name),
    response_type: 'code',
    scope: p.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...p.extraParams,
  });
  return `${resolve(p.authorizeUrl)}?${params}`;
}

/** Validate the callback and return the user's profile from the provider. */
export async function handleCallback(name, query, session) {
  const saved = session.oauth;
  delete session.oauth;
  if (query.error) throw new Error(query.error_description || 'Sign-in was cancelled.');
  if (!saved || saved.name !== name || saved.state !== query.state || Date.now() - saved.at > 10 * 60 * 1000) {
    throw new Error('Your sign-in attempt expired. Please try again.');
  }
  const p = PROVIDERS[name];
  const res = await fetch(resolve(p.tokenUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: String(query.code || ''),
      redirect_uri: redirectUri(name),
      client_id: creds(name).clientId,
      client_secret: creds(name).clientSecret,
      code_verifier: saved.verifier,
    }),
  });
  const tokens = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(tokens.error_description || tokens.error?.message || 'Could not complete sign-in.');
  const profile = await p.profile(tokens);
  if (!profile.subject) throw new Error('The provider did not return an account id.');
  return { provider: name, ...profile, email: profile.email?.toLowerCase() || null };
}
