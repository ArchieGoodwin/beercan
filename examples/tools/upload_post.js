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
          "3. Run:",
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
        // API returns { success, profile: { social_accounts: { platform: { handle, ... } } } }
        const socialAccounts = data?.profile?.social_accounts || data?.social_accounts || {};
        const platformNames = Object.keys(socialAccounts);

        if (platformNames.length === 0) {
          return [
            "No social networks connected yet.",
            `Go to ${markSupremeUrl} → Platforms to connect.`,
            "Supported: x (Twitter), instagram, tiktok, linkedin, reddit, threads, facebook, youtube, pinterest, bluesky",
          ].join("\n");
        }

        let result = `Connected platforms for profile "${profile}" (${platformNames.length}):\n`;
        for (const [platform, info] of Object.entries(socialAccounts)) {
          const details = info;
          result += `\n● ${platform} — @${details.handle || details.display_name || "connected"}`;
        }
        result += `\n\nUse these exact platform names when posting: ${platformNames.join(", ")}`;
        result += `\nManage connections: ${markSupremeUrl}`;
        return result;
      } catch (err) {
        return `Cannot reach Upload-Post API: ${err.message}\nManage at: ${markSupremeUrl}`;
      }
    },
  },

  // ── Upload Text Post ───────────────────────────────────
  {
    definition: {
      name: "upload_post",
      description: "Publish a text post to social media via Upload-Post. Supports: x (twitter), instagram, tiktok, linkedin, reddit, threads, facebook, youtube, pinterest, bluesky. Call list_social_platforms first to check connected accounts. If a platform is not connected, skip it and post to the connected ones.",
      inputSchema: {
        type: "object",
        properties: {
          platforms: {
            type: "array",
            items: { type: "string" },
            description: "Target platforms. Use these exact names: x, instagram, tiktok, linkedin, reddit, threads, facebook, youtube, pinterest, bluesky",
          },
          content: {
            type: "string",
            description: "The post text/description",
          },
          title: {
            type: "string",
            description: "Optional title (used by Reddit, YouTube)",
          },
          subreddit: {
            type: "string",
            description: "Required for Reddit — subreddit name without r/",
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
        // Upload-Post API uses multipart/form-data with "platform[]" (singular!)
        const formParts = [];
        const boundary = "----BeerCan" + Date.now();

        const addField = (name, value) => {
          formParts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}`);
        };

        addField("user", profile);
        addField("title", content);  // "title" is the main post text for Upload-Post API
        if (subreddit) addField("subreddit", subreddit);

        // Each platform as separate "platform[]" field
        for (const p of platforms) {
          const name = p === "twitter" ? "x" : p;
          addField("platform[]", name);
        }

        const body = formParts.join("\r\n") + `\r\n--${boundary}--\r\n`;

        const response = await fetch(`${apiUrl}/upload_text`, {
          method: "POST",
          headers: {
            "Authorization": `ApiKey ${apiKey}`,
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
          },
          body,
        });

        const responseText = await response.text();
        let result;
        try { result = JSON.parse(responseText); } catch { result = { raw: responseText }; }

        if (!response.ok) {
          return `ERROR: Upload-Post returned ${response.status}: ${responseText}`;
        }

        const platformList = platforms.join(", ");

        if (result.errors && Object.keys(result.errors).length > 0) {
          const successes = Object.entries(result).filter(([k, v]) => k !== "errors" && v);
          return `Posted to some platforms. Errors: ${JSON.stringify(result.errors)}\nSuccesses: ${successes.map(([k]) => k).join(", ")}`;
        }

        return `Post published to ${platformList}! Response: ${JSON.stringify(result)}`;
      } catch (err) {
        return `ERROR: Failed to publish: ${err.message}`;
      }
    },
  },
];
