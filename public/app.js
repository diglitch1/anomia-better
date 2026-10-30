const $ = (id) => document.getElementById(id);

const STRINGS = {
  en: {
    settings: "Settings", speak: "Tap and speak", stop: "Tap to stop", orType: "Or type what you can",
    addPhoto: "Add photo", changePhoto: "Change photo", removePhoto: "Remove", find: "Find my sentence",
    whichOne: "Is it one of these?", none: "None of these", language: "Language",
    aboutMe: "About me (names, places, routines)", myVoice: "My voice", voiceName: "Name",
    samples: "Recordings of my voice (1 to 5 files, 30 MB in total)",
    consent: "This is my voice, or I am legally allowed to decide for this person, and I agree to it being cloned by ElevenLabs.",
    cloneVoice: "Create my voice", clear: "Delete my data from this device", close: "Close",
    working: "Finding sentences...", listening: "Listening...", needInput: "Say, type or photograph something first.",
    noSpeech: "I didn't catch that. Please try again.", noneDone: "Nothing was said. Try again whenever you are ready.",
    noMic: "Recording needs HTTPS. You can still type.", micBlocked: "Microphone is blocked. You can still type.",
    speaking: "Speaking...", fallback: "Using the device voice.", failed: "Could not speak. Please try again.",
    voiceDefault: "Using the standard voice.", voiceOwn: "Using your own voice.", cloning: "Creating your voice...",
    cloned: "Your voice is ready.", needClone: "Add a name, recordings and your consent.",
    confirmClear: "Delete your profile, choices and voice link from this device?", cleared: "Deleted.",
  },
  de: {
    settings: "Einstellungen", speak: "Tippen und sprechen", stop: "Tippen zum Stoppen", orType: "Oder tippe, was du kannst",
    addPhoto: "Foto hinzufügen", changePhoto: "Foto ändern", removePhoto: "Entfernen", find: "Meinen Satz finden",
    whichOne: "Ist es einer davon?", none: "Keiner davon", language: "Sprache",
    aboutMe: "Über mich (Namen, Orte, Gewohnheiten)", myVoice: "Meine Stimme", voiceName: "Name",
    samples: "Aufnahmen meiner Stimme (1 bis 5 Dateien, insgesamt 30 MB)",
    consent: "Das ist meine Stimme, oder ich darf rechtlich für diese Person entscheiden, und ich stimme dem Klonen durch ElevenLabs zu.",
    cloneVoice: "Meine Stimme erstellen", clear: "Meine Daten von diesem Gerät löschen", close: "Schließen",
    working: "Sätze werden gesucht...", listening: "Ich höre zu...", needInput: "Sag, tippe oder fotografiere zuerst etwas.",
    noSpeech: "Das habe ich nicht verstanden. Bitte versuch es noch einmal.", noneDone: "Es wurde nichts gesagt. Versuch es wieder, wenn du bereit bist.",
    noMic: "Aufnahme braucht HTTPS. Du kannst weiter tippen.", micBlocked: "Mikrofon ist blockiert. Du kannst weiter tippen.",
    speaking: "Wird gesprochen...", fallback: "Gerätestimme wird verwendet.", failed: "Sprechen fehlgeschlagen. Bitte noch einmal versuchen.",
    voiceDefault: "Standardstimme wird verwendet.", voiceOwn: "Deine eigene Stimme wird verwendet.", cloning: "Stimme wird erstellt...",
    cloned: "Deine Stimme ist bereit.", needClone: "Gib Name, Aufnahmen und Zustimmung an.",
    confirmClear: "Profil, Auswahl und Stimm-Verknüpfung von diesem Gerät löschen?", cleared: "Gelöscht.",
  },
};

// localStorage can throw in private windows, so the app also works without it.
const store = {
  get(key, fallback) {
    try {
      const value = localStorage.getItem(`anomia.${key}`);
      return value === null ? fallback : JSON.parse(value);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`anomia.${key}`, JSON.stringify(value));
    } catch {}
  },
  clear() {
    try {
      for (const key of Object.keys(localStorage)) if (key.startsWith("anomia.")) localStorage.removeItem(key);
    } catch {}
  },
};

