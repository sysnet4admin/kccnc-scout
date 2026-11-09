#!/usr/bin/env node
// Loads the schedule and the slide page descriptions into Elasticsearch.
// Run it from a laptop with an API key that can create indices, synonym sets
// and aliases. The app itself only gets a read-only key.
//
//   ES_URL_FILE=<file with the Elasticsearch URL> ES_API_KEY_FILE=<file with the admin key> \
//   node scripts/load-data.js --schedule <file or URL> --decks decks.jsonl --pages pages.jsonl
//
// --schedule takes the Sessionize JSON, or the official schedule page that embeds it.
// --dry-run builds and counts the documents without connecting.
// Each run creates <alias>-<timestamp> indices, fills them, and swaps the
// aliases only when every document was indexed. Old indices are deleted
// unless --keep-old is given.

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { Client } = require('@elastic/elasticsearch');
const schedule = require('../lib/schedule');
const indices = require('../lib/indices');

const FETCH_TIMEOUT_MS = 30_000;
const ES_REQUEST_TIMEOUT_MS = 120_000;
// semantic_text embeds every document during indexing, so keep bulk requests small.
const BULK_FLUSH_BYTES = 200_000;
const BULK_CONCURRENCY = 2;

function readSecret(envName) {
  const file = process.env[`${envName}_FILE`];
  const value = file ? fs.readFileSync(file, 'utf8') : process.env[envName];
  if (!value || !value.trim()) throw new Error(`set ${envName}_FILE or ${envName}`);
  return value.trim();
}

async function readSchedule(source) {
  let text;
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`schedule fetch failed: HTTP ${res.status}`);
    text = await res.text();
  } else {
    text = fs.readFileSync(source, 'utf8');
  }
  return text.trimStart().startsWith('{') ? JSON.parse(text) : schedule.extractSessionizeJson(text);
}

function readJsonLines(file) {
  return file ? schedule.parseJsonLines(fs.readFileSync(file, 'utf8')) : [];
}

function buildDocs(data, deckRows, pageRows) {
  const decks = new Map(deckRows.map((d) => [String(d.session_id), d]));
  const pageCounts = new Map();
  for (const p of pageRows) pageCounts.set(String(p.session_id), (pageCounts.get(String(p.session_id)) || 0) + 1);
  const sessions = schedule.toSessionDocs(data, { decks, pageCounts });
  const pages = schedule.toPageDocs(pageRows, new Map(sessions.map((s) => [s.id, s])));
  return { sessions, pages };
}

function summarize({ sessions, pages }) {
  const withSlides = sessions.filter((s) => s.has_slides);
  return {
    sessions: sessions.length,
    sessionsWithSlides: withSlides.length,
    sessionsWithDeckSummary: sessions.filter((s) => s.deck_summary).length,
    slidesNotYetDescribed: withSlides.filter((s) => s.page_count === 0).length,
    pages: pages.docs.length,
    pagesSkipped: pages.skipped,
  };
}

function indexStamp() {
  return new Date().toISOString().replace(/[-:]/g, '').slice(0, 13).toLowerCase();
}

async function currentAliasIndices(client, alias) {
  try {
    return Object.keys(await client.indices.getAlias({ name: alias }));
  } catch (err) {
    if (err.meta?.statusCode === 404) {
      if (await client.indices.exists({ index: alias })) {
        throw new Error(`${alias} exists as an index, not an alias; delete or rename it first`);
      }
      return [];
    }
    throw err;
  }
}

async function loadIndex(client, { alias, definition, docs, keepOld }) {
  const name = `${alias}-${indexStamp()}`;
  const previous = await currentAliasIndices(client, alias);
  await client.indices.create({ index: name, ...definition });
  console.log(`${alias}: created ${name}, indexing ${docs.length} documents`);

  const dropped = [];
  let done = 0;
  const result = await client.helpers.bulk({
    datasource: docs,
    onDocument: (doc) => ({ index: { _index: name, _id: doc.id } }),
    onSuccess: () => {
      done++;
      if (done % 500 === 0) console.log(`${alias}: ${done}/${docs.length}`);
    },
    onDrop: (d) => dropped.push({ id: d.document.id, status: d.status, error: d.error?.type || String(d.error) }),
    flushBytes: BULK_FLUSH_BYTES,
    concurrency: BULK_CONCURRENCY,
    retries: 2,
    wait: 3000,
  });
  if (result.failed > 0 || dropped.length > 0) {
    console.error(`${alias}: ${result.failed} documents failed, first ones:`, dropped.slice(0, 5));
    throw new Error(`${alias}: not swapping the alias; ${name} is kept for inspection`);
  }

  await client.indices.refresh({ index: name });
  const { count } = await client.count({ index: name });
  if (count !== docs.length) throw new Error(`${alias}: ${name} has ${count} documents, expected ${docs.length}`);

  const actions = [
    ...previous.map((index) => ({ remove: { index, alias } })),
    { add: { index: name, alias } },
  ];
  await client.indices.updateAliases({ actions });
  console.log(`${alias}: now points to ${name} (${count} documents)`);

  if (!keepOld) {
    for (const index of previous) {
      await client.indices.delete({ index });
      console.log(`${alias}: deleted ${index}`);
    }
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      schedule: { type: 'string' },
      decks: { type: 'string' },
      pages: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'keep-old': { type: 'boolean', default: false },
    },
  });
  if (!values.schedule) throw new Error('--schedule is required');

  const data = await readSchedule(values.schedule);
  const docs = buildDocs(data, readJsonLines(values.decks), readJsonLines(values.pages));
  console.log(JSON.stringify(summarize(docs), null, 2));
  if (values['dry-run']) return;

  const client = new Client({
    node: readSecret('ES_URL'),
    auth: { apiKey: readSecret('ES_API_KEY') },
    requestTimeout: ES_REQUEST_TIMEOUT_MS,
    maxRetries: 2,
  });

  await client.synonyms.putSynonym({
    id: indices.SYNONYMS_SET,
    synonyms_set: indices.SYNONYM_RULES.map((synonyms, i) => ({ id: `rule-${i + 1}`, synonyms })),
  });
  console.log(`synonyms: ${indices.SYNONYMS_SET} has ${indices.SYNONYM_RULES.length} rules`);

  const keepOld = values['keep-old'];
  await loadIndex(client, { alias: indices.SESSIONS_ALIAS, definition: indices.sessionsIndex, docs: docs.sessions, keepOld });
  await loadIndex(client, { alias: indices.PAGES_ALIAS, definition: indices.pagesIndex, docs: docs.pages.docs, keepOld });
}

if (require.main === module) {
  main().catch((err) => {
    // Print the error without the cluster address or request headers.
    const status = err.meta?.statusCode ? ` (HTTP ${err.meta.statusCode})` : '';
    const reason = err.meta?.body?.error?.reason || err.message;
    console.error(`${path.basename(__filename)}: ${err.name}${status}: ${String(reason).replace(/https?:\/\/\S+/g, '<url>')}`);
    process.exit(1);
  });
}

module.exports = { buildDocs, summarize, readSchedule };
