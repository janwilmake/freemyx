// @ts-check
/// <reference types="@cloudflare/workers-types" />
/// <reference lib="esnext" />

import { DurableObject } from "cloudflare:workers";
import { withSimplerAuth, CodeDO } from "simplerauth-x-provider";
export { CodeDO };

export interface Env {
  USERS_DO: DurableObjectNamespace<UsersDatabase>;
  X_CLIENT_ID: string;
  X_CLIENT_SECRET: string;
}

// IETF AI Content Preferences types
interface ContentUsagePreferences {
  public: boolean;
  commercial: boolean;
  science: boolean;
  follows: boolean;
  personal: boolean;
  tdm: boolean;
  ai: boolean;
  genai: boolean;
  search: boolean;
  inference: boolean;
}

interface ExtendedUserData {
  user_id: string;
  username: string;
  name: string;
  profile_image_url: string;
  content_usage?: string;
  preferences_set?: boolean;
  updated_at?: string;
  created_at?: string;
}

function parseContentUsage(contentUsage: string): ContentUsagePreferences {
  const defaults: ContentUsagePreferences = {
    public: false,
    commercial: false,
    science: false,
    follows: false,
    personal: true,
    tdm: false,
    ai: false,
    genai: false,
    search: true,
    inference: true,
  };

  if (!contentUsage) return defaults;

  const prefs = { ...defaults };
  const pairs = contentUsage.split(",").map((p) => p.trim());

  for (const pair of pairs) {
    const [key, value] = pair.split("=").map((s) => s.trim());
    if (key in prefs) {
      prefs[key as keyof ContentUsagePreferences] = value === "y";
    }
  }

  return prefs;
}

function formatContentUsage(prefs: ContentUsagePreferences): string {
  return [
    `public=${prefs.public ? "y" : "n"}`,
    `commercial=${prefs.commercial ? "y" : "n"}`,
    `science=${prefs.science ? "y" : "n"}`,
    `follows=${prefs.follows ? "y" : "n"}`,
    `personal=${prefs.personal ? "y" : "n"}`,
    `tdm=${prefs.tdm ? "y" : "n"}`,
    `ai=${prefs.ai ? "y" : "n"}`,
    `genai=${prefs.genai ? "y" : "n"}`,
    `search=${prefs.search ? "y" : "n"}`,
    `inference=${prefs.inference ? "y" : "n"}`,
  ].join(", ");
}

function getIETFContentUsageHeader(prefs: ContentUsagePreferences): string {
  const scopes = [];

  if (!prefs.tdm) scopes.push("tdm=n");
  else scopes.push("tdm=y");

  if (!prefs.ai) scopes.push("ai=n");
  else scopes.push("ai=y");

  if (!prefs.genai) scopes.push("genai=n");
  else scopes.push("genai=y");

  if (!prefs.search) scopes.push("search=n");
  else scopes.push("search=y");

  if (!prefs.inference) scopes.push("inference=n");
  else scopes.push("inference=y");

  return scopes.join(", ");
}

function getUsersDB(env: Env): DurableObjectStub<UsersDatabase> {
  const id = env.USERS_DO.idFromName("users");
  return env.USERS_DO.get(id);
}

