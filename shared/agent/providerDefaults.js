// Saved user selections always override these bootstrap defaults.
export const PROVIDER_DEFAULTS = Object.freeze({
  "chat": {
    "local": "llama3.1",
    "api-key": "gpt-4.1-mini",
    "codex": "gpt-6.1-sol"
  },
  "catalogs": {
    "local": [
      "llama3.1"
    ],
    "api-key": [
      "gpt-6.1-sol",
      "gpt-6-astra",
      "gpt-6-luna",
      "gpt-4.1",
      "gpt-4.1-mini"
    ],
    "codex": [
      "gpt-6.1-sol",
      "gpt-6-astra",
      "gpt-6-luna"
    ]
  },
  "auxiliary": {
    "verifier": "gpt-4o-mini"
  },
  "media": {
    "image": "gpt-image-2.5-sunburst",
    "legacyPhoneImage": "gpt-image-2",
    "transcription": "whisper-1",
    "offlineCompact": "qwen2.5:3b",
    "tts": "tts-1",
    "minimaxTts": "speech-01-turbo"
  },
  "labels": {
    "gpt-6.1-sol": "Sol 6.1",
    "gpt-6-astra": "Astra 6",
    "gpt-6-luna": "Luna 6"
  },
  "legacyCodexCatalogs": [
    [
      "gpt-5.5",
      "gpt-5.4",
      "gpt-4.1"
    ],
    [
      "gpt-5.4",
      "gpt-4.1",
      "gpt-4.1-mini"
    ],
    [
      "gpt-5.5",
      "gpt-4.1",
      "gpt-4.1-mini"
    ]
  ]
});
