// @ts-check
/// <reference types="@cloudflare/workers-types" />
/// <reference lib="esnext" />

/**
 * OAuth 2.1 Authorization Server with X (Twitter) Integration
 *
 * This is a complete OAuth 2.1 authorization server implementation that can exchange
 * X (Twitter) tokens for local access tokens using token exchange flow.
 *
 * SETUP INSTRUCTIONS:
 *
 * 1. Set up X (Twitter) OAuth App:
 *    - Go to https://developer.x.com
 *    - Create new app with OAuth 2.0 settings
 *    - Add callback URL: https://your-domain.com/callback
 *    - Get CLIENT_ID and CLIENT_SECRET
 *
 * 2. Environment Variables (.dev.vars for local, wrangler.toml for production):
 *    X_CLIENT_ID=your_x_client_id
 *    X_CLIENT_SECRET=your_x_client_secret
 *    X_REDIRECT_URI=https://your-domain.com/callback
 *    SERVER_ISSUER=https://your-domain.com
 *    JWT_SECRET=your_jwt_signing_secret
 *
 * 3. KV Namespace:
 *    - Create KV namespace: wrangler kv:namespace create "OAUTH_STATE"
 *    - Add binding to wrangler.toml:
 *      [[kv_namespaces]]
 *      binding = "KV"
 *      id = "your_kv_namespace_id"
 *
 * 4. Usage in your worker:
 *    import { oauthMiddleware } from './oauth-middleware';
 *
 *    export default {
 *      fetch: async (request: Request, env: Env) => {
 *        const response = await oauthMiddleware(request, env);
 *        if (response) return response;
 *
 *        // Your app logic here
 *        return new Response('Your app');
 *      }
 *    };
 *
 * ENDPOINTS PROVIDED:
 * - GET /.well-known/oauth-authorization-server - Server metadata
 * - GET /authorize - Authorization endpoint (redirects to X)
 * - POST /token - Token endpoint (exchanges codes/tokens)
 * - POST /register - Dynamic client registration
 * - GET /login - Convenience login redirect
 * - GET /callback - X OAuth callback handler
 * - GET /logout - Logout endpoint
 */

export interface Env {
  KV: KVNamespace;
  X_CLIENT_ID: string;
  X_CLIENT_SECRET: string;
  X_REDIRECT_URI: string;
  SERVER_ISSUER: string;
  JWT_SECRET: string;
}

// ===== STATE TYPES =====

interface ClientRegistration {
  client_id: string;
  client_secret?: string;
  client_name?: string;
  redirect_uris: string[];
  grant_types: GrantType[];
  response_types: ResponseType[];
  token_endpoint_auth_method: ClientAuthMethod;
  scope?: string;
  client_uri?: string;
  logo_uri?: string;
  contacts?: string[];
  tos_uri?: string;
  policy_uri?: string;
  jwks_uri?: string;
  jwks?: object;
  software_id?: string;
  software_version?: string;
  client_id_issued_at: number;
  client_secret_expires_at: number;
}

interface AuthorizationCode {
  code: string;
  client_id: string;
  redirect_uri: string;
  scope?: string;
  code_challenge: string;
  code_challenge_method: "S256" | "plain";
  expires_at: number;
  user_id?: string;
}

interface AccessToken {
  token: string;
  client_id: string;
  user_id?: string;
  scope?: string;
  expires_at: number;
  token_type: "Bearer";
}

interface RefreshToken {
  token: string;
  client_id: string;
  user_id?: string;
  scope?: string;
  expires_at?: number;
}

interface UserProfile {
  user_id: string;
  username: string;
  email?: string;
  name: string;
  profile_image_url?: string;
  x_access_token?: string;
}

interface ServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  jwks_uri?: string;
  scopes_supported?: string[];
  response_types_supported: string[];
  grant_types_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  code_challenge_methods_supported?: string[];
  service_documentation?: string;
  ui_locales_supported?: string[];
}

type GrantType =
  | "authorization_code"
  | "client_credentials"
  | "refresh_token"
  | "urn:ietf:params:oauth:grant-type:token-exchange";
type ResponseType = "code";
type ClientAuthMethod = "none" | "client_secret_basic" | "client_secret_post";
type ErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "unauthorized_client"
  | "unsupported_grant_type"
  | "invalid_scope"
  | "invalid_token"
  | "unsupported_token_type";

