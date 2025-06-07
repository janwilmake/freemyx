# Free My X

Features:

- OAuth Client for X with Privacy Policy and terms of use that allows users to approve third parties to access their data
- Endpoint to check a user
- Endpoint to get a list of all users that have approved

# Usage

App and tool developers can use 'Free My X' as part of their onboarding flow to ensure the user data can be gathered with conscent.

```ts
/**
 * Check if a user has liberated their X data
 * @param username - The X username to check
 * @returns Promise<{
 *   user_id: string,
 *   username: string,
 *   name: string,
 *   liberated: true,
 *   vote_choices: string,
 *   vote_scopes: string,
 *   vote_timestamp: string,
 *   authorized_at: string,
 *   updated_at: string,
 *   public: boolean,
 *   me: boolean,
 *   follows: boolean,
 *   science: boolean
 * } | null>
 */
async function checkUserLiberated(username: string) {
  const response = await fetch(`https://freemyx.com/${username}`);

  if (response.status === 403 || response.status === 404) {
    return null; // User not found or not liberated
  }

  return await response.json();
}
```

The response includes boolean flags for access levels:

- `public`: Anyone can access (vote choice "1")
- `me`: User themselves can access (public OR vote choice "2")
- `follows`: People they follow can access (public OR vote choice "3")
- `science`: Research organizations can access (public OR vote choice "4")

[![](https://b.lmpify.com/Example)](https://lmpify.com/httpsuuithubcom-w760l50)

See live in action [here](https://freemyx.com/example)
