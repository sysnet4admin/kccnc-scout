// Index definitions for Elasticsearch. The app reads through the aliases; the
// loader builds a new timestamped index behind each alias and then swaps it in.
// The app's read-only API key may read only kccnc-scout-sessions* and
// kccnc-scout-pages*, so keep these names.

const SESSIONS_ALIAS = 'kccnc-scout-sessions';
const PAGES_ALIAS = 'kccnc-scout-pages';
const SYNONYMS_SET = 'kccnc-scout-synonyms';

// Multilingual embeddings served by the Elastic Inference Service.
const EMBEDDING_INFERENCE_ID = '.jina-embeddings-v5-text-small';

// Search-time synonyms (Solr format), so short names find long ones and back.
const SYNONYM_RULES = [
  'k8s, kubernetes',
  'otel, opentelemetry',
  'o11y, observability',
  'ebpf, extended berkeley packet filter',
  'llm, large language model',
  'genai, generative ai',
  'sre, site reliability engineering',
  'mtls, mutual tls',
  'cni, container network interface',
  'csi, container storage interface',
  'wasm, webassembly',
];

const analysis = {
  filter: {
    en_possessive: { type: 'stemmer', language: 'possessive_english' },
    en_stop: { type: 'stop', stopwords: '_english_' },
    en_stemmer: { type: 'stemmer', language: 'english' },
    kccnc_synonyms: { type: 'synonym_graph', synonyms_set: SYNONYMS_SET, updateable: true },
  },
  analyzer: {
    en_index: { tokenizer: 'standard', filter: ['en_possessive', 'lowercase', 'en_stop', 'en_stemmer'] },
    en_search: {
      tokenizer: 'standard',
      filter: ['en_possessive', 'lowercase', 'kccnc_synonyms', 'en_stop', 'en_stemmer'],
    },
  },
};

const english = { type: 'text', analyzer: 'en_index', search_analyzer: 'en_search' };
const keyword = { type: 'keyword' };
const storedOnly = { type: 'keyword', index: false };
const date = { type: 'date' };
const bool = { type: 'boolean' };

const sessionsIndex = {
  settings: { analysis },
  mappings: {
    dynamic: 'strict',
    properties: {
      id: keyword,
      title: { ...english, copy_to: 'semantic_all', fields: { raw: keyword } },
      abstract: { ...english, copy_to: 'semantic_all' },
      start: date,
      end: date,
      day: keyword,
      weekday: keyword,
      room_id: keyword,
      venue: keyword,
      floor: keyword,
      room: keyword,
      room_name: keyword,
      track: keyword,
      level: keyword,
      subtopics: keyword,
      projects: keyword,
      labels: keyword,
      speakers: {
        properties: {
          name: { ...english, fields: { raw: keyword } },
          company: keyword,
          tagline: english,
        },
      },
      speaker_bios: english,
      slides: storedOnly,
      github: storedOnly,
      demo: storedOnly,
      is_service: bool,
      has_slides: bool,
      page_count: { type: 'integer' },
      deck_summary: { ...english, copy_to: 'semantic_all' },
      deck: {
        properties: {
          audience: keyword,
          style: english,
          has_experience_story: bool,
          has_topology: bool,
          topology_detail: keyword,
          has_measured_results: bool,
          has_failure_story: bool,
          has_live_demo: bool,
          ai_focus: keyword,
        },
      },
      semantic_all: { type: 'semantic_text', inference_id: EMBEDDING_INFERENCE_ID },
    },
  },
};

const pagesIndex = {
  settings: { analysis },
  mappings: {
    dynamic: 'strict',
    properties: {
      id: keyword,
      session_id: keyword,
      page: { type: 'integer' },
      page_type: keyword,
      summary: { ...english, copy_to: 'semantic_page' },
      visible_text: { ...english, copy_to: 'semantic_page' },
      components: { type: 'keyword', copy_to: 'semantic_page' },
      relations: { ...english, copy_to: 'semantic_page' },
      numbers: english,
      density: keyword,
      has_code: bool,
      has_diagram: bool,
      has_demo: bool,
      tone: english,
      // Copied from the session.
      title: { ...english, fields: { raw: keyword } },
      start: date,
      end: date,
      day: keyword,
      weekday: keyword,
      venue: keyword,
      room: keyword,
      track: keyword,
      level: keyword,
      slides: storedOnly,
      semantic_page: { type: 'semantic_text', inference_id: EMBEDDING_INFERENCE_ID },
    },
  },
};

module.exports = {
  SESSIONS_ALIAS,
  PAGES_ALIAS,
  SYNONYMS_SET,
  EMBEDDING_INFERENCE_ID,
  SYNONYM_RULES,
  sessionsIndex,
  pagesIndex,
};
