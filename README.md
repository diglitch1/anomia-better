# Anomia

Anomia helps people with aphasia say what they mean, in their own voice.

Someone with aphasia knows what they want to say, but the words won't come. They speak or type the fragments they can, optionally add a photo of the scene, and Gemma 4 proposes three sentences. They tap the right one, and ElevenLabs says it aloud in their cloned voice.

Anomia never speaks on its own. Tapping a sentence is the confirmation, and "None of these" says nothing.

Anomia is a hackathon prototype, not a medical device.

## Run it

Needs Node 20 or newer, an ElevenLabs key and a Gemini API key from Google AI Studio.

```sh
npm install
cp .env.example .env   # add ELEVENLABS_API_KEY, DEFAULT_VOICE_ID and GEMINI_API_KEY
npm start
```

To keep photos and fragments on your own computer, install [Ollama](https://ollama.com), run `ollama pull gemma4:e2b` and set `LLM_PROVIDER=ollama`. This needs a fast machine.

Open http://127.0.0.1:3000. Browsers only allow the microphone on localhost or HTTPS, so a phone needs an HTTPS address. Typing and photos work either way.

## Privacy

| Data | Where it goes |
|---|---|
| Profile and past choices | Stored on the device, and sent to the sentence model with each request |
| Photo and fragments | The sentence model: Google by default, your computer with Ollama, or Lovable's gateway |
| Voice recordings | ElevenLabs, for speech-to-text. Type instead to avoid this |
| Confirmed sentence | ElevenLabs, to speak it |
| Voice samples | ElevenLabs, to create the clone |

The server has no database and does not log audio, transcripts, sentences or names. Spoken audio is cached in memory for up to 10 minutes so repeats are fast.

Cloning needs explicit consent. A cloned voice stays in the ElevenLabs account until it is deleted there.

## Development

```sh
npm test
npm run typecheck
```

Licensed under MIT.
