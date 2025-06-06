// simplerauth-x-middleware.ts
/*
======X LOGIN SCRIPT========
This is the most simple version of x oauth with vote tracking using DORM for data persistence.

To use it, ensure to create a x oauth client, then set .dev.vars and wrangler.toml alike with the Env variables required

And navigate to /login from the homepage, with optional parameters ?vote=choice1,choice2,choice3

The middleware now tracks votes and determines appropriate OAuth scopes based on user choices.
*/

import {
  createClient,
  DORM,
  DORMClient,
  jsonSchemaToSql,
  TableSchema,
  type Records,
} from "dormroom"; // Adjust import path as needed

export { DORM };

export interface Env {
  X_CLIENT_ID: string;
  X_CLIENT_SECRET: string;
  X_REDIRECT_URI: string;
  LOGIN_REDIRECT_URI: string;
  DORM_NAMESPACE: DurableObjectNamespace<DORM>;
}

export interface UserData extends Records {
  username: string;
  access_token: string;
  user_id: string;
  name: string;
  profile_image_url?: string;
  public_metrics?: string; // JSON string
  liberated: number; // SQLite boolean (0/1)
  vote_choices?: string; // Comma-separated string
  vote_scopes?: string; // Space-separated string (OAuth format)
  vote_timestamp?: string;
  authorized_at: string;
  updated_at: string;
}

// JSON Schema for users table
const userSchema: TableSchema = {
  $id: "users",
  type: "object",
  properties: {
    username: {
      type: "string",
      "x-dorm-primary-key": true,
    },
    access_token: {
      type: "string",
      "x-dorm-unique": true,
    },
    user_id: {
      type: "string",
    },
    name: {
      type: "string",
    },
    profile_image_url: {
      type: "string",
    },
    public_metrics: {
      type: "string", // JSON
    },
    liberated: {
      type: "integer",
      "x-dorm-default": 1,
      "x-dorm-index": true, // Index for faster queries
    },
    vote_choices: {
      type: "string", // Comma-separated
    },
    vote_scopes: {
      type: "string", // Space-separated OAuth format
    },
    vote_timestamp: {
      type: "string",
      format: "date-time",
    },
    authorized_at: {
      type: "string",
      format: "date-time",
    },
    updated_at: {
      type: "string",
      format: "date-time",
    },
  },
  required: [
    "username",
    "access_token",
    "user_id",
    "name",
    "authorized_at",
    "updated_at",
  ],
};

export const migrations = { 1: jsonSchemaToSql(userSchema) };
export const html = (strings: TemplateStringsArray, ...values: any[]) => {
  return strings.reduce(
    (result, str, i) => result + str + (values[i] || ""),
    "",
  );
};

