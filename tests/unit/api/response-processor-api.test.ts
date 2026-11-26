// Response Processor — GET/PUT /api/settings/response-processor and the preview endpoint,
// through the real route handlers with a management session and an isolated SQLite DB.
import test from "node:test";
import assert from "node:assert/strict";
import { setupSettingsFixture } from "../_mocks/settings.ts";
import { makeManagementSessionRequest } from "../../helpers/managementSession.ts";

const fixture = setupSettingsFixture("response-processor-api");
process.env.OMNIROUTE_DISABLE_REDIS_AUTH_CACHE = "1";
process.env.JWT_SECRET = "test-jwt-secret-response-processor";

const core = await import("../../../src/lib/db/core.ts");
const settingsDb = await import("../../../src/lib/db/settings.ts");
const managementPassword = await import("../../../src/lib/auth/managementPassword.ts");
const route = await import("../../../src/app/api/settings/response-processor/route.ts");
const previewRoute = await import(
  "../../../src/app/api/settings/response-processor/preview/route.ts"
);
const templatesRoute = await import(
  "../../../src/app/api/settings/response-processor/templates/route.ts"
);

test.beforeEach(async () => {
  await fixture.resetStorage();
  await settingsDb.updateSettings({ requireLogin: false });
  await managementPassword.ensurePersistentManagementPasswordHash({ source: "test.bootstrap" });
});

test.after(() => {
  core.resetDbInstance();
  fixture.cleanup();
});

const BASE = "http://localhost:3000/api/settings/response-processor";

const rule = (over: Record<string, unknown> = {}) => ({
  id: "ban-brand",
  enabled: true,
  match: "PECUTI",
  matchType: "literal",
  anchor: "anywhere",
  action: "replace",
  replaceWith: "Proxion",
  ...over,
});

test("GET returns a disabled empty configuration before anything is saved", async () => {
  const response = await route.GET(await makeManagementSessionRequest(BASE));
  const data = await response.json();
  assert.equal(data.enabled, false);
  assert.deepEqual(data.rules, []);
});

test("PUT persists a rule set and GET echoes it back", async () => {
  const putResponse = await route.PUT(
    await makeManagementSessionRequest(BASE, {
      method: "PUT",
      body: { enabled: true, rules: [rule()] },
    })
  );
  assert.equal(putResponse.status, 200);
  const putData = await putResponse.json();
  assert.equal(putData.enabled, true);
  assert.equal(putData.rules.length, 1);

  const getData = await (await route.GET(await makeManagementSessionRequest(BASE))).json();
  assert.equal(getData.enabled, true);
  assert.equal(getData.rules[0].match, "PECUTI");
});

test("PUT rejects an invalid regex at save time and persists nothing", async () => {
  const response = await route.PUT(
    await makeManagementSessionRequest(BASE, {
      method: "PUT",
      body: {
        enabled: true,
        rules: [
          rule({
            id: "bad",
            match: "(unclosed",
            matchType: "regex",
            action: "remove",
            replaceWith: undefined,
          }),
        ],
      },
    })
  );
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.error.details[0].message, /invalid regex/);

  const getData = await (await route.GET(await makeManagementSessionRequest(BASE))).json();
  assert.equal(getData.enabled, false);
});

test("PUT rejects a payload that fails the schema", async () => {
  const response = await route.PUT(
    await makeManagementSessionRequest(BASE, {
      method: "PUT",
      body: { enabled: "yes", rules: "many" },
    })
  );
  assert.equal(response.status, 400);
});

test("preview rewrites sample text with the submitted rules without saving them", async () => {
  const response = await previewRoute.POST(
    await makeManagementSessionRequest(`${BASE}/preview`, {
      method: "POST",
      body: { text: "PECUTI says hi", rules: [rule({ id: "preview-rule" })] },
    })
  );
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.enabled, true);
  assert.equal(data.changed, true);
  assert.equal(data.text, "Proxion says hi");

  const getData = await (await route.GET(await makeManagementSessionRequest(BASE))).json();
  assert.equal(getData.enabled, false, "preview must not persist");
});

test("preview rewrites a chat-completions body", async () => {
  const response = await previewRoute.POST(
    await makeManagementSessionRequest(`${BASE}/preview`, {
      method: "POST",
      body: {
        body: { choices: [{ message: { role: "assistant", content: "hi PECUTI" } }] },
        rules: [rule({ id: "preview-body-rule" })],
      },
    })
  );
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.changed, true);
  assert.equal(data.body.choices[0].message.content, "hi Proxion");
});

test("the templates endpoint serves the inert starter pack", async () => {
  const response = await templatesRoute.GET(
    await makeManagementSessionRequest(`${BASE}/templates`)
  );
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.enabled, false);
  assert.ok(Array.isArray(data.rules));
  assert.ok(data.rules.length >= 40);
});
