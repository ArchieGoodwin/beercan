// BeerCan Custom Tools: Upload-Post Social Media Integration
// Requires UPLOAD_POST_API_KEY and UPLOAD_POST_PROFILE (nickname).
// Connect networks at your Mark Supreme dashboard → Platforms section.

const getConfig = () => ({
  apiUrl: process.env.UPLOAD_POST_API_URL || "https://api.upload-post.com/api",
  apiKey: process.env.UPLOAD_POST_API_KEY,
  profile: process.env.UPLOAD_POST_PROFILE,
  markSupremeUrl: process.env.MARK_SUPREME_URL || "https://app.marksupreme.com",
});

export const tools = [
  // ── List Connected Platforms ────────────────────────────
  {
    definition: {
      name: "list_social_platforms",
      description: "List connected social media platforms from Upload-Post. Shows which networks are available for posting.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    handler: async () => {
      const { apiUrl, apiKey, profile, markSupremeUrl } = getConfig();

      if (!apiKey) {
        return [
          "Upload-Post is not configured yet.",
          "",
          "To set up:",
          `1. Go to ${markSupremeUrl} → Platforms to connect your social networks`,
          "2. Get your API key from Upload-Post settings",
          "3. Run these commands:",
          "   beercan config set UPLOAD_POST_API_KEY=your-key",
          "   beercan config set UPLOAD_POST_PROFILE=your-nickname",
        ].join("\n");
      }

      if (!profile) {
        return "ERROR: UPLOAD_POST_PROFILE (nickname) not set. Run: beercan config set UPLOAD_POST_PROFILE=your-nickname";
      }

      try {
        const response = await fetch(`${apiUrl}/uploadposts/users/${profile}`, {
          headers: {
            "Authorization": `ApiKey ${apiKey}`,
            "Accept": "application/json",
          },
        });

        if (!response.ok) {
          return `ERROR: Upload-Post API returned ${response.status}. Check your API key and profile nickname.`;
        }

        const data = await response.json();
        const accounts = data.social_accounts || data.platforms || data.connected || [];

        if (Array.isArray(accounts) && accounts.length === 0) {
          return [
            "No social networks connected yet.",
            "",
            `Go to ${markSupremeUrl} → Platforms to connect your accounts.`,
            "",
            "Supported: Twitter/X, Instagram, TikTok, LinkedIn, Reddit, Threads, Facebook, YouTube, Pinterest, Bluesky",
          ].join("\n");
        }

        let result = `Connected platforms for profile "${profile}":\n`;
        if (Array.isArray(accounts)) {
          for (const a of accounts) {
            result += `\n● ${a.platform || a.name} — ${a.username || a.handle || "connected"}`;
          }
        } else {
          result += JSON.stringify(accounts, null, 2);
        }
        result += `\n\nManage connections: ${markSupremeUrl}`;
        return result;
      } catch (err) {
        return `Cannot reach Upload-Post API: ${err.message}\nManage connections: ${markSupremeUrl}`;
      }
    },
  },

  // ── Upload Text Post ───────────────────────────────────
  {
    definition: {
      name: "upload_post",
      description: "Publish a text post to social media via Upload-Post. Supports: twitter/x, instagram, tiktok, linkedin, reddit, threads, facebook, youtube, pinterest, bluesky. Call list_social_platforms first to check connected accounts.",
      inputSchema: {
        type: "object",
        properties: {
          platforms: {
            type: "array",
            items: { type: "string" },
            description: "Target platforms (e.g., ['twitter', 'linkedin']). Use 'x' or 'twitter' for Twitter.",
          },
          content: {
            type: "string",
            description: "The post text/description",
          },
          title: {
            type: "string",
            description: "Optional title (used by Reddit, YouTube, some platforms)",
          },
          subreddit: {
            type: "string",
            description: "Required for Reddit posts — the subreddit name without r/",
          },
        },
        required: ["platforms", "content"],
      },
    },
    handler: async ({ platforms, content, title, subreddit }) => {
      const { apiUrl, apiKey, profile } = getConfig();

      if (!apiKey) {
        return "ERROR: UPLOAD_POST_API_KEY not configured. Run: beercan config set UPLOAD_POST_API_KEY=your-key";
      }
      if (!profile) {
        return "ERROR: UPLOAD_POST_PROFILE not configured. Run: beercan config set UPLOAD_POST_PROFILE=your-nickname";
      }

      try {
        const body = new URLSearchParams();
        body.append("user", profile);
        body.append("description", content);
        if (title) body.append("title", title);
        if (subreddit) body.append("subreddit", subreddit);
        for (const p of platforms) {
          body.append("platforms[]", p === "twitter" ? "x" : p);
        }

        const response = await fetch(`${apiUrl}/upload_text`, {
          method: "POST",
          headers: {
            "Authorization": `ApiKey ${apiKey}`,
            "Accept": "application/json",
          },
          body,
        });

        if (!response.ok) {
          const err = await response.text();
          return `ERROR: Upload-Post returned ${response.status}: ${err}`;
        }

        const result = await response.json();
        const platformList = platforms.join(", ");

        if (result.errors && Object.keys(result.errors).length > 0) {
          return `Partial success posting to ${platformList}:\n${JSON.stringify(result.errors, null, 2)}`;
        }

        return `Post published to ${platformList}! ${result.id ? "ID: " + result.id : ""}`;
      } catch (err) {
        return `ERROR: Failed to publish: ${err.message}`;
      }
    },
  },
];