const state = {
  language: store.get("language", navigator.language?.startsWith("de") ? "de" : "en"),
  profile: store.get("profile", ""),
  voiceId: store.get("voiceId", "default"),
  history: store.get("history", []),
  fragments: "",
  audio: null,
  image: null,
  recorder: null,
  busy: false,
};

const t = (key) => STRINGS[state.language][key];

function setStatus(key, isError = false) {
  $("status").textContent = key ? t(key) : "";
  $("status").classList.toggle("error", isError);
}

function setStatusText(text) {
  $("status").textContent = text;
  $("status").classList.add("error");
}

function setVoiceStatus(key, isError = false) {
  $("voice-status").textContent = key ? t(key) : "";
  $("voice-status").classList.toggle("error", isError);
}

function render() {
  document.documentElement.lang = state.language;
  for (const el of document.querySelectorAll("[data-t]")) el.textContent = t(el.dataset.t);
  $("record-label").textContent = t(state.recorder ? "stop" : "speak");
  $("photo-label").textContent = t(state.image ? "changePhoto" : "addPhoto");
  $("voice-state").textContent = t(state.voiceId === "default" ? "voiceDefault" : "voiceOwn");
  $("language").value = state.language;
  $("profile").value = state.profile;
}

function setBusy(busy) {
  state.busy = busy;
  for (const id of ["find", "record", "none"]) $(id).disabled = busy;
  for (const card of document.querySelectorAll(".card")) card.disabled = busy;
}

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    setStatus("noMic", true);
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    setStatus("micBlocked", true);
    return;
  }
  const mimeType = ["audio/webm;codecs=opus", "audio/mp4"].find((m) => MediaRecorder.isTypeSupported(m));
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
  const parts = [];
  recorder.ondataavailable = (event) => parts.push(event.data);
  recorder.onstop = () => {
    stream.getTracks().forEach((track) => track.stop());
    clearTimeout(recorder.limit);
    state.recorder = null;
    state.audio = new Blob(parts, { type: (recorder.mimeType || "audio/webm").split(";")[0] });
    $("record").classList.remove("recording");
    $("record").setAttribute("aria-pressed", "false");
    render();
    findSentences();
  };
  recorder.limit = setTimeout(() => recorder.stop(), 20_000);
  recorder.start();
  state.recorder = recorder;
  $("record").classList.add("recording");
  $("record").setAttribute("aria-pressed", "true");
  render();
  setStatus("listening");
}

// Photos are shrunk on the device so uploads and the model stay fast.
async function shrinkImage(file) {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.8));
    return blob ?? file;
  } catch {
    return file;
  }
}

function removePhoto() {
  if ($("preview").src) URL.revokeObjectURL($("preview").src);
  state.image = null;
  $("photo").value = "";
  $("preview").hidden = true;
  $("preview").removeAttribute("src");
  $("remove-photo").hidden = true;
  render();
}

async function choosePhoto(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  if ($("preview").src) URL.revokeObjectURL($("preview").src);
  state.image = await shrinkImage(file);
  $("preview").src = URL.createObjectURL(state.image);
  $("preview").hidden = false;
  $("remove-photo").hidden = false;
  render();
}

