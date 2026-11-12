// Asks Claude to place flashcards in a deck's topics, propose topics for a deck, and put
// loose topics into groups. Only card front/back text and topic/group names are sent.
import Anthropic from '@anthropic-ai/sdk';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { aiText } from '../js/topics.js';

const DEFAULT_MODEL = 'claude-opus-5-5';

const RULES = `You sort flashcards for a spaced-repetition app. Each card has a front (the prompt) and a back (the answer). Cards may contain LaTeX; read it as source.
- Put each card in exactly one topic.
- Prefer an existing topic. Create a new topic only when nothing fits.
- Keep topic and group names short, in the language the deck is for studying.
- Only use card ids and topic ids you were given.`;

const PLACE_SYSTEM = `${RULES}
- Answer with a placement for every card you can place. For a new topic, use a ref like "new:1" as the card's topic and list it in newTopics with its name and an existing groupId (or null).`;

const PROPOSE_SYSTEM = `${RULES}
- Propose a small set of groups and topics for the whole deck. Give groups ids "g1", "g2", ... and topics ids "t1", "t2", .... Each topic has a groupId from your groups, or null.`;

const GROUP_SYSTEM = `You organise the topics of a flashcard deck into groups.
- Put each topic in one of the existing groups, using that group's id.
- Skip a topic if no group fits it.
- Keep to the ids you were given.`;

// Structured-output schemas: every object is closed and every property is required.
const obj = (properties) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const str = { type: 'string' };
const nullableStr = { type: ['string', 'null'] };
const list = (items) => ({ type: 'array', items });

const PLACE_SCHEMA = obj({
  placements: list(obj({ id: str, topic: str })),
  newTopics: list(obj({ ref: str, name: str, groupId: nullableStr })),
});
const PROPOSE_SCHEMA = obj({
  groups: list(obj({ id: str, name: str })),
  topics: list(obj({ id: str, name: str, groupId: nullableStr })),
});
const GROUP_SCHEMA = obj({
  assignments: list(obj({ id: str, groupId: str })),
});

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isStr = (x) => typeof x === 'string';
const nonEmpty = (x) => isStr(x) && x.trim() !== '';

/** Ask Claude and return the parsed JSON answer, or null for a refusal or an unusable reply. */
async function ask(client, model, system, schema, userText) {
  const res = await client.beta.messages.create({
    model,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    system,
    messages: [{ role: 'user', content: userText }],
  });
  if (res?.stop_reason === 'refusal') return null;
  const block = (res?.content ?? []).find((b) => b?.type === 'text');
  if (!block) return null;
  try {
    const data = JSON.parse(block.text);
    return isObj(data) ? data : null;
  } catch {
    return null;
  }
}

const cardsForAi = (cards) => cards.map((c) => ({ id: c.id, front: aiText(c.front), back: aiText(c.back) }));

/** Groups from the reply that have an id and a name. */
function cleanGroups(groups) {
  if (!Array.isArray(groups)) return [];
  return groups.filter((g) => isObj(g) && nonEmpty(g.id) && nonEmpty(g.name)).map((g) => ({ id: g.id, name: g.name.trim() }));
}

/** Make a sorter around an Anthropic client (tests pass a fake with beta.messages.create). */
export function createSorter({ client, model = DEFAULT_MODEL }) {
  return {
    /** Place cards in existing topics or in new ones the answer names with a `new:N` ref. */
    async placeCards({ deckName, groups, topics, cards }) {
      const empty = { placements: [], newTopics: [] };
      const user = JSON.stringify({
        deck: deckName,
        groups: groups.map((g) => ({ id: g.id, name: g.name })),
        topics: topics.map((t) => ({ id: t.id, name: t.name, groupId: t.groupId ?? null })),
        cards: cardsForAi(cards),
      });
      const data = await ask(client, model, PLACE_SYSTEM, PLACE_SCHEMA, user);
      if (!data || !Array.isArray(data.placements) || !Array.isArray(data.newTopics)) return empty;

      const groupIds = new Set(groups.map((g) => g.id));
      const topicIds = new Set(topics.map((t) => t.id));
      const cardIds = new Set(cards.map((c) => c.id));
      const newTopics = data.newTopics
        .filter((t) => isObj(t) && nonEmpty(t.ref) && nonEmpty(t.name))
        .map((t) => ({ ref: t.ref, name: t.name.trim(), groupId: groupIds.has(t.groupId) ? t.groupId : null }));
      const refs = new Set(newTopics.map((t) => t.ref));
      const placements = data.placements
        .filter((p) => isObj(p) && cardIds.has(p.id) && (topicIds.has(p.topic) || refs.has(p.topic)))
        .map((p) => ({ id: p.id, topic: p.topic }));
      return { placements, newTopics };
    },

    /** Propose groups and topics for a deck from its cards. Ids are local to the proposal. */
    async proposeTopics({ deckName, cards }) {
      const user = JSON.stringify({ deck: deckName, cards: cardsForAi(cards) });
      const data = await ask(client, model, PROPOSE_SYSTEM, PROPOSE_SCHEMA, user);
      if (!data || !Array.isArray(data.topics)) return { groups: [], topics: [] };
      const groups = cleanGroups(data.groups);
      const groupIds = new Set(groups.map((g) => g.id));
      const topics = data.topics
        .filter((t) => isObj(t) && nonEmpty(t.id) && nonEmpty(t.name))
        .map((t) => ({ id: t.id, name: t.name.trim(), groupId: groupIds.has(t.groupId) ? t.groupId : null }));
      return { groups, topics };
    },

    /** Put ungrouped topics into existing groups. Returns [{ id, groupId }]. */
    async groupTopics({ deckName, groups, topics }) {
      const user = JSON.stringify({
        deck: deckName,
        groups: groups.map((g) => ({ id: g.id, name: g.name })),
        topics: topics.map((t) => ({ id: t.id, name: t.name })),
      });
      const data = await ask(client, model, GROUP_SYSTEM, GROUP_SCHEMA, user);
      if (!data || !Array.isArray(data.assignments)) return [];
      const groupIds = new Set(groups.map((g) => g.id));
      const topicIds = new Set(topics.map((t) => t.id));
      const seen = new Set();
      const out = [];
      for (const a of data.assignments) {
        if (!isObj(a) || !topicIds.has(a.id) || !groupIds.has(a.groupId) || seen.has(a.id)) continue;
        seen.add(a.id);
        out.push({ id: a.id, groupId: a.groupId });
      }
      return out;
    },
  };
}

/**
 * Build a sorter from `ANTHROPIC_API_KEY`, or from `<dataDir>/claude.json`
 * (`{ "apiKey": "...", "model": "..." }`). Returns null when there is no key.
 */
export function loadSorter(dataDir) {
  let file = {};
  const path = join(dataDir, 'claude.json');
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (isObj(parsed)) file = parsed;
    } catch {
      // A broken file counts as no file.
    }
  }
  const apiKey = process.env.ANTHROPIC_API_KEY || (nonEmpty(file.apiKey) ? file.apiKey.trim() : '');
  if (!apiKey) return null;
  const model = nonEmpty(file.model) ? file.model.trim() : DEFAULT_MODEL;
  return createSorter({ client: new Anthropic({ apiKey }), model });
}
