/**
 * Regression guard for the key-info 404 bug.
 *
 * The route used to look the key up with `SELECT … WHERE key = ?`. Since
 * secretAtRest, `api_keys.key` stores an `enc:v1:` envelope (encrypted at
 * rest), so a plaintext lookup missed every real key and the public
 * `/api/key-info` endpoint answered `{"error":"API key not found"}` with 404
 * for valid keys. The route must resolve identity through
 * `getApiKeyMetadata()` (SHA-256 `key_hash` lookup, same as the auth hot path).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const getApiKeyMetadataMock = vi.hoisted(() => vi.fn());
const getApiKeyByIdMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db/apiKeys", () => ({
  getApiKeyMetadata: getApiKeyMetadataMock,
  getApiKeyById: getApiKeyByIdMock,
}));

vi.mock("@/lib/db/core", () => ({
  getDbInstance: () => ({
    prepare: () => ({ get: () => undefined }),
  }),
}));

import { GET } from "@/app/api/key-info/route";

function makeRequest(url: string, headers?: Record<string, string>): Request {
  return new Request(url, { headers });
}

const VALID_KEY = "sk-293b386d882cb2fc-626172-645b0ad0";

const METADATA = {
  id: "key-1",
  name: "Zeniether",
  isActive: true,
  revokedAt: null,
  expiresAt: null,
  maxRequestsPerDay: null,
  maxRequestsPerMinute: null,
  allowedModels: ["model-a"],
  allowedCombos: [],
  rateLimits: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  getApiKeyByIdMock.mockResolvedValue({ createdAt: "2026-01-01", lastUsedAt: null });
});

describe("GET /api/key-info", () => {
  it("resolves a valid key via getApiKeyMetadata (hash lookup), 200 with metadata", async () => {
    getApiKeyMetadataMock.mockResolvedValue(METADATA);

    const res = await GET(makeRequest(`http://localhost/api/key-info?key=${VALID_KEY}`));

    expect(getApiKeyMetadataMock).toHaveBeenCalledWith(VALID_KEY, { bypassCache: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.key_name).toBe("Zeniether");
    expect(body.is_active).toBe(true);
    expect(body.allowed_models).toEqual(["model-a"]);
  });

  it("404s when the key does not exist (hash lookup miss)", async () => {
    getApiKeyMetadataMock.mockResolvedValue(null);

    const res = await GET(makeRequest(`http://localhost/api/key-info?key=sk-bogus`));

    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("API key not found");
  });

  it("400s when no key is provided", async () => {
    const res = await GET(makeRequest("http://localhost/api/key-info"));

    expect(res.status).toBe(400);
  });

  it("never performs a plaintext `key` column lookup — encrypted-at-rest rows must resolve", async () => {
    // If the route ever regresses to `WHERE key = ?`, getApiKeyMetadata is
    // never called and a valid key 404s (the original bug).
    getApiKeyMetadataMock.mockResolvedValue(METADATA);

    const res = await GET(
      makeRequest("http://localhost/api/key-info", { "X-API-Key": VALID_KEY })
    );

    expect(getApiKeyMetadataMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });

  it("reports revoked keys with the revoked strategy", async () => {
    getApiKeyMetadataMock.mockResolvedValue({
      ...METADATA,
      isActive: false,
      revokedAt: "2026-02-02T00:00:00Z",
    });

    const res = await GET(makeRequest(`http://localhost/api/key-info?key=${VALID_KEY}`));

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.strategy).toBe("revoked");
    expect(body.is_unlimited).toBe(false);
  });
});
