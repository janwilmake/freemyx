/*
======X LOGIN SCRIPT========
This is the most simple version of x oauth with vote tracking.

To use it, ensure to create a x oauth client, then set .dev.vars and wrangler.toml alike with the Env variables required

And navigate to /login from the homepage, with optional parameters ?vote=choice1,choice2,choice3

The middleware now tracks votes and determines appropriate OAuth scopes based on user choices.
*/

export interface Env {
  X_CLIENT_ID: string;
  X_CLIENT_SECRET: string;
  X_REDIRECT_URI: string;
  LOGIN_REDIRECT_URI: string;
}

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

function determineScopesFromVote(voteChoices: string[]): string[] {
  const scopes = ["users.read", "offline.access"]; // Base scopes

  // Map vote choices to required scopes
  const scopeMapping = {
    allow_x_ai: ["tweet.read"],
    allow_third_party_ai: ["tweet.read"],
    controlled_access: ["users.read"], // Already included in base
    public_domain_all: ["tweet.read"],
    public_domain_individuals: ["tweet.read"],
    allow_follows_access: ["follows.read"],
  };

  // Add scopes based on vote choices
  voteChoices.forEach((choice) => {
    const requiredScopes = scopeMapping[choice as keyof typeof scopeMapping];
    if (requiredScopes) {
      requiredScopes.forEach((scope) => {
        if (!scopes.includes(scope)) {
          scopes.push(scope);
        }
      });
    }
  });

  return scopes;
}

export const middleware = async (request: Request, env: Env) => {
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
    const requiredScopes = determineScopesFromVote(voteChoices);
    const scopeString = requiredScopes.join(" ");

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
        choices: voteChoices,
        scopes: requiredScopes,
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
        `Invalid state or missing code verifier ${JSON.stringify({
          urlState,
          stateCookie,
          codeVerifier,
        })}`,
        {
          status: 400,
        },
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

      // Preserve vote data if it exists
      if (voteDataCookie) {
        headers.append(
          "Set-Cookie",
          `x_vote_data=${voteDataCookie}; HttpOnly; Path=/; Secure; SameSite=Lax; Max-Age=34560000`,
        );
      }

      // Clear temporary cookies
      headers.append("Set-Cookie", `x_oauth_state=; Max-Age=0`);
      headers.append("Set-Cookie", `x_code_verifier=; Max-Age=0`);

      return new Response("Authorization successful, redirecting...", {
        status: 307,
        headers,
      });
    } catch (error) {
      return new Response(
        html`
          <!DOCTYPE html>
          <html lang="en">
            <head>
              <title>Login Failed</title>
            </head>
            <body>
              <h1>X Authorization Failed</h1>
              <p>${error instanceof Error ? error.message : "Unknown error"}</p>
              <script>
                alert(
                  "X authorization failed: ${error instanceof Error
                    ? error.message
                    : "Unknown error"}",
                );
                window.location.href = "/";
              </script>
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
