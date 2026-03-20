# Voice Integration — Patterns by Project Type

## Core Philosophy

Voice is not a feature you bolt on. It's a communication channel — like HTTP.
The service layer doesn't know or care whether a command came from a button click,
an API call, or a spoken sentence. That's the goal.

```
                    ┌─────────────────────────────┐
  Text input   ───► │                             │
  Voice input  ───► │  Intent / Command Layer     │ ──► Service Layer ──► DB
  API call     ───► │                             │
                    └─────────────────────────────┘
```

One service layer. Multiple input adapters.

---

## Technology Stack (Open-Source First)

### Speech-to-Text (STT)
| Option | Type | Best For | Notes |
|--------|------|----------|-------|
| **OpenAI Whisper** | OSS (MIT) | Server-side, all languages | Best accuracy, runs locally |
| **Vosk** | OSS (Apache) | Offline, edge, mobile | Smaller models, fast |
| **Web Speech API** | Browser native | Web apps, no backend needed | Chrome/Edge, not Safari |
| **Whisper.cpp** | OSS (MIT) | Embedded / mobile | C++ port, very fast |

Default: **Whisper (OSS)** on the server, **Web Speech API** as browser fallback.

### Text-to-Speech (TTS)
| Option | Type | Best For | Notes |
|--------|------|----------|-------|
| **Coqui TTS** | OSS (MPL) | Server-side, natural voices | Best OSS quality |
| **espeak-ng** | OSS (GPL) | Lightweight, offline | Robotic but works anywhere |
| **Web Speech API** | Browser native | Web apps | Free, decent quality |
| **ElevenLabs** | Proprietary | Premium voice quality | API cost, not self-hostable |

Default: **Coqui TTS** server-side, **Web SpeechSynthesis** in browser.

---

## Implementation by Project Type

### Web App (React / Next.js)

```typescript
// hooks/useVoice.ts — unified voice hook
import { useState, useCallback, useRef } from 'react';

export function useVoice() {
  const [transcript, setTranscript] = useState('');
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognition | null>(null);

  const startListening = useCallback(() => {
    // Use Web Speech API (browser-native, no API key needed)
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      // Fallback: send audio blob to server Whisper endpoint
      return startServerSideSTT();
    }
    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = navigator.language || 'en-US'; // respect user locale

    recognition.onresult = (event) => {
      const text = Array.from(event.results)
        .map(r => r[0].transcript).join('');
      setTranscript(text);
    };
    recognition.onend = () => setIsListening(false);
    recognition.start();
    recognitionRef.current = recognition;
    setIsListening(true);
  }, []);

  const speak = useCallback((text: string) => {
    // Use browser TTS — fallback to server Coqui if more natural voice needed
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = navigator.language || 'en-US';
    window.speechSynthesis.speak(utterance);
  }, []);

  return { transcript, isListening, startListening, speak };
}
```

```typescript
// Every input component gets a voice button — same handler as text submit
function SearchBar({ onSearch }: { onSearch: (query: string) => void }) {
  const [query, setQuery] = useState('');
  const { transcript, isListening, startListening, speak } = useVoice();

  // Voice transcript feeds the same handler as typed input
  useEffect(() => {
    if (transcript) setQuery(transcript);
  }, [transcript]);

  return (
    <div>
      <input value={query} onChange={e => setQuery(e.target.value)} />
      <button onClick={() => onSearch(query)}>Search</button>
      <button onClick={startListening} aria-label="Voice search">
        {isListening ? '🔴' : '🎤'}
      </button>
    </div>
  );
}
```

### Mobile App (React Native / Expo)

```typescript
// Use expo-speech for TTS and @react-native-voice/voice for STT
import * as Speech from 'expo-speech';
import Voice from '@react-native-voice/voice';

export const voiceService = {
  async startListening(onResult: (text: string) => void) {
    Voice.onSpeechResults = (e) => {
      const text = e.value?.[0] ?? '';
      onResult(text); // feeds same handler as typed input
    };
    await Voice.start(Localization.locale);
  },

  speak(text: string) {
    Speech.speak(text, {
      language: Localization.locale,
      pitch: 1.0,
      rate: 0.9,
    });
  },

  async stop() {
    await Voice.stop();
  }
};
```