async function findSentences() {
  if (state.busy) return;
  const text = $("text").value.trim();
  if (!text && !state.audio && !state.image) {
    setStatus("needInput", true);
    return;
  }
  const form = new FormData();
  form.set("language", state.language);
  form.set("profile", state.profile);
  form.set("history", JSON.stringify(state.history.slice(-8)));
  if (text) form.set("text", text);
  if (state.audio) form.set("audio", state.audio, "speech");
  if (state.image) form.set("image", state.image, "photo.jpg");

  state.audio = null;
  $("results").hidden = true;
  setBusy(true);
  setStatus("working");
  try {
    const response = await fetch("/api/suggest", { method: "POST", body: form });
    const body = await response.json().catch(() => ({}));
    if (body.error === "no_speech") {
      setStatus("noSpeech", true);
    } else if (!response.ok) {
      setStatusText(body.error || t("failed"));
    } else {
      state.fragments = body.fragments;
      showCards(body.sentences);
      setStatus("");
    }
  } catch {
    setStatus("failed", true);
  } finally {
    setBusy(false);
  }
}

function showCards(sentences) {
  $("cards").replaceChildren(
    ...sentences.map((sentence) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "card";
      card.textContent = sentence;
      card.addEventListener("click", () => confirmSentence(sentence));
      return card;
    }),
  );
  $("results").hidden = false;
  $("results").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function speakWithDevice(sentence) {
  if (!window.speechSynthesis) return false;
  const utterance = new SpeechSynthesisUtterance(sentence);
  utterance.lang = state.language === "de" ? "de-DE" : "en-GB";
  speechSynthesis.speak(utterance);
  return true;
}

// Nothing plays until the person taps a sentence: the tap is the confirmation.
async function confirmSentence(sentence) {
  const player = new Audio();
  setBusy(true);
  setStatus("speaking");
  try {
    const response = await fetch("/api/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: sentence, voiceId: state.voiceId }),
    });
    if (!response.ok) throw new Error("speak failed");
    player.src = URL.createObjectURL(await response.blob());
    await player.play();
    setStatus("");
  } catch {
    setStatus(speakWithDevice(sentence) ? "fallback" : "failed", true);
  } finally {
    setBusy(false);
  }
  if (state.fragments) {
    state.history = [...state.history, { fragments: state.fragments, sentence }].slice(-30);
    store.set("history", state.history);
  }
  $("text").value = "";
  removePhoto();
}

async function cloneVoice() {
  const files = [...$("samples").files];
  const name = $("voice-name").value.trim();
  if (!name || !files.length || !$("consent").checked) {
    setVoiceStatus("needClone", true);
    return;
  }
  const form = new FormData();
  form.set("name", name);
  form.set("consent", "true");
  for (const file of files) form.append("samples", file);
  $("clone").disabled = true;
  setVoiceStatus("cloning");
  try {
    const response = await fetch("/api/voice/clone", { method: "POST", body: form });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      $("voice-status").textContent = body.error || t("failed");
      $("voice-status").classList.add("error");
      return;
    }
    state.voiceId = body.voiceId;
    store.set("voiceId", state.voiceId);
    $("samples").value = "";
    $("consent").checked = false;
    render();
    setVoiceStatus("cloned");
  } catch {
    setVoiceStatus("failed", true);
  } finally {
    $("clone").disabled = false;
  }
}

$("record").addEventListener("click", () => (state.recorder ? state.recorder.stop() : startRecording()));
$("find").addEventListener("click", findSentences);
$("text").addEventListener("keydown", (event) => event.key === "Enter" && findSentences());
$("photo").addEventListener("change", choosePhoto);
$("remove-photo").addEventListener("click", removePhoto);
$("none").addEventListener("click", () => {
  $("results").hidden = true;
  $("cards").replaceChildren();
  setStatus("noneDone");
});
$("open-settings").addEventListener("click", () => $("settings").showModal());
$("clone").addEventListener("click", cloneVoice);
$("language").addEventListener("change", (event) => {
  state.language = event.target.value;
  store.set("language", state.language);
  render();
});
$("profile").addEventListener("input", (event) => {
  state.profile = event.target.value;
  store.set("profile", state.profile);
});
$("clear").addEventListener("click", () => {
  if (!confirm(t("confirmClear"))) return;
  store.clear();
  Object.assign(state, { profile: "", voiceId: "default", history: [] });
  render();
  setVoiceStatus("cleared");
});

render();
