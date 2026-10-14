import { createRemoteJWKSet, jwtVerify } from "jose";

const googleKeys = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
  { timeoutDuration: 5000 },
);
const chatServiceAccount = "chat@system.gserviceaccount.com";

function json(body, status = 200, headers = {}) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}

function factMessage(fact, format) {
  const text = `🐱 *Here is your Cat Fact:*\n${fact}`;
  if (format !== "card") return { text };

  // Card paragraphs interpret HTML, so escape third-party text.
  const escaped = fact.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
  return {
    text,
    cardsV2: [{
      cardId: "catFactCard",
      card: {
        header: { title: "Cat Fact Engine", subtitle: "Feline wisdom on demand" },
        sections: [{ widgets: [{ textParagraph: { text: escaped } }] }],
      },
    }],
  };
}

// Dependencies can be supplied by tests; production always uses Google's keys.
export function createWorker({ fetchImpl = globalThis.fetch, keySet = googleKeys } = {}) {
  return {
    async fetch(request, env) {
      if (new URL(request.url).pathname !== "/") {
        return json({ error: "Not found" }, 404);
      }
      if (request.method === "GET") {
        return json({
          status: "ok",
          app: "Cat Facts Bot",
          message: "Configure Google Chat to POST interaction events to this URL.",
        });
      }
      if (request.method !== "POST") {
        return json({ error: "Method not allowed" }, 405, { Allow: "GET, POST" });
      }
      if (!env.GOOGLE_CHAT_AUDIENCE) {
        return json({ error: "GOOGLE_CHAT_AUDIENCE is not configured" }, 503);
      }

      const bearer = request.headers.get("Authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
      if (!bearer) return json({ error: "Unauthorized" }, 401);
      try {
        const { payload } = await jwtVerify(bearer, keySet, {
          algorithms: ["RS256"],
          issuer: ["https://accounts.google.com", "accounts.google.com"],
          audience: env.GOOGLE_CHAT_AUDIENCE,
          requiredClaims: ["exp", "iat", "email", "email_verified"],
        });
        if (payload.email !== chatServiceAccount || payload.email_verified !== true) {
          return json({ error: "Unauthorized" }, 401);
        }
      } catch {
        return json({ error: "Unauthorized" }, 401);
      }

      let event;
      try {
        event = await request.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
      if (!event || typeof event.type !== "string" || !event.type) {
        return json({ error: "Expected a Google Chat interaction event with a type field" }, 400);
      }

      if (event.type === "ADDED_TO_SPACE") {
        return json({ text: "🐱 Hello! Send me a message, or @mention me in a space, for a cat fact." });
      }
      if (event.type !== "MESSAGE" && event.type !== "APP_COMMAND") {
        // Removed apps cannot send a farewell message; acknowledge other events.
        return json({});
      }

      try {
        const response = await fetchImpl("https://catfact.ninja/fact", {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) throw new Error(`Cat fact API returned ${response.status}`);
        const data = await response.json();
        if (typeof data?.fact !== "string" || !data.fact.trim()) {
          throw new Error("Cat fact API returned no fact");
        }
        return json(factMessage(data.fact.trim(), env.RESPONSE_FORMAT));
      } catch (error) {
        // Avoid logging Chat event bodies or bearer tokens.
        console.error("Cat fact request failed:", error.message);
        return json({ text: "🐱 I couldn't fetch a cat fact right now. Please try again!" });
      }
    },
  };
}

export default createWorker();
