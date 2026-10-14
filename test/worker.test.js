import assert from "node:assert/strict";
import test from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createWorker } from "../src/index.js";

const audience = "https://chat-app.example.com/";
const env = { GOOGLE_CHAT_AUDIENCE: audience, RESPONSE_FORMAT: "text" };
const { publicKey, privateKey } = await generateKeyPair("RS256");
const publicJwk = await exportJWK(publicKey);
const keySet = createLocalJWKSet({ keys: [{ ...publicJwk, kid: "test-key", alg: "RS256" }] });

async function token({ claims = {}, issuer = "https://accounts.google.com", aud = audience,
  expires = "5m", signingKey = privateKey } = {}) {
  return new SignJWT({ email: "chat@system.gserviceaccount.com", email_verified: true, ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(issuer).setAudience(aud).setIssuedAt().setExpirationTime(expires).sign(signingKey);
}

async function request(body = { type: "MESSAGE" }, bearer) {
  bearer ??= await token();
  return new Request(audience, {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function fixture(fetchImpl = async () => Response.json({ fact: "Cats have whiskers.", length: 19 })) {
  return createWorker({ keySet, fetchImpl });
}

test("verified Chat messages fetch and return the fact in Google's text schema", async () => {
  const worker = fixture(async (url, options) => {
    assert.equal(url, "https://catfact.ninja/fact");
    assert.equal(options.headers.Accept, "application/json");
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({ fact: "Cats have whiskers." });
  });
  const response = await worker.fetch(await request(), env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type"), /application\/json/);
  assert.deepEqual(await response.json(), { text: "🐱 *Meow*\nCats have whiskers." });
});

test("unauthorized requests are rejected before accessing the fact API", async (t) => {
  const otherKey = (await generateKeyPair("RS256")).privateKey;
  const badTokens = {
    "wrong audience": await token({ aud: "https://another-app.example/" }),
    "wrong issuer": await token({ issuer: "https://attacker.example" }),
    "wrong service account": await token({ claims: { email: "other@example.com" } }),
    "unverified email": await token({ claims: { email_verified: false } }),
    "expired token": await token({ expires: Math.floor(Date.now() / 1000) - 60 }),
    "invalid signature": await token({ signingKey: otherKey }),
    "malformed token": "not-a-jwt",
  };
  const worker = fixture(() => { assert.fail("Unauthorized requests must not fetch facts"); });
  for (const [name, bearer] of Object.entries(badTokens)) {
    await t.test(name, async () => {
      assert.equal((await worker.fetch(await request(undefined, bearer), env)).status, 401);
    });
  }
  await t.test("missing bearer", async () => {
    const req = await request();
    req.headers.delete("Authorization");
    assert.equal((await worker.fetch(req, env)).status, 401);
  });
});

test("event lifecycle responds to addition and quietly acknowledges removal", async () => {
  const worker = fixture(() => { assert.fail("Lifecycle events must not fetch facts"); });
  const added = await worker.fetch(await request({ type: "ADDED_TO_SPACE" }), env);
  assert.match((await added.json()).text, /@mention/);
  for (const type of ["REMOVED_FROM_SPACE", "CARD_CLICKED"]) {
    const response = await worker.fetch(await request({ type }), env);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {});
  }
});

test("app commands return a fact", async () => {
  const response = await fixture().fetch(await request({ type: "APP_COMMAND" }), env);
  assert.match((await response.json()).text, /Cats have whiskers/);
});

test("card responses escape HTML from the upstream API", async () => {
  const worker = fixture(async () => Response.json({ fact: 'Cats <b> & "dogs"' }));
  const response = await worker.fetch(await request(), { ...env, RESPONSE_FORMAT: "card" });
  const message = await response.json();
  assert.match(message.fallbackText, /Cats <b>/);
  assert.equal(message.cardsV2[0].card.sections[0].widgets[0].textParagraph.text,
    "<i>Cats &lt;b&gt; &amp; &quot;dogs&quot;</i>");
});

test("default cards include Meow and only the refresh action", async () => {
  const response = await fixture().fetch(await request(), {
    GOOGLE_CHAT_AUDIENCE: audience,
  });
  const message = await response.json();
  assert.equal(message.actionResponse, undefined);
  assert.equal(message.text, undefined);
  assert.equal(message.fallbackText, "🐱 Meow\nCats have whiskers.");
  const card = message.cardsV2[0];
  assert.equal(card.cardId, "catFactCard");
  assert.deepEqual(card.card.header, { title: "Meow" });
  const buttons = card.card.sections.flatMap((section) => section.widgets)
    .flatMap((widget) => widget.buttonList?.buttons ?? []);
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].text, "Get Another Fact");
  assert.deepEqual(buttons[0].onClick, {
    action: { function: "fetchNewFact", loadIndicator: "SPINNER" },
  });
});

test("refresh clicks fetch a new fact and update the same card repeatedly", async (t) => {
  for (const action of [
    { common: { invokedFunction: "fetchNewFact" } },
    { action: { actionMethodName: "fetchNewFact" } },
  ]) {
    await t.test(Object.keys(action)[0], async () => {
      let count = 0;
      const worker = fixture(async () => Response.json({ fact: `Fact ${++count}` }));
      const cardEnv = { ...env, RESPONSE_FORMAT: "card" };
      let message = await (await worker.fetch(await request(), cardEnv)).json();
      const originalId = message.cardsV2[0].cardId;
      for (let i = 2; i <= 3; i++) {
        const response = await worker.fetch(await request({
          type: "CARD_CLICKED", ...action, message,
        }), cardEnv);
        assert.equal(response.status, 200);
        message = await response.json();
        assert.deepEqual(message.actionResponse, { type: "UPDATE_MESSAGE" });
        assert.equal(message.cardsV2[0].cardId, originalId);
        assert.equal(message.cardsV2[0].card.sections[0].widgets[0].textParagraph.text, `<i>Fact ${i}</i>`);
        assert.equal(message.cardsV2[0].card.sections[0].widgets[2].buttonList.buttons[0]
          .onClick.action.function, "fetchNewFact");
      }
      assert.equal(count, 3);
    });
  }
});

test("refresh failures keep a retry button and update the existing message", async () => {
  const worker = fixture(async () => new Response("unavailable", { status: 503 }));
  const response = await worker.fetch(await request({
    type: "CARD_CLICKED", common: { invokedFunction: "fetchNewFact" },
  }), env);
  const message = await response.json();
  assert.equal(response.status, 200);
  assert.equal(message.actionResponse.type, "UPDATE_MESSAGE");
  assert.match(message.cardsV2[0].card.sections[0].widgets[0].textParagraph.text, /try again/);
  assert.equal(message.cardsV2[0].card.sections[0].widgets[2].buttonList.buttons.length, 1);
});

test("unknown clicks do not fetch facts or update messages", async () => {
  const worker = fixture(() => { assert.fail("Unknown actions must not fetch facts"); });
  const response = await worker.fetch(await request({
    type: "CARD_CLICKED", common: { invokedFunction: "unrelated" },
  }), env);
  assert.deepEqual(await response.json(), {});
});

test("refresh requests still require a valid Google bearer token", async () => {
  const worker = fixture(() => { assert.fail("Unsigned clicks must not fetch facts"); });
  const req = await request({ type: "CARD_CLICKED", common: { invokedFunction: "fetchNewFact" } });
  req.headers.delete("Authorization");
  assert.equal((await worker.fetch(req, env)).status, 401);
});

test("initial card failures provide a refresh button for retrying", async () => {
  const worker = fixture(async () => { throw new Error("Network failure"); });
  const response = await worker.fetch(await request(), { ...env, RESPONSE_FORMAT: "card" });
  const message = await response.json();
  assert.equal(response.status, 200);
  assert.equal(message.actionResponse, undefined);
  assert.match(message.fallbackText, /try again/);
  assert.equal(message.cardsV2[0].card.sections[0].widgets[2].buttonList.buttons[0]
    .onClick.action.function, "fetchNewFact");
});

test("upstream failures produce a friendly Chat message with HTTP 200", async (t) => {
  const cases = {
    "HTTP error": async () => new Response("unavailable", { status: 503 }),
    "missing fact": async () => Response.json({ length: 0 }),
    "blank fact": async () => Response.json({ fact: "  " }),
    "invalid JSON": async () => new Response("invalid"),
    "network timeout": async () => { throw new DOMException("Timed out", "TimeoutError"); },
  };
  for (const [name, fetchImpl] of Object.entries(cases)) {
    await t.test(name, async () => {
      const response = await fixture(fetchImpl).fetch(await request(), env);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        text: "🐱 I couldn't fetch a cat fact right now. Please try again!",
      });
    });
  }
});

test("malformed events receive HTTP 400", async () => {
  for (const body of ["{bad", "null", "[]", "{}", '{"type":123}', '{"chat":{}}']) {
    assert.equal((await fixture().fetch(await request(body), env)).status, 400);
  }
});

test("routes, methods, and missing configuration have explicit responses", async () => {
  const worker = fixture();
  const health = await worker.fetch(new Request(audience), env);
  assert.equal((await health.json()).status, "ok");
  assert.equal((await worker.fetch(new Request(`${audience}other`), env)).status, 404);
  const method = await worker.fetch(new Request(audience, { method: "PUT" }), env);
  assert.equal(method.status, 405);
  assert.equal(method.headers.get("Allow"), "GET, POST");
  assert.equal((await worker.fetch(await request(), {})).status, 503);
});
