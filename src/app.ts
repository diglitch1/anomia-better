import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type ErrorRequestHandler, type Express, type RequestHandler } from "express";
import multer from "multer";
import { HttpError, logProviderError } from "./errors.ts";
import { llmConfig, suggest as defaultSuggest, type SuggestInput } from "./suggest.ts";
import { createVoiceRouter, elevenLabsProvider, type VoiceProvider } from "./voice.ts";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const MAX_FIELD = 2000;

export interface Deps {
  voice?: VoiceProvider;
  suggest?: (input: SuggestInput) => Promise<string[]>;
}

function rateLimit(limit: number, windowMs: number): RequestHandler {
  const hits = new Map<string, { count: number; resets: number }>();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip ?? "unknown";
    let hit = hits.get(key);
    if (!hit || hit.resets <= now) {
      if (hits.size > 10_000) hits.clear();
      hit = { count: 0, resets: now + windowMs };
      hits.set(key, hit);
    }
    if (++hit.count > limit) {
      res.status(429).json({ error: "Too many requests. Please wait a moment." });
      return;
    }
    next();
  };
}

export function parseHistory(raw: unknown): SuggestInput["history"] {
  if (typeof raw !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((h) => typeof h?.fragments === "string" && typeof h?.sentence === "string")
      .slice(-8)
      .map((h) => ({ fragments: h.fragments.slice(0, 300), sentence: h.sentence.slice(0, 300) }));
  } catch {
    return [];
  }
}

export function createApp({ voice = elevenLabsProvider, suggest = defaultSuggest }: Deps = {}): Express {
  const app = express();
  app.disable("x-powered-by");
  const uploads = multer({ storage: multer.memoryStorage(), limits: { files: 2, fileSize: 15 * 1024 * 1024 } });

  app.use("/api", rateLimit(60, 60_000));

  app.get("/api/health", (_req, res) => {
    const { provider, model } = llmConfig();
    res.json({ ok: true, provider, model, voice: Boolean(process.env.ELEVENLABS_API_KEY) });
  });

  app.post(
    "/api/suggest",
    uploads.fields([
      { name: "audio", maxCount: 1 },
      { name: "image", maxCount: 1 },
    ]),
    async (req, res, next) => {
      try {
        const files = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
        const audio = files.audio?.[0];
        const image = files.image?.[0];
        if (image && !/^image\/(jpeg|png|webp)$/.test(image.mimetype)) throw new HttpError(400, "Photos must be JPEG, PNG or WebP");
        if (audio && !/^(audio|video)\//.test(audio.mimetype)) throw new HttpError(400, "Unsupported audio format");

        const language = req.body?.language === "de" ? "de" : "en";
        const typed = typeof req.body?.text === "string" ? req.body.text.trim().slice(0, 500) : "";
        const heard = audio ? await voice.transcribe(audio.buffer, audio.mimetype, language) : "";
        const fragments = [typed, heard].filter(Boolean).join(" ");
        if (!fragments && !image) throw new HttpError(422, "no_speech");

        const profile = typeof req.body?.profile === "string" ? req.body.profile.slice(0, MAX_FIELD) : "";
        const sentences = await suggest({
          fragments,
          language,
          profile,
          history: parseHistory(req.body?.history),
          image: image && { data: image.buffer, mime: image.mimetype },
        });
        res.json({ fragments, sentences });
      } catch (err) {
        next(err);
      }
    },
  );

  app.use("/api", createVoiceRouter(voice));
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });
  app.use(express.static(PUBLIC_DIR));

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (res.headersSent) {
      res.destroy();
    } else if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
    } else if (err instanceof multer.MulterError) {
      res.status(400).json({ error: "Upload too large or invalid" });
    } else if (err?.type === "entity.parse.failed") {
      res.status(400).json({ error: "Invalid JSON" });
    } else {
      logProviderError("request", err);
      res.status(502).json({ error: "Something went wrong. Please try again." });
    }
  };
  app.use(onError);
  return app;
}
