# Safety for a public repo and a public URL

This repository is public, and the app answers anyone at its public URL.

## Secrets

- No API keys, tokens, passwords, kubeconfigs or private keys in any file, including
  tests, fixtures, workflow files, example configs and comments.
- The Elasticsearch URL, the inference endpoint names, the Elasticsearch API key and the
  observability ingest token are read from environment variables, which come from a
  Kubernetes Secret created outside git. They are never hard-coded and never logged.
- Error messages and logs never print a credential or a full request header.

Report a blocking finding for any committed secret or any code that logs one.

## Calls to Elasticsearch and to LLMs

Code under `app/` that calls Elasticsearch, including LLM calls made through Elasticsearch
inference endpoints:

- Sets a request timeout on every call. LLM calls have their own, longer timeout and a
  cap on output tokens.
- Caps retries (at most 2) and does not retry on 4xx responses.
- Caps result sizes: every search sets `size`, and the API never returns an unbounded list.
- Turns a failed or timed-out call into a clear error response for the user, without a
  stack trace or internal URLs.

## Public URL limits

- The per-IP rate limit, the answer cache and the daily LLM budget stay in place. A change
  that removes or bypasses one of them is a blocking finding.
- User input that goes into a query or a prompt is length-limited, and is passed as data,
  never concatenated into Elasticsearch query DSL as raw JSON.
- The attendee's location is a zone name from the fixed list. The server does not accept
  or store coordinates.
