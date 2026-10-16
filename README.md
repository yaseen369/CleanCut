# CleanCut: AI Video Profanity Censor

CleanCut is a web app that finds swear words in a video and mutes or bleeps them. You upload a video, the server transcribes it with OpenAI Whisper, and the app marks every detected word with its exact timestamps. You can then preview the censored version and export it.

Built during software development training at the Near East University IT Center (July–August 2026).

## Features

- Upload a video and get a full transcript from Whisper (`openai/whisper-large-v3` via the Hugging Face Inference API)
- Detect profanity with word-level start and end times, including multi-word phrases and disguised spellings that swap letters for symbols
- Preview the original or the censored video, with each word muted or replaced by a beep
- Export the censored video as a WebM file
- Keep the API key on the server, never in browser code

## Tech stack

| Part | Technology |
| --- | --- |
| Frontend | HTML, CSS, JavaScript, Web Audio API, Canvas API, MediaRecorder API |
| Backend | Node.js, Express, Multer |
| Audio | ffmpeg (`ffmpeg-static`) |
| Speech-to-text | Hugging Face Inference API, Whisper large-v3 |

## How it works

1. The browser keeps the video for preview and sends a copy to `POST /api/transcribe`.
2. The server extracts the audio with ffmpeg, splits it into chunks and sends each chunk to Whisper for timestamped transcription.
3. The transcript is checked against a profanity list. The server returns the transcript and every match with its start and end seconds.
4. During playback the browser checks the current time against those ranges and mutes the audio or plays a generated beep.
5. Export records the edited playback in real time and saves it as WebM.

## Project structure

```
frontend/   index.html, styles.css, app.js   (browser UI and playback logic)
backend/    server.js                         (Express server, ffmpeg, Whisper calls, matching)
tests/      matcher.test.js                   (profanity matcher tests)
```

## Run it locally

Requirements: Node.js 18+ and a Hugging Face access token.

```bash
npm install
cp .env.example .env      # then put your token in .env
npm start                 # opens http://localhost:3000
```

`.env` settings:

```env
HUGGINGFACE_API_KEY=hf_your_hugging_face_token_here
HUGGINGFACE_MODEL=openai/whisper-large-v3
PORT=3000
```

## Tests

```bash
npm run test:matcher      # profanity matcher: phrases and disguised spellings
npm run check             # syntax check for server and frontend code
```

## Author

Yaseen Abdelrhman · [GitHub](https://github.com/yaseen369) · [LinkedIn](https://www.linkedin.com/in/yaseen-abdelrhman-905aaa253)
