import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import ffmpegStatic from "ffmpeg-static";
import express, { type Request, type Response, type Router } from "express";
import multer from "multer";
import { HttpError, logProviderError } from "./errors.ts";
import { LruCache } from "./lru.ts";

export const MAX_TEXT_LENGTH = 300;
const MAX_CLONE_BYTES = 30 * 1024 * 1024;
const VOICE_ID = /^[A-Za-z0-9]{10,40}$/;

export interface Sample {
  data: Buffer;
  filename: string;
  mime: string;
}

export interface VoiceProvider {
  speak(text: string, voiceId: string): Promise<AsyncIterable<Uint8Array>>;
  transcribe(audio: Buffer, mime: string, language?: string): Promise<string>;
  clone(name: string, samples: Sample[]): Promise<string>;
}

let client: ElevenLabsClient | undefined;

function elevenLabs(): ElevenLabsClient {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new HttpError(503, "ELEVENLABS_API_KEY is not set on the server");
  client ??= new ElevenLabsClient({ apiKey });
  return client;
}

function extensionFor(mime: string): string {
  if (mime.includes("mp4")) return "mp4";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("wav")) return "wav";
  if (mime.includes("mpeg")) return "mp3";
  return "webm";
}

export const elevenLabsProvider: VoiceProvider = {
  async speak(text, voiceId) {
    return elevenLabs().textToSpeech.stream(voiceId, {
      text,
      modelId: process.env.ELEVENLABS_TTS_MODEL || "eleven_flash_v2_5",
      outputFormat: "mp3_44100_128",
    });
  },

  async transcribe(audio, mime, language) {
    const result = await elevenLabs().speechToText.convert({
      modelId: process.env.ELEVENLABS_STT_MODEL || "scribe_v2",
      file: { data: audio, filename: `audio.${extensionFor(mime)}`, contentType: mime },
      tagAudioEvents: false,
      ...(language ? { languageCode: language } : {}),
    });
    const { text, transcripts } = result as { text?: string; transcripts?: { text: string }[] };
    if (transcripts) return transcripts.map((t) => t.text).join(" ").trim();
    if (typeof text === "string") return text.trim();
    throw new Error("Unexpected transcription response");
  },

  async clone(name, samples) {
    const result = await elevenLabs().voices.ivc.create({
      name: `Anomia - ${name}`,
      description: "created with consent via Anomia",
      files: samples.map((s) => ({ data: s.data, filename: s.filename, contentType: s.mime })),
    });
    return result.voiceId;
  },
};

function runFfmpeg(input: string, output: string): Promise<void> {
  const binary = (ffmpegStatic as unknown as string | null) ?? "ffmpeg";
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(binary, ["-y", "-i", input, "-vn", "-ac", "1", "-b:a", "128k", output], {
      stdio: "ignore",
    });
    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code) => (code === 0 ? resolve() : reject(new HttpError(400, "Could not read audio from that video"))));
  });
}

// mp4 cannot be read reliably from a pipe, so ffmpeg gets a private temp folder.
export async function extractAudio(video: Buffer): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "anomia-"));
  try {
    const input = join(dir, "input");
    const output = join(dir, "output.mp3");
    await writeFile(input, video);
    await runFfmpeg(input, output);
    return await readFile(output);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function fail(res: Response, err: unknown, where: string): void {
  if (err instanceof HttpError) {
    if (!res.headersSent) res.status(err.status).json({ error: err.message });
    return;
  }
  logProviderError(where, err);
  if (res.headersSent) res.destroy();
  else res.status(502).json({ error: "The voice service failed. Please try again." });
}

export function validateSpeak(body: unknown): { text: string; voiceId: string } {
  const { text, voiceId } = (body ?? {}) as { text?: unknown; voiceId?: unknown };
  if (typeof text !== "string" || !text.trim()) throw new HttpError(400, "text is required");
  const trimmed = text.trim();
  if (trimmed.length > MAX_TEXT_LENGTH) throw new HttpError(400, `text must be at most ${MAX_TEXT_LENGTH} characters`);
  if (typeof voiceId !== "string") throw new HttpError(400, "voiceId is required");
  if (voiceId !== "default" && !VOICE_ID.test(voiceId)) throw new HttpError(400, "voiceId is invalid");
  return { text: trimmed, voiceId };
}

function resolveVoiceId(voiceId: string): string {
  if (voiceId !== "default") return voiceId;
  const fallback = process.env.DEFAULT_VOICE_ID;
  if (!fallback) throw new HttpError(503, "DEFAULT_VOICE_ID is not set on the server");
  return fallback;
}

export function createVoiceRouter(provider: VoiceProvider = elevenLabsProvider): Router {
  const router = express.Router();
  const cache = new LruCache<Buffer>(50, 10 * 60 * 1000);
  const uploads = multer({
    storage: multer.memoryStorage(),
    limits: { files: 5, fileSize: MAX_CLONE_BYTES },
  });

  // Audio only exists here, for a sentence the user already confirmed on the device.
  router.post("/speak", express.json({ limit: "16kb" }), async (req: Request, res: Response) => {
    try {
      const { text, voiceId } = validateSpeak(req.body);
      const resolved = resolveVoiceId(voiceId);
      const key = JSON.stringify([text, resolved]);
      const cached = cache.get(key);
      if (cached) {
        res.type("audio/mpeg").send(cached);
        return;
      }
      const stream = await provider.speak(text, resolved);
      res.type("audio/mpeg");
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream) {
        if (res.destroyed) return;
        chunks.push(chunk);
        res.write(chunk);
      }
      cache.set(key, Buffer.concat(chunks));
      res.end();
    } catch (err) {
      fail(res, err, "speak");
    }
  });

  router.post("/voice/clone", uploads.array("samples", 5), async (req: Request, res: Response) => {
    try {
      if (req.body?.consent !== "true") throw new HttpError(400, "Consent is required to clone a voice");
      const name = typeof req.body.name === "string" ? req.body.name.trim().slice(0, 60) : "";
      if (!name) throw new HttpError(400, "name is required");
      const files = (req.files ?? []) as Express.Multer.File[];
      if (!files.length) throw new HttpError(400, "Add at least one audio or video sample");
      if (files.reduce((sum, f) => sum + f.size, 0) > MAX_CLONE_BYTES) throw new HttpError(400, "Samples must be at most 30 MB in total");
      if (files.some((f) => !/^(audio|video)\//.test(f.mimetype))) throw new HttpError(400, "Samples must be audio or video files");

      const samples: Sample[] = [];
      for (const [i, f] of files.entries()) {
        samples.push(
          f.mimetype.startsWith("video/")
            ? { data: await extractAudio(f.buffer), filename: `sample-${i}.mp3`, mime: "audio/mpeg" }
            : { data: f.buffer, filename: `sample-${i}.${extensionFor(f.mimetype)}`, mime: f.mimetype },
        );
      }
      res.json({ voiceId: await provider.clone(name, samples) });
    } catch (err) {
      fail(res, err, "voice clone");
    }
  });

  return router;
}
