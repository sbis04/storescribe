# StoreScribe

App Store and Google Play listings that fit every limit, use the words your category searches with, and read like a person wrote them. In English and up to five more languages. Written by **Gemma 4**, an open-weight model.

- **Web app:** describe your app, add screenshots, get both listings with live character counters, versions, fastlane export and a rank tracker.
- **CLI:** run `npx github:sbis04/storescribe` inside your app's repo. It reads the project (name, bundle ids, README, screens in the code, current fastlane listing, screenshots) and writes `fastlane/metadata` for you. Add `--local` to run Gemma on your own machine with Ollama, so nothing leaves your laptop.

## How it works

1. **Brief:** from the form, or from your repo (CLI).
2. **Research:** top App Store and Google Play results for your search terms via SerpApi, and the words they share.
3. **Draft:** Gemma 4 writes each field for each store.
4. **Enforce:** code checks every limit (Apple's keywords field is 100 *bytes*), store policy words and keyword stuffing, asks the model to tighten anything over, and packs the keywords field without repeating words from the name or subtitle.
5. **Localize:** each language gets its own keywords, not translated English ones.
6. **Keep:** every version, usage and daily keyword ranks are stored in Tiger Data (TimescaleDB hypertables plus a continuous aggregate for the usage meter).

## Run it

```sh
npm install
cp .env.example .env   # DATABASE_URL, model settings, optional SERPAPI_KEY
npm run dev            # http://localhost:8090
```

Model settings:

| | `MODEL_API` | `MODEL_URL` | `MODEL_NAME` |
|---|---|---|---|
| Local (Ollama) | `ollama` | `http://localhost:11434` | `gemma4:latest` |
| DigitalOcean serverless inference | `openai` | `https://inference.do-ai.run/v1` | `gemma-4-31B-it` (+ `MODEL_KEY`) |

CLI:

```sh
cd path/to/your-app
npx github:sbis04/storescribe --langs ja-JP,de-DE          # hosted
npx github:sbis04/storescribe --local --dry-run            # Gemma on this machine, print only
```

## License

MIT