export default {
  fetch: withSimplerAuth(async (request, env: Env, ctx) => {
    const url = new URL(request.url);
    const db = getUsersDB(env);

    // CORS headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    // Handle OPTIONS requests
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 200, headers: corsHeaders });
    }

    // Serve the main landing page
    if (!ctx.user) {
      return new Response(null, {
        headers: { Location: "/" },
        status: 302,
      });
    }

    // Store/update user data in central DO
    await db.upsertUser({
      user_id: ctx.user.id,
      username: ctx.user.username,
      name: ctx.user.name,
      profile_image_url: ctx.user.profile_image_url,
    });

    // Configuration page
    if (url.pathname === "/config") {
      const userData = await db.getUser(ctx.user.username);
      return new Response(getConfigHTML(userData), {
        headers: { "Content-Type": "text/html" },
      });
    }

    // Update preferences
    if (url.pathname === "/update-preferences" && request.method === "POST") {
      try {
        const body: any = await request.json();
        const prefs = body.preferences as ContentUsagePreferences;

        if (!prefs) {
          return Response.json(
            { error: "Invalid preferences" },
            { status: 400 },
          );
        }

        const contentUsageString = formatContentUsage(prefs);
        const ietfHeader = getIETFContentUsageHeader(prefs);

        await db.updatePreferences(ctx.user.username, contentUsageString);

        return Response.json({
          success: true,
          content_usage: contentUsageString,
          ietf_header: ietfHeader,
          message: "Preferences updated successfully!",
        });
      } catch (error) {
        console.error("Update preferences error:", error);
        return Response.json(
          { error: "Failed to update preferences" },
          { status: 500 },
        );
      }
    }

    // List all users with preferences
    if (url.pathname === "/list.json") {
      try {
        const users = await db.getAllUsersWithPreferences();

        const responseData = {
          count: users.length,
          lastUpdated: new Date().toISOString(),
          users: users.map((user) => {
            const prefs = parseContentUsage(user.content_usage || "");
            return {
              user_id: user.user_id,
              username: user.username,
              name: user.name,
              profile_image_url: user.profile_image_url,
              content_usage: user.content_usage,
              ietf_header: getIETFContentUsageHeader(prefs),
              preferences: prefs,
              updated_at: user.updated_at,
            };
          }),
        };

        return new Response(JSON.stringify(responseData, undefined, 2), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=3600",
            ...corsHeaders,
          },
        });
      } catch (error) {
        console.error("List users error:", error);
        return new Response(
          JSON.stringify({
            error: "Failed to fetch users",
            message: error instanceof Error ? error.message : "Unknown error",
          }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
    }

    // Username check route - /{username}
    if (
      url.pathname.length > 1 &&
      !url.pathname.includes(".") &&
      !url.pathname.startsWith("/auth")
    ) {
      const username = url.pathname.slice(1).toLowerCase();

      try {
        const user = await db.getUser(username);

        if (!user) {
          return new Response(JSON.stringify({ error: "User not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }

        if (!user.preferences_set) {
          return new Response(
            JSON.stringify({
              error: "User has not set content usage preferences",
            }),
            {
              status: 403,
              headers: { "Content-Type": "application/json", ...corsHeaders },
            },
          );
        }

        const prefs = parseContentUsage(user.content_usage || "");
        const responseData = {
          user_id: user.user_id,
          username: user.username,
          name: user.name,
          content_usage: user.content_usage,
          ietf_header: getIETFContentUsageHeader(prefs),
          preferences: prefs,
          updated_at: user.updated_at,
        };

        return new Response(JSON.stringify(responseData, undefined, 2), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Content-Usage": user.content_usage || "",
            ...corsHeaders,
          },
        });
      } catch (error) {
        console.error("Username lookup error:", error);
        return new Response("Internal server error", { status: 500 });
      }
    }

    // Default route - 404
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }),
};

function getConfigHTML(user: ExtendedUserData): string {
  const prefs = parseContentUsage(user.content_usage || "");
  const ietfHeader = getIETFContentUsageHeader(prefs);
  const extendedHeader = user.content_usage || formatContentUsage(prefs);

  return `<!DOCTYPE html>
<html lang="en" class="bg-black">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Configure Preferences - Free My X</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { font-family: "Inter", sans-serif; }
        .liberation-gradient { background: linear-gradient(135deg, #000000 0%, #1a1a2e 50%, #16213e 100%); }
        .free-border { border: 1px solid rgba(34, 197, 94, 0.3); }
        .button-glow:hover { box-shadow: 0 0 30px rgba(34, 197, 94, 0.6); }
        
        .pref-toggle {
            position: relative;
            display: inline-block;
            width: 60px;
            height: 34px;
        }
        
        .pref-toggle input {
            opacity: 0;
            width: 0;
            height: 0;
        }
        
        .slider {
            position: absolute;
            cursor: pointer;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background-color: #ccc;
            transition: .4s;
            border-radius: 34px;
        }
        
        .slider:before {
            position: absolute;
            content: "";
            height: 26px;
            width: 26px;
            left: 4px;
            bottom: 4px;
            background-color: white;
            transition: .4s;
            border-radius: 50%;
        }
        
        input:checked + .slider {
            background-color: #22c55e;
        }
        
        input:checked + .slider:before {
            transform: translateX(26px);
        }
        
        .hierarchy-section {
            background: rgba(34, 197, 94, 0.05);
            border: 1px solid rgba(34, 197, 94, 0.2);
            border-radius: 8px;
            padding: 1.5rem;
            margin-bottom: 1.5rem;
        }
        
        .scope-tree {
            font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
            background: #1a1a2e;
            border: 1px solid rgba(34, 197, 94, 0.3);
            border-radius: 8px;
            padding: 1rem;
            margin: 1rem 0;
            font-size: 0.875rem;
        }
        
        .scope-node {
            margin: 0.25rem 0;
            padding-left: 1rem;
        }
        
        .scope-name {
            color: #22c55e;
            font-weight: bold;
        }
        
        .scope-description {
            color: #86efac;
            margin-left: 0.5rem;
        }
        
        .current-header {
            background: #1e40af;
            border: 1px solid #3b82f6;
            border-radius: 8px;
            padding: 1rem;
            margin: 1rem 0;
            font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
            font-size: 0.875rem;
            color: #93c5fd;
            word-break: break-all;
        }
        
        .extended-header {
            background: #16a34a;
            border: 1px solid #22c55e;
            border-radius: 8px;
            padding: 1rem;
            margin: 1rem 0;
            font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
            font-size: 0.875rem;
            color: #86efac;
            word-break: break-all;
        }
    </style>
</head>
<body class="text-white liberation-gradient min-h-screen">
    <div class="max-w-4xl mx-auto px-4 py-16">
        <div class="text-center mb-12">
            <img src="${
              user.profile_image_url || "/default-avatar.png"
            }" alt="Profile" class="w-16 h-16 rounded-full mx-auto mb-4">
            <h1 class="text-4xl font-bold mb-2">${user.name}</h1>
            <p class="text-xl text-gray-400">@${user.username}</p>
        </div>

        <div class="free-border rounded-xl p-8 mb-8">
            <h2 class="text-2xl font-bold mb-6">AI Content Usage Preferences</h2>
            
            <div class="hierarchy-section">
                <h3 class="text-lg font-bold text-green-400 mb-4">IETF Standard Hierarchy</h3>
                <div class="scope-tree">
                    <div class="scope-node">
                        <span class="scope-name">tdm</span><span class="scope-description">Text and Data Mining</span>
                        <div class="scope-node">
                            <span class="scope-name">ai</span><span class="scope-description">AI Training</span>
                            <div class="scope-node">
                                <span class="scope-name">genai</span><span class="scope-description">Generative AI Training</span>
                            </div>
                        </div>
                        <div class="scope-node">
                            <span class="scope-name">search</span><span class="scope-description">Search Indexing</span>
                        </div>
                        <div class="scope-node">
                            <span class="scope-name">inference</span><span class="scope-description">AI Inference</span>
                        </div>
                    </div>
                </div>
                <p class="text-sm text-gray-400">Child scopes inherit from parents unless explicitly overridden.</p>
            </div>

            <form id="preferences-form" class="space-y-6">
                <div class="grid md:grid-cols-2 gap-6">
                    <!-- Access Control -->
                    <div class="hierarchy-section">
                        <h4 class="text-lg font-semibold text-green-400 mb-4">Access Control</h4>
                        
                        <div class="flex items-center justify-between py-3">
                            <div>
                                <div class="font-medium">Public Domain</div>
                                <div class="text-sm text-gray-400">Anyone can access and use</div>
                            </div>
                            <label class="pref-toggle">
                                <input type="checkbox" name="public" ${
                                  prefs.public ? "checked" : ""
                                }>
                                <span class="slider"></span>
                            </label>
                        </div>
                        
                        <div class="flex items-center justify-between py-3">
                            <div>
                                <div class="font-medium">Commercial Use</div>
                                <div class="text-sm text-gray-400">Allow commercial applications</div>
                            </div>
                            <label class="pref-toggle">
                                <input type="checkbox" name="commercial" ${
                                  prefs.commercial ? "checked" : ""
                                }>
                                <span class="slider"></span>
                            </label>
                        </div>
                        
                        <div class="flex items-center justify-between py-3">
                            <div>
                                <div class="font-medium">Science & Research</div>
                                <div class="text-sm text-gray-400">Academic and non-profit research</div>
                            </div>
                            <label class="pref-toggle">
                                <input type="checkbox" name="science" ${
                                  prefs.science ? "checked" : ""
                                }>
                                <span class="slider"></span>
                            </label>
                        </div>
                        
                        <div class="flex items-center justify-between py-3">
                            <div>
                                <div class="font-medium">People I Follow</div>
                                <div class="text-sm text-gray-400">My network connections</div>
                            </div>
                            <label class="pref-toggle">
                                <input type="checkbox" name="follows" ${
                                  prefs.follows ? "checked" : ""
                                }>
                                <span class="slider"></span>
                            </label>
                        </div>
                        
                        <div class="flex items-center justify-between py-3">
                            <div>
                                <div class="font-medium">Personal Use</div>
                                <div class="text-sm text-gray-400">My own tools and applications</div>
                            </div>
                            <label class="pref-toggle">
                                <input type="checkbox" name="personal" ${
                                  prefs.personal ? "checked" : ""
                                }>
                                <span class="slider"></span>
                            </label>
                        </div>
                    </div>

                    <!-- IETF Standard Scopes -->
                    <div class="hierarchy-section">
                        <h4 class="text-lg font-semibold text-green-400 mb-4">IETF AI Scopes</h4>
                        
                        <div class="flex items-center justify-between py-3">
                            <div>
                                <div class="font-medium">Text & Data Mining</div>
                                <div class="text-sm text-gray-400">General data analysis</div>
                            </div>
                            <label class="pref-toggle">
                                <input type="checkbox" name="tdm" ${
                                  prefs.tdm ? "checked" : ""
                                }>
                                <span class="slider"></span>
                            </label>
                        </div>
                        
                        <div class="flex items-center justify-between py-3">
                            <div>
                                <div class="font-medium">AI Training</div>
                                <div class="text-sm text-gray-400">Machine learning model training</div>
                            </div>
                            <label class="pref-toggle">
                                <input type="checkbox" name="ai" ${
                                  prefs.ai ? "checked" : ""
                                }>
                                <span class="slider"></span>
                            </label>
                        </div>
                        
                        <div class="flex items-center justify-between py-3">
                            <div>
                                <div class="font-medium">Generative AI</div>
                                <div class="text-sm text-gray-400">Large language model training</div>
                            </div>
                            <label class="pref-toggle">
                                <input type="checkbox" name="genai" ${
                                  prefs.genai ? "checked" : ""
                                }>
                                <span class="slider"></span>
                            </label>
                        </div>
                        
                        <div class="flex items-center justify-between py-3">
                            <div>
                                <div class="font-medium">Search Indexing</div>
                                <div class="text-sm text-gray-400">Search engine indexing</div>
                            </div>
                            <label class="pref-toggle">
                                <input type="checkbox" name="search" ${
                                  prefs.search ? "checked" : ""
                                }>
                                <span class="slider"></span>
                            </label>
                        </div>
                        
                        <div class="flex items-center justify-between py-3">
                            <div>
                                <div class="font-medium">AI Inference</div>
                                <div class="text-sm text-gray-400">Real-time AI processing</div>
                            </div>
                            <label class="pref-toggle">
                                <input type="checkbox" name="inference" ${
                                  prefs.inference ? "checked" : ""
                                }>
                                <span class="slider"></span>
                            </label>
                        </div>
                    </div>
                </div>

                <div class="space-y-6">
                    <div class="hierarchy-section">
                        <h4 class="text-lg font-semibold text-blue-400 mb-4">IETF Standard Content-Usage Header</h4>
                        <div class="current-header" id="ietf-header">
                            Content-Usage: ${ietfHeader}
                        </div>
                        <p class="text-sm text-gray-400 mt-2">
                            This is the official IETF standard header that should be implemented by X.
                        </p>
                    </div>

                    <div class="hierarchy-section">
                        <h4 class="text-lg font-semibold text-green-400 mb-4">Extended Content-Usage Header</h4>
                        <div class="extended-header" id="extended-header">
                            Content-Usage: ${extendedHeader}
                        </div>
                        <p class="text-sm text-gray-400 mt-2">
                            This is our extended header that includes additional access control preferences:
                        </p>
                        <ul class="text-sm text-gray-400 mt-2 ml-4 list-disc">
                            <li><strong>public</strong> - Content is in the public domain</li>
                            <li><strong>commercial</strong> - Allow commercial use</li>
                            <li><strong>science</strong> - Allow academic and research use</li>
                            <li><strong>follows</strong> - Allow use by people I follow</li>
                            <li><strong>personal</strong> - Allow my own personal use</li>
                        </ul>
                        <p class="text-sm text-gray-400 mt-2">
                            This extended header is returned in the API response and Content-Usage header for username lookups.
                        </p>
                    </div>
                </div>

                <div class="text-center">
                    <button type="submit" class="bg-green-600 hover:bg-green-700 px-12 py-4 rounded-full font-bold text-xl transition-all button-glow">
                        Save Preferences
                    </button>
                </div>
            </form>
        </div>

        <div class="text-center">
            <a href="/" class="text-green-400 hover:text-green-300 mr-6">← Back to Home</a>
            <a href="/logout" class="text-red-400 hover:text-red-300">Logout</a>
        </div>
    </div>

    <script>
        function updateHeaders() {
            const form = document.getElementById('preferences-form');
            const formData = new FormData(form);
            
            const prefs = {
                public: formData.has('public'),
                commercial: formData.has('commercial'),
                science: formData.has('science'),
                follows: formData.has('follows'),
                personal: formData.has('personal'),
                tdm: formData.has('tdm'),
                ai: formData.has('ai'),
                genai: formData.has('genai'),
                search: formData.has('search'),
                inference: formData.has('inference')
            };
            
            // Update IETF header
            const ietfScopes = [];
            ietfScopes.push(\`tdm=\${prefs.tdm ? 'y' : 'n'}\`);
            ietfScopes.push(\`ai=\${prefs.ai ? 'y' : 'n'}\`);
            ietfScopes.push(\`genai=\${prefs.genai ? 'y' : 'n'}\`);
            ietfScopes.push(\`search=\${prefs.search ? 'y' : 'n'}\`);
            ietfScopes.push(\`inference=\${prefs.inference ? 'y' : 'n'}\`);
            
            document.getElementById('ietf-header').textContent = 'Content-Usage: ' + ietfScopes.join(', ');
            
            // Update extended header
            const extendedScopes = [];
            extendedScopes.push(\`public=\${prefs.public ? 'y' : 'n'}\`);
            extendedScopes.push(\`commercial=\${prefs.commercial ? 'y' : 'n'}\`);
            extendedScopes.push(\`science=\${prefs.science ? 'y' : 'n'}\`);
            extendedScopes.push(\`follows=\${prefs.follows ? 'y' : 'n'}\`);
            extendedScopes.push(\`personal=\${prefs.personal ? 'y' : 'n'}\`);
            extendedScopes.push(\`tdm=\${prefs.tdm ? 'y' : 'n'}\`);
            extendedScopes.push(\`ai=\${prefs.ai ? 'y' : 'n'}\`);
            extendedScopes.push(\`genai=\${prefs.genai ? 'y' : 'n'}\`);
            extendedScopes.push(\`search=\${prefs.search ? 'y' : 'n'}\`);
            extendedScopes.push(\`inference=\${prefs.inference ? 'y' : 'n'}\`);
            
            document.getElementById('extended-header').textContent = 'Content-Usage: ' + extendedScopes.join(', ');
        }

        // Update headers when any checkbox changes
        document.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
            checkbox.addEventListener('change', updateHeaders);
        });

        document.getElementById('preferences-form').addEventListener('submit', async function(e) {
            e.preventDefault();
            
            const formData = new FormData(this);
            const preferences = {
                public: formData.has('public'),
                commercial: formData.has('commercial'),
                science: formData.has('science'),
                follows: formData.has('follows'),
                personal: formData.has('personal'),
                tdm: formData.has('tdm'),
                ai: formData.has('ai'),
                genai: formData.has('genai'),
                search: formData.has('search'),
                inference: formData.has('inference')
            };
            
            try {
                const response = await fetch('/update-preferences', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ preferences })
                });
                
                const result = await response.json();
                
                if (result.success) {
                    alert('Preferences saved successfully!');
                    window.location.reload();
                } else {
                    alert('Failed to save preferences: ' + result.error);
                }
            } catch (error) {
                alert('Error: ' + error.message);
            }
        });
    </script>
</body>
</html>`;
}

export class UsersDatabase extends DurableObject {
  private state: DurableObjectState;
  private users: Map<string, ExtendedUserData> = new Map();

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.state = state;
    this.initializeFromStorage();
  }

  private async initializeFromStorage() {
    const stored = await this.state.storage.get<Map<string, ExtendedUserData>>(
      "users",
    );
    if (stored) {
      this.users = stored;
    }
  }

  private async persistUsers() {
    await this.state.storage.put("users", this.users);
  }

  async upsertUser(userData: Partial<ExtendedUserData>) {
    const username = userData.username!.toLowerCase();
    const existing = this.users.get(username);

    const now = new Date().toISOString();
    const user: ExtendedUserData = {
      user_id: userData.user_id!,
      username: userData.username!,
      name: userData.name!,
      profile_image_url: userData.profile_image_url!,
      content_usage: existing?.content_usage,
      preferences_set: existing?.preferences_set || false,
      updated_at: existing?.preferences_set ? existing.updated_at : now,
      created_at: existing?.created_at || now,
    };

    this.users.set(username, user);
    await this.persistUsers();

    return user;
  }

  async getUser(username: string): Promise<ExtendedUserData | null> {
    return this.users.get(username.toLowerCase()) || null;
  }

  async updatePreferences(
    username: string,
    contentUsage: string,
  ): Promise<void> {
    const user = this.users.get(username.toLowerCase());
    if (!user) {
      throw new Error("User not found");
    }

    user.content_usage = contentUsage;
    user.preferences_set = true;
    user.updated_at = new Date().toISOString();

    this.users.set(username.toLowerCase(), user);
    await this.persistUsers();
  }

  async getAllUsersWithPreferences(): Promise<ExtendedUserData[]> {
    return Array.from(this.users.values())
      .filter((user) => user.preferences_set)
      .sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
  }

  async fetch(request: Request): Response {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        userCount: this.users.size,
        usersWithPreferences: Array.from(this.users.values()).filter(
          (u) => u.preferences_set,
        ).length,
      });
    }

    return new Response("Not Found", { status: 404 });
  }
}
