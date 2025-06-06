// @ts-check
/// <reference types="@cloudflare/workers-types" />
/// <reference lib="esnext" />

// main.ts
import {
  middleware,
  getUser,
  Env as XAuthEnv,
  UserData,
  DORM,
  migrations,
} from "./simplerauth-x-middleware";
import { createClient, DORMClient } from "dormroom"; // Adjust import path as needed

export { DORM };

export interface Env extends XAuthEnv {
  DORM_NAMESPACE: DurableObjectNamespace<DORM>;
}

function getDBClient(env: Env, ctx: ExecutionContext): DORMClient {
  return createClient({
    doNamespace: env.DORM_NAMESPACE,
    version: "v1",
    migrations,
    ctx: ctx,
    name: "users_db",
  });
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    // First check if this is an X OAuth route
    const authResponse = await middleware(request, env, ctx);
    if (authResponse) return authResponse;

    const url = new URL(request.url);

    // List all liberated users endpoint
    if (url.pathname === "/list.json") {
      try {
        const client = getDBClient(env, ctx);
        const liberatedUsers = await client
          .exec<UserData>(
            "SELECT username, name, profile_image_url, vote_choices, vote_scopes, vote_timestamp, authorized_at, updated_at FROM users WHERE liberated = 1 ORDER BY updated_at DESC",
          )
          .toArray();

        // Transform the data to include parsed vote information and exclude sensitive data
        const publicUserList = liberatedUsers.map((user) => ({
          username: user.username,
          name: user.name,
          profileImageUrl: user.profile_image_url,
          vote: user.vote_choices
            ? {
                choices: JSON.parse(user.vote_choices),
                scopes: user.vote_scopes ? JSON.parse(user.vote_scopes) : [],
                timestamp: user.vote_timestamp,
              }
            : undefined,
          authorizedAt: user.authorized_at,
          updatedAt: user.updated_at,
        }));

        return new Response(
          JSON.stringify(
            {
              count: publicUserList.length,
              users: publicUserList,
              lastUpdated: new Date().toISOString(),
            },
            undefined,
            2,
          ),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "public, max-age=3600", // Cache for 1 hour
              "Access-Control-Allow-Origin": "*", // Allow cross-origin requests
              "Access-Control-Allow-Methods": "GET",
              "Access-Control-Allow-Headers": "Content-Type",
            },
          },
        );
      } catch (error) {
        console.error("List liberated users error:", error);
        return new Response(
          JSON.stringify({
            error: "Failed to fetch liberated users",
            message: error instanceof Error ? error.message : "Unknown error",
          }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
    }

    // Dashboard route - shows user's liberation status
    if (url.pathname === "/dashboard") {
      const user = await getUser(request, env, ctx);

      if (!user) {
        return new Response(null, {
          status: 302,
          headers: { Location: "/login" },
        });
      }

      return new Response(getDashboardHTML(user), {
        headers: { "Content-Type": "text/html" },
      });
    }

    // Toggle liberation status
    if (url.pathname === "/toggle-liberation" && request.method === "POST") {
      const user = await getUser(request, env, ctx);

      if (!user) {
        return Response.json({ error: "Not authenticated" }, { status: 401 });
      }

      try {
        // Toggle liberation status
        const newLiberatedStatus = user.liberated ? 0 : 1;

        const client = getDBClient(env, ctx);

        // Update user data
        await client
          .exec(
            "UPDATE users SET liberated = ?, updated_at = ? WHERE username = ?",
            newLiberatedStatus,
            new Date().toISOString(),
            user.username,
          )
          .toArray();

        return Response.json({
          success: true,
          liberated: Boolean(newLiberatedStatus),
          message: newLiberatedStatus
            ? "Data liberation approved!"
            : "Data liberation revoked!",
        });
      } catch (error) {
        console.error("Toggle liberation error:", error);
        return Response.json(
          { error: "Failed to toggle liberation" },
          { status: 500 },
        );
      }
    }

    // Username check route - /{username}
    if (url.pathname.length > 1 && !url.pathname.includes(".")) {
      const username = url.pathname.slice(1); // Remove leading slash

      try {
        const client = getDBClient(env, ctx);
        const user = await client
          .exec<UserData>("SELECT * FROM users WHERE username = ?", username)
          .one()
          .catch(() => null);

        if (!user) {
          return new Response("User not found", { status: 404 });
        }

        if (user.liberated) {
          // Parse JSON fields and return user data including vote preferences
          const responseData = {
            username: user.username,
            name: user.name,
            liberated: true,
            vote: user.vote_choices
              ? {
                  choices: JSON.parse(user.vote_choices),
                  scopes: user.vote_scopes ? JSON.parse(user.vote_scopes) : [],
                  timestamp: user.vote_timestamp,
                }
              : undefined,
            authorizedAt: user.authorized_at,
            updatedAt: user.updated_at,
          };

          return new Response(JSON.stringify(responseData, undefined, 2), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        } else {
          return new Response("User has not authorized data liberation", {
            status: 403,
          });
        }
      } catch (error) {
        console.error("Username lookup error:", error);
        return new Response("Internal server error", { status: 500 });
      }
    }

    // Default route - 404
    return new Response("Not found", { status: 404 });
  },
};

function getDashboardHTML(user: UserData): string {
  const voteInfo = user.vote_choices
    ? `
    <div class="bg-blue-900/20 border border-blue-500/30 rounded-lg p-4 mb-6">
      <h4 class="font-bold text-blue-300 mb-2">Your Vote & Data Authorization:</h4>
      <div class="text-sm text-blue-200 space-y-2">
        <div class="bg-blue-800/30 p-3 rounded">
          <p class="font-medium text-blue-100">Data Shared:</p>
          <p class="text-blue-200">All your X data (posts, replies, follows/followers, engagement)</p>
        </div>
        <div class="bg-blue-800/30 p-3 rounded">
          <p class="font-medium text-blue-100">Who Can Access:</p>
          <ul class="mt-1 space-y-1">
            ${JSON.parse(user.vote_choices)
              .map((choice: string) => `<li>• ${formatVoteChoice(choice)}</li>`)
              .join("")}
          </ul>
        </div>
      </div>
      <div class="mt-3 text-xs text-blue-300 space-y-1">
        <p>Authorized X scopes: ${
          user.vote_scopes ? JSON.parse(user.vote_scopes).join(", ") : "N/A"
        }</p>
        <p>Vote cast: ${
          user.vote_timestamp
            ? new Date(user.vote_timestamp).toLocaleString()
            : "N/A"
        }</p>
      </div>
    </div>
  `
    : "";

  return `
<!DOCTYPE html>
<html lang="en" class="bg-black">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Dashboard - Free My X</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { font-family: "Inter", sans-serif; }
        .liberation-gradient { background: linear-gradient(135deg, #000000 0%, #1a1a2e 50%, #16213e 100%); }
        .free-border { border: 1px solid rgba(34, 197, 94, 0.3); }
    </style>
</head>
<body class="text-white liberation-gradient min-h-screen">
    <div class="max-w-4xl mx-auto px-4 py-16">
        <div class="text-center mb-12">
            <img src="${
              user.profile_image_url || "/default-avatar.png"
            }" alt="Profile" class="w-24 h-24 rounded-full mx-auto mb-4">
            <h1 class="text-4xl font-bold mb-2">${user.name}</h1>
            <p class="text-xl text-gray-400">@${user.username}</p>
        </div>

        <div class="free-border rounded-xl p-8 mb-8">
            <div class="flex items-center justify-between mb-6">
                <h2 class="text-2xl font-bold">Data Liberation Status</h2>
                <div class="flex items-center gap-2">
                    <div class="w-3 h-3 rounded-full ${
                      user.liberated ? "bg-green-500" : "bg-red-500"
                    }"></div>
                    <span class="font-medium">${
                      user.liberated ? "Liberated" : "Locked"
                    }</span>
                </div>
            </div>
            
            ${voteInfo}
            
            ${
              user.liberated
                ? `
                <div class="bg-green-500/10 border border-green-500/30 rounded-lg p-6 mb-6">
                    <h3 class="text-xl font-bold text-green-400 mb-2">🎉 Your Data is Liberated!</h3>
                    <p class="text-gray-300 mb-4">Third-party applications can check your liberation status and access your X data according to your vote preferences.</p>
                    <button onclick="toggleLiberation()" 
                            class="bg-red-600 hover:bg-red-700 px-6 py-3 rounded-full font-bold transition-all">
                        Revoke Liberation
                    </button>
                </div>
                
                <div class="bg-gray-800/50 rounded-lg p-4">
                    <h4 class="font-bold mb-2">API Access for Third Parties</h4>
                    <div class="space-y-2 text-sm">
                        <div>
                            <code class="text-green-400">GET /${user.username}</code>
                            <p class="text-gray-400">Check liberation status and vote preferences</p>
                        </div>
                        <div>
                            <code class="text-green-400">GET /list.json</code>
                            <p class="text-gray-400">List all liberated users (cached for 1 hour)</p>
                        </div>
                        <div class="bg-gray-700/50 p-3 rounded mt-2">
                            <p class="text-gray-300 font-medium">Returns when liberated:</p>
                            <pre class="text-xs text-gray-400 mt-1">{
  "username": "${user.username}",
  "name": "${user.name}",
  "liberated": true,
  "vote": { choices: [...], scopes: [...] },
  "authorizedAt": "...",
  "updatedAt": "..."
}</pre>
                        </div>
                    </div>
                </div>
            `
                : `
                <div class="bg-red-500/10 border border-red-500/30 rounded-lg p-6 mb-6">
                    <h3 class="text-xl font-bold text-red-400 mb-2">🔒 Your Data is Locked</h3>
                    <p class="text-gray-300 mb-4">Re-enable data liberation to allow third-party access according to your vote.</p>
                    <button onclick="toggleLiberation()" 
                            class="bg-green-600 hover:bg-green-700 px-6 py-3 rounded-full font-bold transition-all">
                        Re-Enable Liberation
                    </button>
                </div>
            `
            }
        </div>

        <div class="text-center">
            <a href="/" class="text-green-400 hover:text-green-300 mr-6">← Back to Home</a>
            <a href="/logout" class="text-red-400 hover:text-red-300">Logout</a>
        </div>
    </div>

    <script>
        async function toggleLiberation() {
            try {
                const response = await fetch('/toggle-liberation', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                });
                
                const result = await response.json();
                
                if (result.success) {
                    window.location.reload();
                } else {
                    alert('Failed to toggle liberation: ' + result.error);
                }
            } catch (error) {
                alert('Error: ' + error.message);
            }
        }
    </script>
</body>
</html>`;
}

function formatVoteChoice(choice: string): string {
  const choices = {
    "1": "Fully Public Domain - Anyone can access and use my data freely",
    "2": "Me - I can access my own data through third-party tools",
    "3": "People I Follow - My network can access my data for mutual benefit",
    "4": "Science & Research - Academic and non-profit research organizations",
  };

  return choices[choice as keyof typeof choices] || `Access Level ${choice}`;
}