### API / Backend (Voice Endpoint)

```typescript
// POST /voice/transcribe — converts audio to text
// POST /voice/speak — converts text to audio
// These are I/O adapters. They call the same service layer as REST endpoints.

import { Router } from 'express';
import multer from 'multer';
import { transcribeAudio, synthesizeSpeech } from '../infra/voice';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

// Transcribe: audio → text → run through normal service layer
router.post('/voice/transcribe', upload.single('audio'), async (req, res) => {
  const text = await transcribeAudio(req.file!.buffer); // Whisper
  // Now handle text exactly like a normal API request
  const result = await processCommand(text, req.user);
  res.json({ transcript: text, result });
});

// Speak: text → audio file
router.post('/voice/speak', async (req, res) => {
  const { text, voice = 'default' } = req.body;
  const audioBuffer = await synthesizeSpeech(text, voice); // Coqui TTS
  res.set('Content-Type', 'audio/wav');
  res.send(audioBuffer);
});
```

```typescript
// infra/voice/whisper.ts — OSS Whisper wrapper
import { spawn } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

export async function transcribeAudio(audioBuffer: Buffer): Promise<string> {
  const tmpFile = path.join(tmpdir(), `audio-${Date.now()}.wav`);
  writeFileSync(tmpFile, audioBuffer);
  return new Promise((resolve, reject) => {
    // whisper.cpp or Python whisper — configured via DB config, not hardcoded
    const whisperPath = process.env.WHISPER_BINARY_PATH!;
    const proc = spawn(whisperPath, ['--output-txt', '--file', tmpFile]);
    let output = '';
    proc.stdout.on('data', d => output += d);
    proc.on('close', () => {
      unlinkSync(tmpFile);
      resolve(output.trim());
    });
    proc.on('error', reject);
  });
}
```

### Data Dashboard (Voice Query Interface)

```typescript
// Voice queries for dashboards: "show me revenue for last month"
// Route through an intent parser → same query builder as UI clicks

async function handleVoiceDashboardQuery(transcript: string, userId: string) {
  // Step 1: Parse intent from natural language
  const intent = await parseQueryIntent(transcript);
  // Returns: { metric: 'revenue', period: 'last_month', groupBy: 'day' }

  // Step 2: Execute via same query service as UI
  const data = await metricsService.query(intent, userId);

  // Step 3: Generate spoken summary
  const summary = await summarizeForVoice(data);
  // "Last month's revenue was ₹4.2 lakh, up 12% from the month before."

  return { data, spokenSummary: summary };
}
```

---

## Voice Config in Database

Voice settings must be database-driven:

```sql
CREATE TABLE voice_config (
  key        VARCHAR(255) PRIMARY KEY,
  value      TEXT NOT NULL,
  value_type VARCHAR(50) DEFAULT 'string'
);

INSERT INTO voice_config VALUES
  ('stt_provider', 'whisper', 'string'),        -- whisper | google | azure
  ('tts_provider', 'coqui', 'string'),           -- coqui | elevenlabs | browser
  ('default_language', 'en-IN', 'string'),       -- BCP-47 locale
  ('voice_name', 'default', 'string'),           -- TTS voice model
  ('max_recording_seconds', '30', 'number'),
  ('voice_enabled', 'true', 'boolean');
```

Switching from Coqui to ElevenLabs = one DB row update. No code change.

---

## Accessibility Notes

- Always provide text fallback for every voice interaction
- Show transcript of what was heard (builds trust, allows correction)
- Show visual indicator when listening (🔴 pulsing dot)
- Support `aria-label` on all voice buttons
- Never autostart voice without explicit user action
