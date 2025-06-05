import { middleware, Env as XAuthEnv } from "./simplerauth-x-middleware";

export interface Env extends XAuthEnv {
  APPROVED_USERS: KVNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // First check if this is an X OAuth route
    const authResponse = await middleware(request, env);
    if (authResponse) return authResponse;

    const url = new URL(request.url);

    // Get X access token and vote data from cookies
    const cookies =
      request.headers
        .get("Cookie")
        ?.split(";")
        .map((c) => c.trim()) || [];

    const token = cookies
      .find((c) => c.startsWith("x_access_token="))
      ?.split("=")[1];

    const voteDataCookie = cookies
      .find((c) => c.startsWith("x_vote_data="))
      ?.split("=")[1];

    // Dashboard route - shows user's liberation status
    if (url.pathname === "/dashboard") {
      if (!token) {
        return new Response(null, {
          status: 302,
          headers: { Location: "/login" },
        });
      }

      try {
        const userResponse = await fetch(
          "https://api.x.com/2/users/me?user.fields=profile_image_url,public_metrics",
          { headers: { Authorization: `Bearer ${decodeURIComponent(token)}` } },
        );

        if (!userResponse.ok) {
          throw new Error("Failed to fetch user data");
        }

        const { data: user } = await userResponse.json();

        // Check if user is in our KV store
        const userData = await env.APPROVED_USERS.get(user.username);
        const existingUserData = userData ? JSON.parse(userData) : null;
        const isLiberated = existingUserData?.liberated || false;

        // If user has vote data and is not yet in KV, store them
        if (voteDataCookie && !existingUserData) {
          try {
            const voteData = JSON.parse(decodeURIComponent(voteDataCookie));
            const newUserData = {
              userId: user.id,
              username: user.username,
              name: user.name,
              liberated: true, // Auto-liberate when they vote and authorize
              vote: voteData,
              authorizedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            };

            await env.APPROVED_USERS.put(
              user.username,
              JSON.stringify(newUserData),
            );

            // Update local data for display
            existingUserData = newUserData;
          } catch (error) {
            console.error("Failed to parse vote data:", error);
          }
        }

        return new Response(
          getDashboardHTML(user, isLiberated, existingUserData),
          {
            headers: { "Content-Type": "text/html" },
          },
        );
      } catch (error) {
        return new Response(null, {
          status: 302,
          headers: { Location: "/login" },
        });
      }
    }

    // Toggle liberation status
    if (url.pathname === "/toggle-liberation" && request.method === "POST") {
      if (!token) {
        return Response.json({ error: "Not authenticated" }, { status: 401 });
      }

      try {
        const userResponse = await fetch("https://api.x.com/2/users/me", {
          headers: { Authorization: `Bearer ${decodeURIComponent(token)}` },
        });

        const { data: user } = await userResponse.json();

        // Get current status
        const existingData = await env.APPROVED_USERS.get(user.username);
        const currentData = existingData ? JSON.parse(existingData) : null;
        const newLiberatedStatus = currentData ? !currentData.liberated : true;

        // Preserve vote data if it exists
        let voteData = currentData?.vote || null;
        if (!voteData && voteDataCookie) {
          try {
            voteData = JSON.parse(decodeURIComponent(voteDataCookie));
          } catch (error) {
            console.error("Failed to parse vote data:", error);
          }
        }

        // Store user data with new status
        const userData = {
          userId: user.id,
          username: user.username,
          name: user.name,
          liberated: newLiberatedStatus,
          vote: voteData,
          authorizedAt: currentData?.authorizedAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        await env.APPROVED_USERS.put(user.username, JSON.stringify(userData));

        return Response.json({
          success: true,
          liberated: newLiberatedStatus,
          message: newLiberatedStatus
            ? "Data liberation approved!"
            : "Data liberation revoked!",
        });
      } catch (error) {
        return Response.json(
          { error: "Failed to toggle liberation" },
          { status: 500 },
        );
      }
    }

    // Username check route - /{username}
    if (url.pathname.length > 1 && !url.pathname.includes(".")) {
      const username = url.pathname.slice(1); // Remove leading slash

      const userData = await env.APPROVED_USERS.get(username);

      if (!userData) {
        return new Response("User not found", { status: 404 });
      }

      const user = JSON.parse(userData);

      if (user.liberated) {
        // Return user data including vote preferences
        return Response.json(
          {
            username: user.username,
            name: user.name,
            liberated: true,
            vote: user.vote,
            authorizedAt: user.authorizedAt,
            updatedAt: user.updatedAt,
          },
          { status: 200 },
        );
      } else {
        return new Response("User has not authorized data liberation", {
          status: 403,
        });
      }
    }

    // Default route - 404
    return new Response("Not found", { status: 404 });
  },
};

