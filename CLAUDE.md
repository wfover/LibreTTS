# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

LibreTTS is a static browser app for text-to-speech with serverless API backends. There is no package manifest, bundler, or compile step in the repository; the root HTML/CSS/JS files are deployed directly.

The app supports two deployment targets:

- Vercel: Node-style serverless handlers in `api/`, with rewrites in `vercel.json`.
- Cloudflare Pages: Workers-style Pages Functions in `functions/`.

Keep equivalent endpoint behavior synchronized between those two trees when changing shared API behavior.

## Common commands

```bash
# Serve the static frontend locally from the repository root
python -m http.server 8000

# Run Vercel-style serverless functions locally
npx vercel dev

# Run Cloudflare Pages Functions locally
npx wrangler pages dev .

# Smoke-test the voices API
curl "http://localhost:3000/api/voices?l=zh&f=1"

# Smoke-test the OpenAI-compatible speech API
curl -X POST "http://localhost:3000/v1/audio/speech" \
  -H "Content-Type: application/json" \
  -d '{"model":"tts-1","input":"测试语音","voice":"zh-CN-XiaoxiaoNeural","speed":1.0,"response_format":"mp3"}' \
  -o test.mp3
```

There are currently no configured `npm install`, build, lint, or test scripts. Android APK creation is defined only as a manually triggered GitHub Actions workflow in `.github/workflows/build-apk.yml`; it creates a Cordova app, copies the static frontend into `www/`, excludes backend function folders, and builds a debug APK.

## Runtime configuration

Environment variables used by the deployed backends:

- `PASSWORD`: optional access password checked by `/api/check-password` and `/api/verify-password`.
- `AZURE_TTS_KEY`: optional Azure Speech key for Azure TTS fallback/proxy behavior.
- `AZURE_TTS_REGION`: optional Azure Speech region, defaulting to `eastus` where implemented.

## High-level architecture

- `index.html` contains the static UI, password modal, API manager modal, backend URL modal for app/Cordova use, and script/style includes.
- `script.js` is the browser application controller. It loads built-in speakers from `speakers.json`, stores custom API definitions in `localStorage`, persists the latest audio in IndexedDB, handles long-text splitting and queued playback, and sends requests to Edge/OpenAI/Azure-style endpoints.
- `style.css` contains all app styling; Bootstrap, Font Awesome, jQuery, Popper, and Bootstrap JS are loaded from CDNs in `index.html`.
- `speakers.json` provides the built-in speaker lists keyed by API name for the UI.
- `api/` contains Vercel handlers:
  - `api/tts.js`: Edge/Microsoft Translator-derived TTS endpoint at `/api/tts`.
  - `api/voices.js`: Microsoft voice list proxy at `/api/voices`.
  - `api/v1/audio/speech.js`: OpenAI-compatible `/v1/audio/speech` wrapper over Edge TTS.
  - `api/check-password.js` and `api/verify-password.js`: password-gating helpers.
- `functions/` contains Cloudflare Pages equivalents using `export async function onRequest(context)`. Cloudflare has an additional `functions/api/azure-tts.js` proxy and its `/v1/audio/speech` implementation includes long-text chunking plus Edge-to-Azure fallback.

## Important implementation notes

- The frontend defaults to `edge-api` and can fall back to `azure-tts-1` when Edge requests fail; the Cloudflare `/v1/audio/speech` endpoint also performs server-side Edge-to-Azure fallback if Azure env vars are present.
- Cordova/file-protocol usage requires users to set `backend_base_url` via the UI because `/api/...` is not served from the packaged app.
- Text cleanup and SSML generation logic is duplicated across frontend and backend files. When changing markdown stripping, URL removal, SSML escaping, voice/rate/pitch handling, or output format mapping, check both Vercel and Cloudflare implementations.
- Vercel routing is explicit in `vercel.json`; adding a new Vercel endpoint may also require adding a rewrite there. Cloudflare Pages maps files under `functions/` by path.
