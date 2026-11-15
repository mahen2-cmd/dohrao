// Recall's server. Serves the app to anyone (so the login screen loads), and everything else
// only to signed-in people: their decks, cards and progress from the database
// (<dataDir>/recall.db), card images from <dataDir>/media/, and speech audio.

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { access, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readAnkiPackage } from './anki.js';
import { IMAGE_TYPES, MEDIA_NAME, imageType } from './js/content.js';
import { createTts } from './tts.js';
import { openDb } from './server/db.js';
import {
  AuthError, signUp, logIn, createSession, userForSession, endSession, setPassword,
  createInvite, listInvites, revokeInvite, createLimiter,
} from './server/auth.js';
import { buildView, applyChanges } from './server/sync.js';
import { listUsers, ownedDecks, assignDeck, unassignDeck, setUrduSwitch, peopleProgress, personProgress } from './server/admin.js';
import { backupDb } from './server/backup.js';
import { loadSorter } from './server/sorter.js';
import { ownedDeck, unsortedCards, sortDeck, proposeForDeck, approveProposal } from './server/topics.js';
import { createTranslator } from './server/translate.js';
import { createUrduQueue } from './server/urdu-queue.js';
import { FRONTS } from './js/urdu.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
// A big import arrives in one sync. The largest account's whole state is under 5 MB as JSON,
// and 50,000 cards (the most one person may own) about 25 MB.
const MAX_BODY = 40 * 1024 * 1024;
// The app's settings are a few bytes.
const MAX_SETTINGS = 16 * 1024;
// Images one person may upload a day.
const IMAGES_PER_DAY = 300;
const DAY = 24 * 60 * 60 * 1000;
// The languages a card side can be read in; an empty one means the voice's own.
const TTS_LANGS = ['pt-PT', 'pt-BR', 'en-US', 'en-GB', 'ur-PK'];
// Sign-up, login and admin forms are small; this keeps huge passwords from burning CPU.
const MAX_FORM = 16 * 1024;
// An Anki package carries its images, so it may be much larger.
// It is held in memory while it is read, so it is capped well below the server's memory, and
// only one is read at a time.
const MAX_PACKAGE = 100 * 1024 * 1024;
const MAX_IMAGE = 20 * 1024 * 1024;
const COOKIE = 'recall_session';
const COOKIE_AGE = 15552000; // 180 days, as long as a session
const HOUR = 60 * 60 * 1000;
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const LOOPBACK_ADDRESSES = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
const AUTH_STATUS = { 'bad-invite': 400, 'bad-username': 400, 'bad-name': 400, 'weak-password': 400, 'username-taken': 409, 'bad-login': 401 };

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

const exists = (file) => access(file).then(() => true, () => false);

/** An answer with a status and an error code, sent as `{ "error": code }`. */
class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) reject(new Error('too large'));
      else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The request's JSON object; an empty body is `{}`. */
async function readJson(req, limit) {
  const bytes = await readBody(req, limit).catch(() => {
    throw new HttpError(413, 'too-large');
  });
  if (bytes.length === 0) return {};
  let data;
  try {
    data = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new HttpError(400, 'bad-request');
  }
  if (!isPlain(data)) throw new HttpError(400, 'bad-request');
  return data;
}

