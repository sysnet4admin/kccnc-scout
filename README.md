# kccnc-scout

Ask, in any language, which KubeCon + CloudNativeCon North America 2026 talk to go to, and get an answer based on what is on the speakers' slides.

**Try it on a phone: https://kccnc-scout.cnh.radarhq.io**

Titles and abstracts often don't tell you whether a talk is what you want. kccnc-scout reads the uploaded slide decks page by page, so it can tell a talk that walks through a real migration with measured results from one that stays at slogans, or a beginner talk with simple drawings from one full of code. It answers with the talks that are on now or starting soon, then later ones, and lists talks that are already over as "slides now, recording later". Every pick links to the slide pages it is based on, and shows how long the walk is from where you are and whether you would arrive late.

Built for the [Cloud Native Hackathon](https://www.wemakedevs.org/hackathons/cnh) on November 9, 2026, in Salt Lake City.

## How it works

```
phone UI (/)
  └─ GET /api/answer?q=...&at=...&zone=...   server-sent events
       1. rewrite a non-English question as an English query   Claude Opus via an Elasticsearch inference endpoint
       2. hybrid search, sessions and slide pages in parallel  BM25 + semantic_text (Jina, multilingual), RRF
       3. fuse both lists by rank; group by time; add walks    code, relative to "at" and "zone"
       4. stream "results", then the written answer            Claude Opus via an Elasticsearch inference endpoint
```

- **Elasticsearch holds all talk data.** Two indices: `kccnc-scout-sessions` (600 schedule entries with speakers, rooms, tracks, and a summary of each deck) and `kccnc-scout-pages` (3,211 slide pages from 113 decks). Each page document carries the session's time and room, so page search filters by time without a join. English analysis with search-time synonyms (`k8s`/`kubernetes`, `otel`/`opentelemetry` and more), and `semantic_text` on `.jina-embeddings-v5-text-small` for questions in any language.
- **Time is code, not LLM output.** The schedule has no time zone offset; the loader stores every time with `-07:00` (MST), and the API compares instants. "On now", "starting within 30 minutes", "later" and "over" are decided before the model sees anything. The model only words the answer from the talks it is given and cites slide pages.
- **The phone shows results first.** Cards appear as soon as search finishes (about 0.3 s for an English question, 1.5 s with a rewrite); the answer streams in on top.
- **Walking times.** Pick one of seven zones (keynote hall, expo halls, Grand Ballroom, two Level 2 areas, two Hyatt areas) and every upcoming talk shows the walk, the arrival time and the minutes you would miss. The model in [`app/lib/walk.js`](app/lib/walk.js) uses Manhattan distance at 70 m/min, 0.75 min per floor and 0.5 min to cross into the Hyatt, routed through the big halls' doors, the escalators and the connection door, with extra minutes for the crowd right after a keynote. Room positions ([`app/data/venue.json`](app/data/venue.json)) were placed from public floor plans and maps before the event and not surveyed on site.
- **"As of"** lets you ask as if it were another moment during the conference, so the app works before and after the talks.

## How each sponsor tool is used

**Elasticsearch** is the data layer and the LLM gateway. Hybrid retrievers (BM25 on an English rewrite of the question, semantic on the original words) run on sessions and on slide pages, and the two result lists are fused. The question rewrite and the answer go through Elasticsearch inference endpoints. The loader builds new timestamped indices and swaps aliases only after both are complete ([`app/scripts/load-data.js`](app/scripts/load-data.js)).

**Gitar** reviewed every feature. Each one went in as a pull request labeled `gitar-managed`, with project review instructions ([`.gitar/review/`](.gitar/review/)), repository rules ([`.gitar/rules/`](.gitar/rules/)) and an auto-apply scope ([`.gitar/config/apply.md`](.gitar/config/apply.md)). Problems it caught on real code:

- [#2](https://github.com/sysnet4admin/kccnc-scout/pull/2): the loader swapped the sessions alias and deleted the old index before the pages finished loading, so one failure would leave search half updated. Auto-apply fixed it by swapping both aliases in one call.
- [#5](https://github.com/sysnet4admin/kccnc-scout/pull/5): the public search endpoint called an LLM with no rate limit. Auto-apply added one.
- [#6](https://github.com/sysnet4admin/kccnc-scout/pull/6): LLM calls had no output-token cap. Auto-apply set 400 tokens; run against the real model, that cap was spent on reasoning and left a Korean answer empty, so I raised it to 1,500 and added a notice for empty answers.
- [#7](https://github.com/sysnet4admin/kccnc-scout/pull/7): the page stayed on "Searching..." when search failed, and a bad `?at=` link stopped the page script.

The `deploy-safety` rule checks every change to `deploy/`, `argocd/`, workflows and the `Dockerfile` against the cluster's limits.

**Radar** runs the app: a vcluster on the hackathon platform, deployed by Argo CD from this repo, operated through Radar's MCP server all day (applying the Argo CD Application, syncing, waiting for rollouts, reading resources and Prometheus). After the OpenTelemetry release one pod kept restarting. Radar's AI investigation first pointed at the release; with the evidence below it concluded the node was the cause (pre-installed pods I never changed were crash-looping on the same node, which the platform cordoned), so a rollback would fix the wrong layer. [#4](https://github.com/sysnet4admin/kccnc-scout/pull/4) made the health checks tolerate short stalls.

**Dash0** receives traces, metrics and logs over OpenTelemetry ([`app/instrumentation.js`](app/instrumentation.js)): server spans named by route, Elasticsearch and LLM calls as child spans, pino logs with trace ids, and Node.js runtime metrics. During the restart incident, Agent0 compared the two pods from these runtime metrics: the event loop on the restarting pod stalled for up to 7.6 seconds with almost no load, while the same image on another node stayed under 35 ms. That pointed at the node.

## Run it yourself

You need Node.js 22 and an Elasticsearch Serverless project (Elastic Cloud) with:

- the Elastic Inference Service endpoint `.jina-embeddings-v5-text-small` (available by default),
- a `chat_completion` inference endpoint for Claude, here `kccnc-scout-claude-opus-chat` (service `anthropic`, your own Anthropic API key, `task_settings.max_tokens` set),
- an admin API key for loading, and a read-only API key for the app (`read` on `kccnc-scout-sessions*` and `kccnc-scout-pages*`, `monitor_inference` on the cluster).

### Load the data

```bash
cd app
npm ci
ES_URL_FILE=<file with the Elasticsearch URL> ES_API_KEY_FILE=<file with the admin key> \
  node scripts/load-data.js \
    --schedule https://events.linuxfoundation.org/kubecon-cloudnativecon-north-america/program/schedule/ \
    --decks decks.jsonl --pages pages.jsonl
```

`--schedule` takes the official schedule page (the loader extracts the Sessionize data embedded in it) or a saved Sessionize JSON file. `--decks` and `--pages` are the slide descriptions (see [Data](#data)); without them only the schedule is loaded. `--dry-run` builds and counts the documents without connecting.

### Run locally

```bash
cd app
ES_URL=... ES_API_KEY=<read-only key> \
ES_TRANSLATE_ENDPOINT=kccnc-scout-claude-opus-chat ES_ANSWER_ENDPOINT=kccnc-scout-claude-opus-chat \
  node server.js
# open http://localhost:8080
npm test   # no network needed
```

### Deploy

The app runs in the hackathon's team cluster as in [skyhook-io/cnh-starter](https://github.com/skyhook-io/cnh-starter): `./scripts/setup.sh <team>`, push to `main`, and apply `argocd/application.yaml` once. Every push to `main` builds the image and Argo CD syncs `deploy/`. Create the two Secrets outside git before the first sync:

```bash
kubectl -n team-<team> create secret generic elastic --from-file=url=<url file> --from-file=api-key=<read-only key file>
kubectl -n team-<team> create secret generic dash0 --from-file=token=<Dash0 ingest token file>
```

| Variable | Where | Purpose |
|---|---|---|
| `ES_URL`, `ES_API_KEY` | Secret `elastic` | Elasticsearch, read-only key |
| `ES_TRANSLATE_ENDPOINT`, `ES_ANSWER_ENDPOINT` | `deploy/deployment.yaml` | chat inference endpoints for the rewrite and the answer |
| `DAILY_ANSWER_BUDGET`, `ANSWER_LIMIT_PER_10_MINUTES`, `SEARCH_LIMIT_PER_MINUTE` | `deploy/deployment.yaml` | public URL limits, per pod |
| `DASH0_TOKEN` and `OTEL_*` | Secret `dash0`, `deploy/deployment.yaml` | OpenTelemetry export to Dash0 |

## Data

- **Schedule:** the official KubeCon + CloudNativeCon North America 2026 schedule (Sessionize JSON embedded in the schedule page), loaded on the day.
- **Slide descriptions, prepared before the event.** I generated them between November 7 and 9 with Claude Code (Claude Opus 5.5) from the slide decks speakers uploaded to the schedule: each page was rendered as an image and described as JSON (page type, summary, visible text, components, relations, numbers, whether it shows code, a diagram or a demo), plus one summary per deck (audience level, live demo, measured results, failure stories, architecture detail). Four decks that appeared on the schedule between 6:07 and 12:05 MST on November 9 were described the same way at 12:06 MST, during the event. The descriptions are not in this repository, because they transcribe text from the speakers' slides; the app links to the original slide pages instead. Descriptions are labeled "AI-read" in the app and can be wrong.

## Limits on the public URL

The URL is open to anyone, so ([`app/lib/limits.js`](app/lib/limits.js)): per-IP rate limits (search 20 per minute, answers 10 per 10 minutes), a 10-minute cache for the same question in the same 5-minute slot, output-token caps on every LLM call, and a daily cap on written answers. When the cap is reached, the app keeps answering with search results only. The app keeps no database of questions and its logs hold timings and counts, but the request URL, question included, is part of the traces sent to Dash0.

## How this was built

I built kccnc-scout during the hackathon with Claude Code as the coding assistant: it wrote most of the code, the tests and the pull requests, and operated the cluster through Radar's MCP server and Dash0's MCP server, with me reviewing and deciding each step. Every feature went through a pull request reviewed by Gitar before merging, and the review comments and fixes are in the pull request history. The slide descriptions were prepared before the event as described in [Data](#data).

The deployment setup comes from [skyhook-io/cnh-starter](https://github.com/skyhook-io/cnh-starter). [AGENTS.md](AGENTS.md) holds the notes coding agents follow in this repository.
