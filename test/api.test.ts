import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, parseHistory } from "../src/app.ts";
import { LruCache } from "../src/lru.ts";
import { buildMessages, parseSentences } from "../src/suggest.ts";
import type { VoiceProvider } from "../src/voice.ts";

const VOICE = "abcDEF1234567890";

async function* chunks(...parts: string[]) {
  for (const part of parts) yield Buffer.from(part);
}

function mockVoice(overrides: Partial<VoiceProvider> = {}) {
  return {
    speak: vi.fn(async () => chunks("mp", "3")),
    transcribe: vi.fn(async () => "wa cup hot"),
    clone: vi.fn(async () => "cloned123456"),
    ...overrides,
  } satisfies VoiceProvider;
}

const speak = (app: ReturnType<typeof createApp>, body: object) =>
  request(app).post("/api/speak").send(body).buffer(true).parse((res, cb) => {
    const parts: Buffer[] = [];
    res.on("data", (d: Buffer) => parts.push(d));
    res.on("end", () => cb(null, Buffer.concat(parts)));
  });

beforeEach(() => {
  vi.stubEnv("DEFAULT_VOICE_ID", "defaultvoice123");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("LruCache", () => {
  it("evicts the least recently used entry", () => {
    const cache = new LruCache<number>(2, 1000);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a");
    cache.set("c", 3);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.size).toBe(2);
  });

  it("expires entries after the ttl", () => {
    let now = 0;
    const cache = new LruCache<number>(2, 1000, () => now);
    cache.set("a", 1);
    now = 999;
    expect(cache.get("a")).toBe(1);
    now = 2000;
    expect(cache.get("a")).toBeUndefined();
  });
});

describe("POST /api/speak", () => {
  it("maps default to DEFAULT_VOICE_ID and returns mp3", async () => {
    const voice = mockVoice();
    const res = await speak(createApp({ voice }), { text: " Hello ", voiceId: "default" });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("audio/mpeg");
    expect(res.body.toString()).toBe("mp3");
    expect(voice.speak).toHaveBeenCalledWith("Hello", "defaultvoice123");
  });

  it("explains a missing default voice", async () => {
    vi.stubEnv("DEFAULT_VOICE_ID", "");
    const res = await request(createApp({ voice: mockVoice() })).post("/api/speak").send({ text: "Hi", voiceId: "default" });
    expect(res.status).toBe(503);
    expect(res.body.error).toContain("DEFAULT_VOICE_ID");
  });

  it.each([
    [{ text: "   ", voiceId: VOICE }],
    [{ text: "x".repeat(301), voiceId: VOICE }],
    [{ voiceId: VOICE }],
    [{ text: "Hi", voiceId: "../etc" }],
    [{ text: "Hi" }],
  ])("rejects %j", async (body) => {
    const voice = mockVoice();
    const res = await request(createApp({ voice })).post("/api/speak").send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
    expect(voice.speak).not.toHaveBeenCalled();
  });

  it("accepts exactly 300 characters", async () => {
    const res = await speak(createApp({ voice: mockVoice() }), { text: "x".repeat(300), voiceId: VOICE });
    expect(res.status).toBe(200);
  });

  it("serves repeats from the cache", async () => {
    const voice = mockVoice();
    const app = createApp({ voice });
    await speak(app, { text: "Hi", voiceId: VOICE });
    const res = await speak(app, { text: "Hi", voiceId: VOICE });
    expect(res.body.toString()).toBe("mp3");
    expect(voice.speak).toHaveBeenCalledTimes(1);
  });

  it("does not cache a stream that fails partway", async () => {
    async function* broken() {
      yield Buffer.from("partial");
      throw new Error("boom");
    }
    const voice = mockVoice({ speak: vi.fn(async () => broken()) });
    const app = createApp({ voice });
    await speak(app, { text: "Hi", voiceId: VOICE }).catch(() => {});
    await speak(app, { text: "Hi", voiceId: VOICE }).catch(() => {});
    expect(voice.speak).toHaveBeenCalledTimes(2);
  });

  it("does not log text from provider errors", async () => {
    const voice = mockVoice({
      speak: vi.fn(async () => {
        throw Object.assign(new Error("secret sentence"), { statusCode: 401 });
      }),
    });
    const res = await request(createApp({ voice })).post("/api/speak").send({ text: "secret sentence", voiceId: VOICE });
    expect(res.status).toBe(502);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("secret");
  });
});

describe("POST /api/voice/clone", () => {
  const post = (voice: VoiceProvider) =>
    request(createApp({ voice })).post("/api/voice/clone").field("name", "Sam");

  it.each(["", "false", "TRUE", "yes"])("refuses consent %j before any provider call", async (consent) => {
    const voice = mockVoice();
    const res = await post(voice).field("consent", consent).attach("samples", Buffer.from("x"), { filename: "a.mp3", contentType: "audio/mpeg" });
    expect(res.status).toBe(400);
    expect(voice.clone).not.toHaveBeenCalled();
  });

  it("clones audio with consent", async () => {
    const voice = mockVoice();
    const res = await post(voice).field("consent", "true").attach("samples", Buffer.from("x"), { filename: "a.mp3", contentType: "audio/mpeg" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ voiceId: "cloned123456" });
  });

  it("requires a file and rejects other types", async () => {
    const voice = mockVoice();
    expect((await post(voice).field("consent", "true")).status).toBe(400);
    const res = await post(voice).field("consent", "true").attach("samples", Buffer.from("x"), { filename: "a.txt", contentType: "text/plain" });
    expect(res.status).toBe(400);
    expect(voice.clone).not.toHaveBeenCalled();
  });
});

describe("POST /api/suggest", () => {
  const sentences = ["One.", "Two.", "Three."];

  it("combines typed and heard fragments", async () => {
    const suggest = vi.fn(async () => sentences);
    const res = await request(createApp({ voice: mockVoice(), suggest }))
      .post("/api/suggest")
      .field("text", "tea")
      .field("language", "de")
      .attach("audio", Buffer.from("x"), { filename: "a.webm", contentType: "audio/webm" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ fragments: "tea wa cup hot", sentences });
    expect(suggest.mock.calls[0]).toMatchObject([{ fragments: "tea wa cup hot", language: "de" }]);
  });

  it("reports silence without calling the model", async () => {
    const suggest = vi.fn(async () => sentences);
    const voice = mockVoice({ transcribe: vi.fn(async () => "") });
    const res = await request(createApp({ voice, suggest }))
      .post("/api/suggest")
      .attach("audio", Buffer.from("x"), { filename: "a.webm", contentType: "audio/webm" });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("no_speech");
    expect(suggest).not.toHaveBeenCalled();
  });

  it("works from a photo alone", async () => {
    const suggest = vi.fn(async () => sentences);
    const res = await request(createApp({ voice: mockVoice(), suggest }))
      .post("/api/suggest")
      .attach("image", Buffer.from("x"), { filename: "a.jpg", contentType: "image/jpeg" });
    expect(res.status).toBe(200);
  });

  it("returns JSON for oversized uploads and bad types", async () => {
    const app = createApp({ voice: mockVoice(), suggest: vi.fn(async () => sentences) });
    const big = await request(app).post("/api/suggest").attach("image", Buffer.alloc(16 * 1024 * 1024), { filename: "a.jpg", contentType: "image/jpeg" });
    expect(big.status).toBe(400);
    expect(big.body.error).toBeTruthy();
    const svg = await request(app).post("/api/suggest").attach("image", Buffer.from("x"), { filename: "a.svg", contentType: "image/svg+xml" });
    expect(svg.status).toBe(400);
  });
});

describe("parsing", () => {
  it("reads fenced JSON and removes duplicates", () => {
    expect(parseSentences('```json\n{"sentences":["A.","A."," B. "]}\n```')).toEqual(["A.", "B."]);
  });

  it.each(["", "no json", "{bad", '{"sentences":"x"}', "null"])("returns nothing for %j", (raw) => {
    expect(parseSentences(raw)).toEqual([]);
  });

  it("ignores malformed history", () => {
    expect(parseHistory("nope")).toEqual([]);
    expect(parseHistory('[{"fragments":1},{"fragments":"a","sentence":"b"}]')).toEqual([{ fragments: "a", sentence: "b" }]);
  });

  it("only adds an image when there is one", () => {
    const input = { fragments: "x", language: "en" as const, profile: "", history: [] };
    expect(JSON.stringify(buildMessages(input))).not.toContain("image_url");
    expect(JSON.stringify(buildMessages({ ...input, image: { data: Buffer.from("x"), mime: "image/jpeg" } }))).toContain("data:image/jpeg;base64,");
  });
});