async function generateRandomString(length: number): Promise<string> {
  const randomBytes = new Uint8Array(length);
  crypto.getRandomValues(randomBytes);
  return Array.from(randomBytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function generateCodeChallenge(codeVerifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function determineScopesFromVote(voteChoices: string[]): string {
  const baseScopes = ["users.read", "offline.access"]; // Always required

  // If vote is "1" (fully public domain) or contains any choices, we need all scopes
  if (voteChoices.includes("1") || voteChoices.length > 0) {
    const allScopes = [
      ...baseScopes,
      "tweet.read", // Read posts/tweets
      "follows.read", // Read follows/followers
      "list.read", // Read lists
      "like.read", // Read likes others have done on your post
      // "space.read", // Read spaces participation
      // "mute.read", // Read muted accounts
      // "bookmark.read", // Read bookmarks
    ];
    return allScopes.join(" ");
  }

  // If no vote choices (shouldn't happen from the form, but fallback)
  return baseScopes.join(" ");
}

function getDBClient(env: Env, ctx: ExecutionContext): DORMClient {
  return createClient({
    doNamespace: env.DORM_NAMESPACE,
    version: "v2",
    migrations,
    ctx: ctx,
    name: "users_db",
  });
}

export async function getUser(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<UserData | null> {
  const cookies =
    request.headers
      .get("Cookie")
      ?.split(";")
      .map((c) => c.trim()) || [];

  const token = cookies
    .find((c) => c.startsWith("x_access_token="))
    ?.split("=")[1];

  if (!token) {
    return null;
  }

  try {
    const decodedToken = decodeURIComponent(token);
    const client = getDBClient(env, ctx);

    const user = await client
      .exec<UserData>(
        "SELECT * FROM users WHERE access_token = ?",
        decodedToken,
      )
      .one()
      .catch(() => null);

    if (!user) {
      return null;
    }

    return user;
  } catch (error) {
    console.error("Error retrieving user from DORM:", error);
    return null;
  }
}

export const middleware = async (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
) => {
  const url = new URL(request.url);

  if (url.pathname === "/logout") {
    const url = new URL(request.url);
    const redirectTo = url.searchParams.get("redirect_to") || "/";
    return new Response(null, {
      status: 302,
      headers: {
        Location: redirectTo,
        "Set-Cookie":
          "x_access_token=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/, x_vote_data=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/",
      },
    });
  }

  // Login page route
  if (url.pathname === "/login") {
    const voteParam = url.searchParams.get("vote");
    const voteChoices = voteParam ? voteParam.split(",") : [];

    // Determine OAuth scopes based on vote choices
    const scopeString = determineScopesFromVote(voteChoices);

    console.log("Vote choices:", voteChoices);
    console.log("Required scopes:", scopeString);

    const state = await generateRandomString(16);
    const codeVerifier = await generateRandomString(43);
    const codeChallenge = await generateCodeChallenge(codeVerifier);

    const headers = new Headers({
      Location: `https://x.com/i/oauth2/authorize?response_type=code&client_id=${
        env.X_CLIENT_ID
      }&redirect_uri=${encodeURIComponent(
        env.X_REDIRECT_URI,
      )}&scope=${encodeURIComponent(
        scopeString,
      )}&state=${state}&code_challenge=${codeChallenge}&code_challenge_method=S256`,
    });

    // Store OAuth state and code verifier
    headers.append(
      "Set-Cookie",
      `x_oauth_state=${state}; HttpOnly; Path=/; Secure; SameSite=Lax; Max-Age=600`,
    );
    headers.append(
      "Set-Cookie",
      `x_code_verifier=${codeVerifier}; HttpOnly; Path=/; Secure; SameSite=Lax; Max-Age=600`,
    );

    // Store vote data if provided
    if (voteChoices.length > 0) {
      const voteData = {
        choices: voteChoices.join(","), // Store as comma-separated string
        scopes: scopeString, // Store as space-separated string
        timestamp: new Date().toISOString(),
      };
      headers.append(
        "Set-Cookie",
        `x_vote_data=${encodeURIComponent(
          JSON.stringify(voteData),
        )}; HttpOnly; Path=/; Secure; SameSite=Lax; Max-Age=600`,
      );
    }

    return new Response("Redirecting to X OAuth", { status: 307, headers });
  }

  // Twitter OAuth callback route
  if (url.pathname === "/callback") {
    const urlState = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    const cookie = request.headers.get("Cookie") || "";
    const cookies = cookie.split(";").map((c) => c.trim());

    const stateCookie = cookies
      .find((c) => c.startsWith("x_oauth_state="))
      ?.split("=")[1];
    const codeVerifier = cookies
      .find((c) => c.startsWith("x_code_verifier="))
      ?.split("=")[1];
    const voteDataCookie = cookies
      .find((c) => c.startsWith("x_vote_data="))
      ?.split("=")[1];

    // Validate state and code verifier
    if (
      !urlState ||
      !stateCookie ||
      urlState !== stateCookie ||
      !codeVerifier
    ) {
      return new Response(
        html`
          <!DOCTYPE html>
          <html lang="en" class="bg-black">
            <head>
              <meta charset="UTF-8" />
              <meta
                name="viewport"
                content="width=device-width, initial-scale=1.0"
              />
              <title>Authentication Error - Free My X</title>
              <script src="https://cdn.tailwindcss.com"></script>
            </head>
            <body
              class="text-white bg-gradient-to-br from-black via-gray-900 to-red-900 min-h-screen flex items-center justify-center"
            >
              <div
                class="max-w-md mx-auto p-8 bg-red-900/20 border border-red-500/30 rounded-xl"
              >
                <h1 class="text-2xl font-bold text-red-400 mb-4">
                  Authentication Error
                </h1>
                <p class="text-gray-300 mb-6">
                  Invalid state or missing code verifier. This could be due to:
                </p>
                <ul class="text-sm text-gray-400 mb-6 space-y-1">
                  <li>• Expired authentication session</li>
                  <li>• Potential CSRF attack</li>
                  <li>• Browser security restrictions</li>
                </ul>
                <a
                  href="/login"
                  class="bg-green-600 hover:bg-green-700 px-6 py-3 rounded-full font-bold transition-all inline-block"
                >
                  Try Again
                </a>
              </div>
            </body>
          </html>
        `,
        { status: 400, headers: { "Content-Type": "text/html" } },
      );
    }

    try {
      // Exchange code for access token
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
            code: code || "",
            redirect_uri: env.X_REDIRECT_URI,
            grant_type: "authorization_code",
            code_verifier: codeVerifier,
          }),
        },
      );

      if (!tokenResponse.ok) {
        const errorText = await tokenResponse.text();
        throw new Error(
          `Twitter API responded with ${tokenResponse.status}: ${errorText}`,
        );
      }

      const { access_token }: any = await tokenResponse.json();

      // Fetch user data from X API
      const userResponse = await fetch(
        "https://api.x.com/2/users/me?user.fields=profile_image_url,public_metrics",
        { headers: { Authorization: `Bearer ${access_token}` } },
      );

      if (!userResponse.ok) {
        throw new Error(`Failed to fetch user data: ${userResponse.status}`);
      }

      const { data: xUser } = await userResponse.json();

      // Parse vote data if available
      let voteData = null;
      if (voteDataCookie) {
        try {
          voteData = JSON.parse(decodeURIComponent(voteDataCookie));
        } catch (error) {
          console.error("Failed to parse vote data:", error);
        }
      }

      const client = getDBClient(env, ctx);
      const now = new Date().toISOString();

      // Prepare user data for database
      const userData: Partial<UserData> = {
        username: xUser.username,
        access_token: access_token,
        user_id: xUser.id,
        name: xUser.name,
        profile_image_url: xUser.profile_image_url,
        public_metrics: xUser.public_metrics
          ? JSON.stringify(xUser.public_metrics)
          : undefined,
        liberated: 1, // Auto-liberate when they authorize
        vote_choices: voteData ? voteData.choices : undefined, // Already comma-separated string
        vote_scopes: voteData ? voteData.scopes : undefined, // Already space-separated string
        vote_timestamp: voteData ? voteData.timestamp : undefined,
        authorized_at: now,
        updated_at: now,
      };

      // Insert or update user data
      await client
        .exec(
          `INSERT OR REPLACE INTO users 
           (username, access_token, user_id, name, profile_image_url, public_metrics, 
            liberated, vote_choices, vote_scopes, vote_timestamp, authorized_at, updated_at) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          userData.username,
          userData.access_token,
          userData.user_id,
          userData.name,
          userData.profile_image_url,
          userData.public_metrics,
          userData.liberated,
          userData.vote_choices,
          userData.vote_scopes,
          userData.vote_timestamp,
          userData.authorized_at,
          userData.updated_at,
        )
        .toArray();

      const headers = new Headers({
        Location: url.origin + (env.LOGIN_REDIRECT_URI || "/dashboard"),
      });

      // Set access token cookie
      headers.append(
        "Set-Cookie",
        `x_access_token=${encodeURIComponent(
          access_token,
        )}; HttpOnly; Path=/; Secure; SameSite=Lax; Max-Age=34560000`,
      );

      // Clear temporary cookies
      headers.append("Set-Cookie", `x_oauth_state=; Max-Age=0`);
      headers.append("Set-Cookie", `x_code_verifier=; Max-Age=0`);
      headers.append("Set-Cookie", `x_vote_data=; Max-Age=0`);

      return new Response("Authorization successful, redirecting...", {
        status: 307,
        headers,
      });
    } catch (error) {
      return new Response(
        html`
          <!DOCTYPE html>
          <html lang="en" class="bg-black">
            <head>
              <meta charset="UTF-8" />
              <meta
                name="viewport"
                content="width=device-width, initial-scale=1.0"
              />
              <title>Login Failed - Free My X</title>
              <script src="https://cdn.tailwindcss.com"></script>
            </head>
            <body
              class="text-white bg-gradient-to-br from-black via-gray-900 to-red-900 min-h-screen flex items-center justify-center"
            >
              <div
                class="max-w-md mx-auto p-8 bg-red-900/20 border border-red-500/30 rounded-xl"
              >
                <h1 class="text-2xl font-bold text-red-400 mb-4">
                  X Authorization Failed
                </h1>
                <p class="text-gray-300 mb-4">
                  We couldn't complete your login:
                </p>
                <div
                  class="bg-red-500/10 border border-red-500/30 rounded p-3 mb-6"
                >
                  <code class="text-sm text-red-300"
                    >${error instanceof Error
                      ? error.message
                      : "Unknown error"}</code
                  >
                </div>
                <div class="space-x-4">
                  <a
                    href="/login"
                    class="bg-green-600 hover:bg-green-700 px-6 py-3 rounded-full font-bold transition-all inline-block"
                  >
                    Try Again
                  </a>
                  <a
                    href="/"
                    class="text-gray-400 hover:text-gray-300 underline"
                  >
                    Go Home
                  </a>
                </div>
              </div>
            </body>
          </html>
        `,
        {
          status: 500,
          headers: {
            "Content-Type": "text/html",
            "Set-Cookie": `x_oauth_state=; Max-Age=0, x_code_verifier=; Max-Age=0, x_vote_data=; Max-Age=0`,
          },
        },
      );
    }
  }
};