function getDashboardHTML(
  user: any,
  isLiberated: boolean,
  userData: any,
): string {
  const voteInfo = userData?.vote
    ? `
    <div class="bg-blue-900/20 border border-blue-500/30 rounded-lg p-4 mb-6">
      <h4 class="font-bold text-blue-300 mb-2">Your Vote:</h4>
      <ul class="text-sm text-blue-200 space-y-1">
        ${userData.vote.choices
          .map((choice: string) => `<li>• ${formatVoteChoice(choice)}</li>`)
          .join("")}
      </ul>
      <p class="text-xs text-blue-300 mt-2">Authorized scopes: ${userData.vote.scopes.join(
        ", ",
      )}</p>
      <p class="text-xs text-blue-300">Vote cast: ${new Date(
        userData.vote.timestamp,
      ).toLocaleString()}</p>
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
              user.profile_image_url
            }" alt="Profile" class="w-24 h-24 rounded-full mx-auto mb-4">
            <h1 class="text-4xl font-bold mb-2">${user.name}</h1>
            <p class="text-xl text-gray-400">@${user.username}</p>
        </div>

        <div class="free-border rounded-xl p-8 mb-8">
            <div class="flex items-center justify-between mb-6">
                <h2 class="text-2xl font-bold">Data Liberation Status</h2>
                <div class="flex items-center gap-2">
                    <div class="w-3 h-3 rounded-full ${
                      isLiberated ? "bg-green-500" : "bg-red-500"
                    }"></div>
                    <span class="font-medium">${
                      isLiberated ? "Liberated" : "Locked"
                    }</span>
                </div>
            </div>
            
            ${voteInfo}
            
            ${
              isLiberated
                ? `
                <div class="bg-green-500/10 border border-green-500/30 rounded-lg p-6 mb-6">
                    <h3 class="text-xl font-bold text-green-400 mb-2">🎉 Your Data is Liberated!</h3>
                    <p class="text-gray-300 mb-4">Third-party applications can check your liberation status and access your data according to your vote preferences.</p>
                    <button onclick="toggleLiberation()" 
                            class="bg-red-600 hover:bg-red-700 px-6 py-3 rounded-full font-bold transition-all">
                        Revoke Liberation
                    </button>
                </div>
                
                <div class="bg-gray-800/50 rounded-lg p-4">
                    <h4 class="font-bold mb-2">Check Status Endpoint</h4>
                    <code class="text-sm text-green-400">GET /${user.username}</code>
                    <p class="text-sm text-gray-400 mt-2">Returns user data with vote preferences if liberated, 403 if locked, 404 if not found</p>
                </div>
            `
                : `
                <div class="bg-red-500/10 border border-red-500/30 rounded-lg p-6 mb-6">
                    <h3 class="text-xl font-bold text-red-400 mb-2">🔒 Your Data is Locked</h3>
                    <p class="text-gray-300 mb-4">Re-enable data liberation to allow third-party status checks according to your vote.</p>
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
    allow_x_ai: "Allow X to train AI models with my data",
    allow_third_party_ai: "Allow third-party companies to train AI models",
    controlled_access: "I want full control over data access",
    public_domain_all: "Make my posts public domain for all",
    public_domain_individuals: "Make my posts available to individuals only",
    allow_follows_access: "Allow access to my following/followers data",
  };

  return choices[choice as keyof typeof choices] || choice;
}