/** Whether a sync body has the shape applyChanges expects. */
function validChanges(c) {
  const list = (key, ok) => c[key] === undefined || (Array.isArray(c[key]) && c[key].every(ok));
  const object = (key) => c[key] === undefined || isPlain(c[key]);
  return list('decks', isPlain) && list('cards', isPlain)
    && list('deletedDecks', (id) => typeof id === 'string') && list('deletedCards', (id) => typeof id === 'string')
    && object('daily') && object('log') && object('settings')
    && (c.settings === undefined || Buffer.byteLength(JSON.stringify(c.settings)) <= MAX_SETTINGS)
    && (c.savedAt === undefined || Number.isFinite(c.savedAt));
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

const noContent = (res, headers = {}) => res.writeHead(204, { 'Cache-Control': 'no-store', ...headers }).end();

/**
 * Keep an image in the media folder and return its name. Images are named by their contents,
 * so the same one added twice is kept once.
 */
async function saveImage(mediaDir, bytes) {
  const type = imageType(bytes);
  if (!type) throw new Error('Only PNG, JPEG, GIF, WebP and SVG images can be added.');
  if (bytes.length > MAX_IMAGE) throw new Error('That image is larger than 20 MB.');
  const name = `${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}.${type}`;
  const file = join(mediaDir, name);
  if (!(await exists(file))) {
    await mkdir(mediaDir, { recursive: true });
    await writeFile(`${file}.tmp`, bytes);
    await rename(`${file}.tmp`, file);
  }
  return name;
}

async function upload(mediaDir, req, res) {
  const name = await saveImage(mediaDir, await readBody(req, MAX_IMAGE + 1));
  sendJson(res, 200, { name });
}

async function image(mediaDir, name, res) {
  const body = MEDIA_NAME.test(name) && (await readFile(join(mediaDir, name)).catch(() => null));
  if (!body) return res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  res.writeHead(200, {
    'Content-Type': IMAGE_TYPES[extname(name).slice(1)],
    // An image never changes under its name.
    'Cache-Control': 'private, max-age=31536000, immutable',
    // An SVG opened on its own must not run scripts with the app's access.
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

/**
 * Turn an uploaded Anki package into decks and cards. Only the images the cards show are
 * saved here; the cards are added by the app once they are confirmed.
 */
async function anki(mediaDir, req, res) {
  const bytes = await readBody(req, MAX_PACKAGE).catch(() => {
    throw new Error('That package is larger than 100 MB.');
  });
  const decks = await readAnkiPackage(bytes, { saveImage: (image) => saveImage(mediaDir, image) });
  sendJson(res, 200, decks);
}

/** Image and Anki failures say what was wrong with the file, as plain text the app shows. */
async function fileRoute(res, task) {
  try {
    await task();
  } catch (error) {
    if (res.headersSent) return res.end();
    res.writeHead(400, { 'Content-Type': 'text/plain' }).end(String(error.message));
  }
}

async function staticFile(path, req, res) {
  if (path === '/') path = '/index.html';
  // Only the app itself is served; the data folder is not reachable by URL. The file is
  // resolved first and must then lie inside one of the served folders.
  if (/\.\.|\\|\0/.test(path)) throw new Error('not found');
  const file = resolve(ROOT, `.${path}`);
  const allowed = ['index.html', 'manifest.webmanifest'].some((name) => file === join(ROOT, name))
    || ['js', 'css', 'vendor', 'icons'].some((dir) => file.startsWith(join(ROOT, dir) + sep));
  if (!allowed) throw new Error('not found');
  const info = await stat(file);
  if (!info.isFile()) throw new Error('not found');
  // The phone keeps its copy and asks each time whether it changed; vendor/ only changes with
  // a release, so its libraries are kept for a week without asking.
  const etag = `"${info.size.toString(36)}-${Math.trunc(info.mtimeMs).toString(36)}"`;
  const headers = {
    'Cache-Control': file.startsWith(join(ROOT, 'vendor') + sep) ? 'public, max-age=604800' : 'no-cache',
    ETag: etag,
  };
  if (etagMatches(req.headers['if-none-match'], etag)) return res.writeHead(304, headers).end();
  const body = await readFile(file);
  res.writeHead(200, { ...headers, 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
  res.end(body);
}

/**
 * Whether an If-None-Match header names `etag`. Caddy hands out a compressed copy's ETag as a
 * weak one with the encoding added (W/"abc-gzip"), so those count as the same.
 */
function etagMatches(header, etag) {
  if (!header) return false;
  return header.split(',').some((tag) => {
    const plain = tag.trim().replace(/^W\//, '').replace(/-(gzip|zstd|br)"$/, '"');
    return plain === '*' || plain === etag;
  });
}

function sessionToken(req) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === COOKIE) return value.join('=');
  }
  return null;
}

/** The address a request came from; behind the local proxy, the one it forwarded. */
function clientIp(req) {
  const address = req.socket.remoteAddress ?? '';
  const forwarded = req.headers['x-forwarded-for'];
  if (LOOPBACK_ADDRESSES.includes(address) && forwarded) return forwarded.split(',')[0].trim();
  return address;
}

/**
 * The Recall server. `origin` is the public address (e.g. https://recall.example) when it is
 * served through a proxy; `tts` replaces the speech engine and `translator` the Urdu
 * translation (tests use fakes).
 */
export function createRecallServer({ dataDir, origin, tts, translator, ...rest }) {
  mkdirSync(dataDir, { recursive: true });
  const db = openDb(join(dataDir, 'recall.db'));
  // `sorter: null` means sorting is off; leaving the option out looks for a key (and the SDK).
  const sorterReady = 'sorter' in rest ? Promise.resolve(rest.sorter) : loadSorter(dataDir);
  // Decks being sorted right now, so a second click does not start a second job.
  const sorting = new Set();
  // Whether an Anki package is being read; each takes a lot of memory, so one runs at a time.
  let importing = false;
  const voice = tts ?? createTts({ root: ROOT, dataDir });
  // Google is only reached once a card actually needs translating.
  let google;
  const urduTranslator = translator ?? { toUrdu: (text) => (google ??= createTranslator()).toUrdu(text) };
  const urduQueue = createUrduQueue({ db, translator: urduTranslator });
  const mediaDir = join(dataDir, 'media');
  const ownOrigin = origin ? new URL(origin).origin : null;
  const hosts = ownOrigin ? [...LOOPBACK_HOSTS, new URL(ownOrigin).hostname] : LOOPBACK_HOSTS;
  const secure = ownOrigin?.startsWith('https://') ? '; Secure' : '';
  const cookie = (token, age) => `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}${secure}`;
  const limits = {
    login: createLimiter({ max: 10, windowMs: 15 * 60 * 1000 }),
    signup: createLimiter({ max: 10, windowMs: 15 * 60 * 1000 }),
    // Keyed by user id, unlike the two above.
    media: createLimiter({ max: IMAGES_PER_DAY, windowMs: DAY }),
    // Studying with auto-play asks for a few a card, far fewer than this.
    tts: createLimiter({ max: 120, windowMs: 60 * 1000 }),
  };

  const backup = () => {
    try {
      backupDb(db, join(dataDir, 'backups'), Date.now());
    } catch (error) {
      console.error('Backup failed:', error);
    }
  };
  backup();
  const timer = setInterval(backup, HOUR).unref();

  const limit = (name, req) => {
    if (!limits[name].hit(clientIp(req), Date.now())) throw new HttpError(429, 'rate-limited');
  };

  /** Start a session for `user` and answer with it. */
  const signIn = (res, status, user) => {
    const token = createSession(db, user.id, Date.now());
    sendJson(res, status, { user }, { 'Set-Cookie': cookie(token, COOKIE_AGE) });
  };

  async function speech(req, res, user) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const lang = params.get('lang');
    if (lang && !TTS_LANGS.includes(lang)) throw new HttpError(400, 'bad-request');
    if (!limits.tts.hit(user.id, Date.now())) throw new HttpError(429, 'rate-limited');
    const save = params.get('save') !== '0';
    const { body, type } = await voice.speak(params.get('text'), lang, { save });
    // Saved audio never changes, so phones can keep what they have played.
    const cache = save ? 'private, max-age=31536000, immutable' : 'no-store';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache }).end(body);
  }

  async function sync(req, res, user) {
    const changes = await readJson(req, MAX_BODY);
    if (!validChanges(changes)) throw new HttpError(400, 'bad-request');
    const result = applyChanges(db, user.id, changes, Date.now());
    const deckIds = new Set([...(changes.cards ?? []).map((c) => c.deckId), ...(changes.decks ?? []).map((d) => d.id)]);
    // The changes are saved by now; a fault in the Urdu scan must not report them as unsaved.
    try {
      for (const id of deckIds) if (typeof id === 'string') urduQueue.scanDeck(id);
    } catch (error) {
      console.error('Urdu scan failed after a sync:', error?.message ?? error);
    }
    sendJson(res, 200, result);
  }

  async function state(res, user) {
    const engine = await voice.engine().catch(() => '');
    sendJson(res, 200, buildView(db, user.id, Date.now()), { 'X-Tts-Engine': encodeURIComponent(engine) });
  }

  /** Sort a deck in the background; a failure is logged and ends the job. */
  function startSort(sorter, deckId) {
    if (sorting.has(deckId)) return;
    sorting.add(deckId);
    sortDeck(db, sorter, deckId, Date.now())
      .catch((error) => console.error('Sorting failed:', error?.message ?? error))
      .finally(() => sorting.delete(deckId));
  }

  /** Admin routes for one deck's topics. Only the deck's owner gets past the 404. */
  async function topicsRoute(req, res, user, deckId, action) {
    const method = req.method;
    if (!ownedDeck(db, user.id, deckId)) throw new HttpError(404, 'not-found');
    if (method === 'GET' && action === 'sort') {
      return sendJson(res, 200, { running: sorting.has(deckId), unsorted: unsortedCards(db, deckId).length });
    }
    if (method === 'GET' && action === 'proposal') {
      const row = db.prepare('SELECT data FROM topic_proposals WHERE deck_id = ?').get(deckId);
      if (!row) throw new HttpError(404, 'not-found');
      return sendJson(res, 200, JSON.parse(row.data));
    }
    if (method !== 'POST') throw new HttpError(404, 'not-found');
    const sorter = await sorterReady;
    if (!sorter) throw new HttpError(503, 'no-sorter');
    if (action === 'sort') {
      // A deck with no topics gets a proposal first.
      if (!(JSON.parse(ownedDeck(db, user.id, deckId).data).topics ?? []).length) throw new HttpError(409, 'no-topics');
      startSort(sorter, deckId);
      return sendJson(res, 202, { running: true });
    }
    if (action === 'propose') return sendJson(res, 200, await proposeForDeck(db, sorter, deckId, Date.now()));
    if (action === 'proposal/approve') {
      const { groups, topics } = await readJson(req, MAX_FORM);
      try {
        approveProposal(db, deckId, { groups, topics }, Date.now());
      } catch (error) {
        throw error.message === 'bad-request' ? new HttpError(400, 'bad-request') : error;
      }
      startSort(sorter, deckId);
      return noContent(res);
    }
    throw new HttpError(404, 'not-found');
  }

  async function admin(req, res, user, path) {
    const method = req.method;
    let m;
    if ((m = path.match(/^\/api\/admin\/decks\/([^/]+)\/(sort|propose|proposal|proposal\/approve)$/))) {
      return topicsRoute(req, res, user, m[1], m[2]);
    }
    if (method === 'GET' && path === '/api/admin/users') return sendJson(res, 200, listUsers(db));
    if (method === 'GET' && path === '/api/admin/invites') return sendJson(res, 200, listInvites(db));
    if (method === 'POST' && path === '/api/admin/invites') {
      const { uses = 1 } = await readJson(req, MAX_FORM);
      if (!Number.isInteger(uses) || uses < 1 || uses > 20) throw new HttpError(400, 'bad-request');
      return sendJson(res, 201, { code: createInvite(db, { uses }, Date.now()) });
    }
    if (method === 'DELETE' && (m = path.match(/^\/api\/admin\/invites\/([^/]+)$/))) {
      revokeInvite(db, m[1]);
      return noContent(res);
    }
    if (method === 'GET' && path === '/api/admin/decks') return sendJson(res, 200, ownedDecks(db, user.id));
    if (method === 'GET' && path === '/api/admin/progress') return sendJson(res, 200, peopleProgress(db, Date.now()));
    if (method === 'GET' && (m = path.match(/^\/api\/admin\/progress\/([^/]+)$/))) {
      const progress = personProgress(db, m[1], Date.now());
      if (!progress) throw new HttpError(404, 'not-found');
      return sendJson(res, 200, progress);
    }
    if (method === 'POST' && (m = path.match(/^\/api\/admin\/decks\/([^/]+)\/(assign|unassign)$/))) {
      const { userIds } = await readJson(req, MAX_FORM);
      const known = db.prepare('SELECT 1 FROM users WHERE id = ?');
      if (!Array.isArray(userIds) || !userIds.every((id) => typeof id === 'string' && known.get(id))) {
        throw new HttpError(400, 'bad-request');
      }
      const give = m[2] === 'assign' ? assignDeck : unassignDeck;
      give(db, { ownerId: user.id, deckId: m[1], userIds }, Date.now());
      return noContent(res);
    }
    if (method === 'POST' && (m = path.match(/^\/api\/admin\/decks\/([^/]+)\/urdu$/))) {
      const { userId, on, front } = await readJson(req, MAX_FORM);
      const valid = front === undefined ? typeof on === 'boolean' : FRONTS.includes(front);
      if (typeof userId !== 'string' || !valid) throw new HttpError(400, 'bad-request');
      try {
        setUrduSwitch(db, { ownerId: user.id, deckId: m[1], userId, front, on }, Date.now());
      } catch (err) {
        if (err.message === 'not-owner') throw new HttpError(404, 'not-found');
        if (err.message === 'not-given') throw new HttpError(400, 'bad-request');
        throw err;
      }
      return noContent(res);
    }
    if (method === 'POST' && (m = path.match(/^\/api\/admin\/users\/([^/]+)\/password$/))) {
      const { password } = await readJson(req, MAX_FORM);
      if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(m[1])) throw new HttpError(404, 'not-found');
      await setPassword(db, m[1], password);
      return noContent(res);
    }
    throw new HttpError(404, 'not-found');
  }

  async function api(req, res, path) {
    const method = req.method;
    if (method === 'POST' && path === '/api/signup') {
      limit('signup', req);
      const { code, username, name, password } = await readJson(req, MAX_FORM);
      return signIn(res, 201, await signUp(db, { code, username, name, password }, Date.now()));
    }
    if (method === 'POST' && path === '/api/login') {
      limit('login', req);
      const { username, password } = await readJson(req, MAX_FORM);
      return signIn(res, 200, await logIn(db, { username, password }));
    }

    const token = sessionToken(req);
    const user = token && userForSession(db, token, Date.now());
    if (!user) throw new HttpError(401, 'signed-out');

    if (method === 'POST' && path === '/api/logout') {
      endSession(db, token);
      return noContent(res, { 'Set-Cookie': cookie('', 0) });
    }
    if (method === 'GET' && path === '/api/me') return sendJson(res, 200, { user });
    if (method === 'GET' && path === '/api/state') return state(res, user);
    if (method === 'POST' && path === '/api/sync') return sync(req, res, user);
    if (method === 'GET' && path === '/api/tts') return speech(req, res, user);
    if (method === 'POST' && path === '/api/anki') {
      if (importing) {
        return res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': '10' })
          .end('Another Anki import is being read. Try again in a moment.');
      }
      importing = true;
      try {
        return await fileRoute(res, () => anki(mediaDir, req, res));
      } finally {
        importing = false;
      }
    }
    if (method === 'POST' && path === '/api/media') {
      if (!limits.media.hit(user.id, Date.now())) {
        return res.writeHead(429, { 'Content-Type': 'text/plain' })
          .end(`You have added ${IMAGES_PER_DAY} images today, the most for one day. Try again tomorrow.`);
      }
      return fileRoute(res, () => upload(mediaDir, req, res));
    }
    if (method === 'GET' && path.startsWith('/api/media/')) return image(mediaDir, path.slice('/api/media/'.length), res);
    if (path.startsWith('/api/admin/')) {
      if (user.role !== 'admin') throw new HttpError(403, 'forbidden');
      return admin(req, res, user, path);
    }
    throw new HttpError(404, 'not-found');
  }

  /** A state-changing request from a page that is not Recall's own is refused. */
  function foreignOrigin(req) {
    const from = req.headers.origin;
    if (!from || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return false;
    const own = [ownOrigin];
    if (LOOPBACK_HOSTS.includes((req.headers.host ?? '').replace(/:\d+$/, ''))) own.push(`http://${req.headers.host}`);
    return !own.includes(from);
  }

  const server = createServer(async (req, res) => {
    // Only answer requests addressed to this server, so other sites cannot reach the data.
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (!hosts.includes(host)) return res.writeHead(403).end('Forbidden');
    let isApi = false;
    try {
      const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      isApi = path.startsWith('/api/');
      // Browsers say where a request comes from; refuse API calls made by other websites.
      const site = req.headers['sec-fetch-site'];
      if (isApi && site && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'forbidden');
      if (foreignOrigin(req)) throw new HttpError(403, 'forbidden');
      if (isApi) await api(req, res, path);
      else await staticFile(path, req, res);
    } catch (error) {
      if (res.headersSent) return res.end();
      if (error instanceof HttpError) return sendJson(res, error.status, { error: error.code });
      if (!isApi) return res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      if (error instanceof AuthError) return sendJson(res, AUTH_STATUS[error.code] ?? 400, { error: error.code });
      if (error.message === 'not-owner') return sendJson(res, 404, { error: 'not-found' });
      console.error(error);
      sendJson(res, 500, { error: 'server' });
    }
  });
  server.on('close', () => {
    clearInterval(timer);
    urduQueue.stop();
    db.close();
  });
  urduQueue.scanAll();
  // Tests wait on the queue through this.
  server.urduQueue = urduQueue;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT) || 5173;
  const dataDir = resolve(process.env.RECALL_DATA || join(ROOT, 'data'));
  const tts = createTts({ root: ROOT, dataDir });
  createRecallServer({ dataDir, origin: process.env.RECALL_ORIGIN || undefined, tts }).listen(port, '127.0.0.1', () => {
    console.log(`Recall is running at http://localhost:${port}`);
    console.log(`Data is kept in ${dataDir}`);
    tts.engine().then((engine) => console.log(`Voice: ${engine}`));
  });
}