interface OAuthError {
  error: ErrorCode;
  error_description?: string;
  error_uri?: string;
}

// ===== UTILITY FUNCTIONS =====

/** Generate cryptographically secure random string */
function generateRandomString(length: number): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => chars[byte % chars.length]).join("");
}

/** Generate SHA256 hash of input string */
async function sha256(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Encode string to base64url format */
function base64urlEncode(input: string): string {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  return btoa(String.fromCharCode(...data))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Get current timestamp in seconds since epoch */
function getCurrentTimestamp(): number {
  return Math.floor(Date.now() / 1000);
}

/** Check if timestamp has expired */
function isExpired(expiresAt: number): boolean {
  return getCurrentTimestamp() >= expiresAt;
}

/** Validate URI format and scheme */
function isValidUri(uri: string): boolean {
  try {
    const url = new URL(uri);
    return url.protocol === "https:" || url.hostname === "localhost";
  } catch {
    return false;
  }
}

/** Parse space-delimited scope string into array */
function parseScope(scope?: string): string[] {
  return scope ? scope.split(" ").filter((s) => s.length > 0) : [];
}

/** Join scope array into space-delimited string */
function formatScope(scopes: string[]): string {
  return scopes.join(" ");
}

/** Verify PKCE code challenge against verifier */
async function verifyPkceChallenge(
  codeVerifier: string,
  codeChallenge: string,
  method: "S256" | "plain",
): Promise<boolean> {
  if (method === "plain") {
    return codeVerifier === codeChallenge;
  }

  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
  const urlSafe = base64
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return urlSafe === codeChallenge;
}

// ===== KV STATE MANAGEMENT =====

/** Get value from KV with dot notation key */
async function kvGet<T>(kv: KVNamespace, key: string): Promise<T | null> {
  const value = await kv.get(key);
  return value ? JSON.parse(value) : null;
}

/** Set value in KV with dot notation key */
async function kvPut(
  kv: KVNamespace,
  key: string,
  value: any,
  expirationTtl?: number,
): Promise<void> {
  await kv.put(
    key,
    JSON.stringify(value),
    expirationTtl ? { expirationTtl } : undefined,
  );
}

/** Delete value from KV */
async function kvDelete(kv: KVNamespace, key: string): Promise<void> {
  await kv.delete(key);
}

// ===== CLIENT AUTHENTICATION =====

/** Extract client credentials from HTTP Basic authentication header */
function extractBasicAuth(
  authHeader?: string,
): { client_id: string; client_secret: string } | null {
  if (!authHeader || !authHeader.startsWith("Basic ")) {
    return null;
  }

  try {
    const encoded = authHeader.slice(6);
    const decoded = atob(encoded);
    const [client_id, client_secret] = decoded.split(":");
    return client_id && client_secret ? { client_id, client_secret } : null;
  } catch {
    return null;
  }
}

/** Authenticate client using registered authentication method */
async function authenticateClient(
  kv: KVNamespace,
  client_id?: string,
  client_secret?: string,
  authHeader?: string,
): Promise<ClientRegistration | null> {
  // Try basic auth first
  const basicAuth = extractBasicAuth(authHeader);
  if (basicAuth) {
    client_id = basicAuth.client_id;
    client_secret = basicAuth.client_secret;
  }

  if (!client_id) return null;

  const client = await kvGet<ClientRegistration>(kv, `clients.${client_id}`);
  if (!client) return null;

  // Public clients (method: none) don't need secret verification
  if (client.token_endpoint_auth_method === "none") {
    return client;
  }

  // Confidential clients need secret verification
  if (client.client_secret && client_secret === client.client_secret) {
    return client;
  }

  return null;
}

// ===== EXTERNAL PROVIDER INTEGRATION =====

/** Validate X (Twitter) access token and get user info */
async function validateXToken(
  token: string,
): Promise<{ valid: boolean; user?: UserProfile }> {
  try {
    const response = await fetch(
      "https://api.x.com/2/users/me?user.fields=profile_image_url,verified",
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    if (!response.ok) {
      return { valid: false };
    }

    const { data } = (await response.json()) as {
      data: {
        id: string;
        name: string;
        username: string;
        profile_image_url?: string;
      };
    };

    return {
      valid: true,
      user: {
        user_id: `x:${data.id}`,
        username: data.username,
        name: data.name,
        profile_image_url: data.profile_image_url,
        x_access_token: token,
      },
    };
  } catch (error) {
    console.error("X token validation failed:", error);
    return { valid: false };
  }
}

// ===== ENDPOINT HANDLERS =====

/** Serve authorization server metadata discovery document */
function handleMetadataEndpoint(env: Env): Response {
  const metadata: ServerMetadata = {
    issuer: env.SERVER_ISSUER,
    authorization_endpoint: `${env.SERVER_ISSUER}/authorize`,
    token_endpoint: `${env.SERVER_ISSUER}/token`,
    registration_endpoint: `${env.SERVER_ISSUER}/register`,
    scopes_supported: ["read", "write", "profile"],
    response_types_supported: ["code"],
    grant_types_supported: [
      "authorization_code",
      "client_credentials",
      "refresh_token",
      "urn:ietf:params:oauth:grant-type:token-exchange",
    ],
    token_endpoint_auth_methods_supported: [
      "none",
      "client_secret_basic",
      "client_secret_post",
    ],
    code_challenge_methods_supported: ["S256", "plain"],
  };

  return new Response(JSON.stringify(metadata), {
    headers: { "Content-Type": "application/json" },
  });
}

/** Process authorization endpoint requests and redirect user */
async function handleAuthorizationEndpoint(
  kv: KVNamespace,
  params: URLSearchParams,
): Promise<Response> {
  const response_type = params.get("response_type");
  const client_id = params.get("client_id");
  const redirect_uri = params.get("redirect_uri");
  const scope = params.get("scope");
  const state = params.get("state");
  const code_challenge = params.get("code_challenge");
  const code_challenge_method = (params.get("code_challenge_method") ||
    "plain") as "S256" | "plain";

  // Validate required parameters
  if (response_type !== "code") {
    return new Response(
      JSON.stringify({
        error: "unsupported_response_type",
        error_description: "Only code response type is supported",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  if (!client_id || !code_challenge) {
    return new Response(
      JSON.stringify({
        error: "invalid_request",
        error_description: "Missing required parameters",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // Validate client
  const client = await kvGet<ClientRegistration>(kv, `clients.${client_id}`);
  if (!client) {
    return new Response(
      JSON.stringify({
        error: "invalid_client",
        error_description: "Unknown client",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // Validate redirect URI
  const finalRedirectUri = redirect_uri || client.redirect_uris[0];
  if (!client.redirect_uris.includes(finalRedirectUri)) {
    return new Response(
      JSON.stringify({
        error: "invalid_request",
        error_description: "Invalid redirect URI",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // Generate authorization code
  const code = generateRandomString(32);
  const authCode: AuthorizationCode = {
    code,
    client_id,
    redirect_uri: finalRedirectUri,
    scope,
    code_challenge,
    code_challenge_method,
    expires_at: getCurrentTimestamp() + 600, // 10 minutes
  };

  // Store authorization code
  await kvPut(kv, `auth_codes.${code}`, authCode, 600);

  // Build redirect URL
  const redirectUrl = new URL(finalRedirectUri);
  redirectUrl.searchParams.set("code", code);
  if (state) redirectUrl.searchParams.set("state", state);
  redirectUrl.searchParams.set("iss", env.SERVER_ISSUER);

  return new Response(null, {
    status: 302,
    headers: { Location: redirectUrl.toString() },
  });
}

/** Exchange authorization code for access token */
async function handleAuthorizationCodeGrant(
  kv: KVNamespace,
  params: any,
  client: ClientRegistration,
): Promise<any> {
  const { code, code_verifier, redirect_uri } = params;

  if (!code || !code_verifier) {
    return {
      error: "invalid_request",
      error_description: "Missing required parameters",
    };
  }

  // Get authorization code
  const authCode = await kvGet<AuthorizationCode>(kv, `auth_codes.${code}`);
  if (
    !authCode ||
    authCode.client_id !== client.client_id ||
    isExpired(authCode.expires_at)
  ) {
    return {
      error: "invalid_grant",
      error_description: "Invalid or expired authorization code",
    };
  }

  // Validate PKCE
  const pkceValid = await verifyPkceChallenge(
    code_verifier,
    authCode.code_challenge,
    authCode.code_challenge_method,
  );
  if (!pkceValid) {
    return {
      error: "invalid_grant",
      error_description: "Invalid code verifier",
    };
  }

  // Validate redirect URI
  if (redirect_uri && redirect_uri !== authCode.redirect_uri) {
    return {
      error: "invalid_grant",
      error_description: "Redirect URI mismatch",
    };
  }

  // Generate tokens
  const access_token = generateRandomString(32);
  const refresh_token = generateRandomString(32);
  const expires_in = 3600;

  const accessTokenData: AccessToken = {
    token: access_token,
    client_id: client.client_id,
    user_id: authCode.user_id,
    scope: authCode.scope,
    expires_at: getCurrentTimestamp() + expires_in,
    token_type: "Bearer",
  };

  const refreshTokenData: RefreshToken = {
    token: refresh_token,
    client_id: client.client_id,
    user_id: authCode.user_id,
    scope: authCode.scope,
  };

  // Store tokens
  await kvPut(kv, `access_tokens.${access_token}`, accessTokenData, expires_in);
  await kvPut(kv, `refresh_tokens.${refresh_token}`, refreshTokenData);

  // Delete used authorization code
  await kvDelete(kv, `auth_codes.${code}`);

  return {
    access_token,
    token_type: "Bearer",
    expires_in,
    refresh_token,
    scope: authCode.scope,
  };
}

/** Issue access token for client credentials grant */
async function handleClientCredentialsGrant(
  kv: KVNamespace,
  params: any,
  client: ClientRegistration,
): Promise<any> {
  const access_token = generateRandomString(32);
  const expires_in = 3600;

  const accessTokenData: AccessToken = {
    token: access_token,
    client_id: client.client_id,
    scope: params.scope || client.scope,
    expires_at: getCurrentTimestamp() + expires_in,
    token_type: "Bearer",
  };

  await kvPut(kv, `access_tokens.${access_token}`, accessTokenData, expires_in);

  return {
    access_token,
    token_type: "Bearer",
    expires_in,
    scope: accessTokenData.scope,
  };
}

/** Exchange refresh token for new access token */
async function handleRefreshTokenGrant(
  kv: KVNamespace,
  params: any,
  client: ClientRegistration,
): Promise<any> {
  const { refresh_token } = params;

  if (!refresh_token) {
    return {
      error: "invalid_request",
      error_description: "Missing refresh token",
    };
  }

  const refreshTokenData = await kvGet<RefreshToken>(
    kv,
    `refresh_tokens.${refresh_token}`,
  );
  if (!refreshTokenData || refreshTokenData.client_id !== client.client_id) {
    return {
      error: "invalid_grant",
      error_description: "Invalid refresh token",
    };
  }

  // Generate new access token
  const access_token = generateRandomString(32);
  const expires_in = 3600;

  const accessTokenData: AccessToken = {
    token: access_token,
    client_id: client.client_id,
    user_id: refreshTokenData.user_id,
    scope: params.scope || refreshTokenData.scope,
    expires_at: getCurrentTimestamp() + expires_in,
    token_type: "Bearer",
  };

  await kvPut(kv, `access_tokens.${access_token}`, accessTokenData, expires_in);

  return {
    access_token,
    token_type: "Bearer",
    expires_in,
    scope: accessTokenData.scope,
  };
}

/** Exchange external provider token for local access token */
async function handleTokenExchangeGrant(
  kv: KVNamespace,
  params: any,
  client: ClientRegistration,
): Promise<any> {
  const { subject_token, subject_token_type, subject_issuer } = params;

  if (!subject_token || !subject_token_type) {
    return {
      error: "invalid_request",
      error_description: "Missing required token exchange parameters",
    };
  }

  // Only support X (Twitter) token exchange for now
  if (subject_issuer !== "twitter" && subject_issuer !== "x") {
    return {
      error: "invalid_target",
      error_description: "Unsupported token issuer",
    };
  }

  if (subject_token_type !== "urn:ietf:params:oauth:token-type:access_token") {
    return {
      error: "unsupported_token_type",
      error_description: "Unsupported token type",
    };
  }

  // Validate X token and get user info
  const { valid, user } = await validateXToken(subject_token);
  if (!valid || !user) {
    return {
      error: "invalid_token",
      error_description: "Invalid X access token",
    };
  }

  // Store user info
  await kvPut(kv, `users.${user.user_id}`, user);

  // Generate our access token
  const access_token = generateRandomString(32);
  const refresh_token = generateRandomString(32);
  const expires_in = 3600;

  const accessTokenData: AccessToken = {
    token: access_token,
    client_id: client.client_id,
    user_id: user.user_id,
    scope: params.scope || "read profile",
    expires_at: getCurrentTimestamp() + expires_in,
    token_type: "Bearer",
  };

  const refreshTokenData: RefreshToken = {
    token: refresh_token,
    client_id: client.client_id,
    user_id: user.user_id,
    scope: accessTokenData.scope,
  };

  await kvPut(kv, `access_tokens.${access_token}`, accessTokenData, expires_in);
  await kvPut(kv, `refresh_tokens.${refresh_token}`, refreshTokenData);

  return {
    access_token,
    token_type: "Bearer",
    expires_in,
    refresh_token,
    scope: accessTokenData.scope,
    issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
  };
}

/** Main token endpoint handler dispatching to grant-specific handlers */
async function handleTokenEndpoint(
  kv: KVNamespace,
  request: Request,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "invalid_request" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const formData = await request.formData();
  const params: any = {};
  for (const [key, value] of formData.entries()) {
    params[key] = value;
  }

  const grant_type = params.grant_type;
  if (!grant_type) {
    return new Response(
      JSON.stringify({
        error: "invalid_request",
        error_description: "Missing grant_type parameter",
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  // Authenticate client
  const authHeader = request.headers.get("Authorization");
  const client = await authenticateClient(
    kv,
    params.client_id,
    params.client_secret,
    authHeader,
  );

  if (!client) {
    return new Response(JSON.stringify({ error: "invalid_client" }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": 'Basic realm="oauth"',
      },
    });
  }

  // Check if client supports this grant type
  if (!client.grant_types.includes(grant_type as GrantType)) {
    return new Response(
      JSON.stringify({
        error: "unauthorized_client",
        error_description: "Client not authorized for this grant type",
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  let result: any;

  switch (grant_type) {
    case "authorization_code":
      result = await handleAuthorizationCodeGrant(kv, params, client);
      break;
    case "client_credentials":
      result = await handleClientCredentialsGrant(kv, params, client);
      break;
    case "refresh_token":
      result = await handleRefreshTokenGrant(kv, params, client);
      break;
    case "urn:ietf:params:oauth:grant-type:token-exchange":
      result = await handleTokenExchangeGrant(kv, params, client);
      break;
    default:
      result = { error: "unsupported_grant_type" };
  }

  const status = result.error ? 400 : 200;
  return new Response(JSON.stringify(result), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Register new OAuth client dynamically */
async function handleClientRegistration(
  kv: KVNamespace,
  request: Request,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "invalid_request" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const metadata: any = await request.json();

  // Generate client credentials
  const client_id = generateRandomString(16);
  const client_secret =
    metadata.token_endpoint_auth_method === "none"
      ? undefined
      : generateRandomString(32);
  const now = getCurrentTimestamp();

  const client: ClientRegistration = {
    client_id,
    client_secret,
    client_name: metadata.client_name,
    redirect_uris: metadata.redirect_uris || [],
    grant_types: metadata.grant_types || ["authorization_code"],
    response_types: metadata.response_types || ["code"],
    token_endpoint_auth_method:
      metadata.token_endpoint_auth_method || "client_secret_basic",
    scope: metadata.scope,
    client_uri: metadata.client_uri,
    logo_uri: metadata.logo_uri,
    contacts: metadata.contacts,
    tos_uri: metadata.tos_uri,
    policy_uri: metadata.policy_uri,
    jwks_uri: metadata.jwks_uri,
    jwks: metadata.jwks,
    software_id: metadata.software_id,
    software_version: metadata.software_version,
    client_id_issued_at: now,
    client_secret_expires_at: 0, // Never expires
  };

  await kvPut(kv, `clients.${client_id}`, client);

  return new Response(JSON.stringify(client), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
}

/** Handle X OAuth callback and exchange for local tokens */
async function handleXCallback(
  kv: KVNamespace,
  env: Env,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return new Response(
      JSON.stringify({ error, error_description: "X OAuth error" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  if (!code) {
    return new Response(
      JSON.stringify({
        error: "invalid_request",
        error_description: "Missing code",
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  // Get stored PKCE challenge from state
  const storedState = state
    ? await kvGet<{
        code_verifier: string;
        client_id: string;
        redirect_uri: string;
      }>(kv, `pkce_state.${state}`)
    : null;

  if (!storedState) {
    return new Response(
      JSON.stringify({
        error: "invalid_request",
        error_description: "Invalid state",
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  try {
    // Exchange code for X access token
    const tokenResponse = await fetch(
      "https://api.twitter.com/2/oauth2/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${btoa(
            `${env.X_CLIENT_ID}:${env.X_CLIENT_SECRET}`,
          )}`,
        },
        body: new URLSearchParams({
          code,
          redirect_uri: env.X_REDIRECT_URI,
          grant_type: "authorization_code",
          code_verifier: storedState.code_verifier,
        }),
      },
    );

    if (!tokenResponse.ok) {
      throw new Error(`X API error: ${tokenResponse.status}`);
    }

    const { access_token: x_access_token } = await tokenResponse.json();

    // Get user info from X and create local user
    const { valid, user } = await validateXToken(x_access_token);
    if (!valid || !user) {
      throw new Error("Failed to get user info from X");
    }

    // Store user
    await kvPut(kv, `users.${user.user_id}`, user);

    // Get client for token generation
    const client = await kvGet<ClientRegistration>(
      kv,
      `clients.${storedState.client_id}`,
    );
    if (!client) {
      throw new Error("Client not found");
    }

    // Generate local tokens
    const access_token = generateRandomString(32);
    const refresh_token = generateRandomString(32);
    const expires_in = 3600;

    const accessTokenData: AccessToken = {
      token: access_token,
      client_id: client.client_id,
      user_id: user.user_id,
      scope: "read profile",
      expires_at: getCurrentTimestamp() + expires_in,
      token_type: "Bearer",
    };

    const refreshTokenData: RefreshToken = {
      token: refresh_token,
      client_id: client.client_id,
      user_id: user.user_id,
      scope: "read profile",
    };

    await kvPut(
      kv,
      `access_tokens.${access_token}`,
      accessTokenData,
      expires_in,
    );
    await kvPut(kv, `refresh_tokens.${refresh_token}`, refreshTokenData);

    // Clean up state
    await kvDelete(kv, `pkce_state.${state}`);

    // Redirect to client with authorization code
    const redirectUrl = new URL(storedState.redirect_uri);
    const authCode = generateRandomString(32);

    const authCodeData: AuthorizationCode = {
      code: authCode,
      client_id: client.client_id,
      redirect_uri: storedState.redirect_uri,
      scope: "read profile",
      code_challenge: "dummy", // Not used in this flow
      code_challenge_method: "plain",
      expires_at: getCurrentTimestamp() + 600,
      user_id: user.user_id,
    };

    await kvPut(kv, `auth_codes.${authCode}`, authCodeData, 600);

    redirectUrl.searchParams.set("code", authCode);
    if (state) redirectUrl.searchParams.set("state", state);

    return new Response(null, {
      status: 302,
      headers: { Location: redirectUrl.toString() },
    });
  } catch (error) {
    console.error("X callback error:", error);
    return new Response(
      JSON.stringify({
        error: "server_error",
        error_description: "Failed to process X OAuth callback",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}

/** Handle login convenience endpoint */
async function handleLogin(
  kv: KVNamespace,
  env: Env,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const client_id = url.searchParams.get("client_id") || "default";
  const redirect_uri =
    url.searchParams.get("redirect_uri") || `${env.SERVER_ISSUER}/dashboard`;
  const scope = url.searchParams.get("scope") || "read profile";

  // Generate PKCE challenge
  const code_verifier = generateRandomString(43);
  const encoder = new TextEncoder();
  const data = encoder.encode(code_verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const code_challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const state = generateRandomString(16);

  // Store PKCE state
  await kvPut(
    kv,
    `pkce_state.${state}`,
    {
      code_verifier,
      client_id,
      redirect_uri,
    },
    600,
  );

  // Redirect to X OAuth
  const xAuthUrl = new URL("https://x.com/i/oauth2/authorize");
  xAuthUrl.searchParams.set("response_type", "code");
  xAuthUrl.searchParams.set("client_id", env.X_CLIENT_ID);
  xAuthUrl.searchParams.set("redirect_uri", env.X_REDIRECT_URI);
  xAuthUrl.searchParams.set("scope", "users.read tweet.read offline.access");
  xAuthUrl.searchParams.set("state", state);
  xAuthUrl.searchParams.set("code_challenge", code_challenge);
  xAuthUrl.searchParams.set("code_challenge_method", "S256");

  return new Response(null, {
    status: 302,
    headers: { Location: xAuthUrl.toString() },
  });
}

/** Handle logout endpoint */
function handleLogout(request: Request): Response {
  const url = new URL(request.url);
  const redirect_to = url.searchParams.get("redirect_to") || "/";

  return new Response(null, {
    status: 302,
    headers: {
      Location: redirect_to,
      "Set-Cookie":
        "oauth_access_token=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/",
    },
  });
}

/** Validate bearer token and get associated data */
async function validateBearerToken(
  kv: KVNamespace,
  request: Request,
): Promise<{
  valid: boolean;
  token?: AccessToken;
  user?: UserProfile;
  client?: ClientRegistration;
}> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { valid: false };
  }

  const token = authHeader.slice(7);
  const tokenData = await kvGet<AccessToken>(kv, `access_tokens.${token}`);

  if (!tokenData || isExpired(tokenData.expires_at)) {
    return { valid: false };
  }

  const user = tokenData.user_id
    ? await kvGet<UserProfile>(kv, `users.${tokenData.user_id}`)
    : undefined;
  const client = await kvGet<ClientRegistration>(
    kv,
    `clients.${tokenData.client_id}`,
  );

  return {
    valid: true,
    token: tokenData,
    user: user || undefined,
    client: client || undefined,
  };
}

/** Main OAuth middleware function */
export async function oauthMiddleware(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);

  // OAuth endpoints
  switch (url.pathname) {
    case "/.well-known/oauth-authorization-server":
      return handleMetadataEndpoint(env);

    case "/authorize":
      return handleAuthorizationEndpoint(env.KV, url.searchParams);

    case "/token":
      return handleTokenEndpoint(env.KV, request);

    case "/register":
      return handleClientRegistration(env.KV, request);

    case "/login":
      return handleLogin(env.KV, env, request);

    case "/callback":
      return handleXCallback(env.KV, env, request);

    case "/logout":
      return handleLogout(request);

    default:
      return null; // Let the main app handle other routes
  }
}

/**
 * Example usage in your main worker:
 *
 * ```typescript
 * import { oauthMiddleware } from './oauth-middleware';
 *
 * export default {
 *   fetch: async (request: Request, env: Env) => {
 *     // Handle OAuth endpoints first
 *     const oauthResponse = await oauthMiddleware(request, env);
 *     if (oauthResponse) return oauthResponse;
 *
 *     // Your app logic here
 *     const url = new URL(request.url);
 *
 *     if (url.pathname === '/dashboard') {
 *       // Validate access token
 *       const { valid, user } = await validateBearerToken(env.KV, request);
 *       if (!valid) {
 *         return new Response('Unauthorized', { status: 401 });
 *       }
 *
 *       return new Response(`Welcome ${user?.name}!`);
 *     }
 *
 *     // Default home page with login link
 *     return new Response(`
 *       <h1>OAuth 2.1 Server</h1>
 *       <a href="/login">Login with X</a>
 *     `, { headers: { 'Content-Type': 'text/html' } });
 *   }
 * };
 * ```
 *
 * The middleware provides these endpoints:
 * - GET /.well-known/oauth-authorization-server - Server metadata
 * - GET /authorize - OAuth authorization endpoint
 * - POST /token - Token endpoint (all grant types)
 * - POST /register - Dynamic client registration
 * - GET /login - Convenience login (redirects to X)
 * - GET /callback - X OAuth callback handler
 * - GET /logout - Logout endpoint
 *
 * Token exchange flow:
 * 1. Client calls POST /token with grant_type=urn:ietf:params:oauth:grant-type:token-exchange
 * 2. Include subject_token (X access token), subject_token_type, subject_issuer=x
 * 3. Server validates X token, creates user, issues local tokens
 *
 * Browser flow:
 * 1. User visits /login
 * 2. Redirected to X OAuth
 * 3. X redirects to /callback
 * 4. Server exchanges X token, creates user session
 * 5. User redirected back to app with authorization code
 */
