// Recall's server. Serves the app to anyone (so the login screen loads), and everything else
// only to signed-in people: their decks, cards and progress from the database
// (<dataDir>/recall.db), card images from <dataDir>/media/, and speech audio.

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
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
import { listUsers, ownedDecks, assignDeck, unassignDeck } from './server/admin.js';
import { backupDb } from './server/backup.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
// A big import arrives in one sync.
const MAX_BODY = 100 * 1024 * 1024;
// Sign-up, login and admin forms are small; this keeps huge passwords from burning CPU.
const MAX_FORM = 16 * 1024;
// An Anki package carries its images, so it may be much larger.
const MAX_PACKAGE = 1024 * 1024 * 1024;
const MAX_IMAGE = 20 * 1024 * 1024;
const COOKIE = 'recall_session';
const COOKIE_AGE = 15552000; // 180 days, as long as a session
const HOUR = 60 * 60 * 1000;
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const LOOPBACK_ADDRESSES = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
const AUTH_STATUS = { 'bad-invite': 400, 'bad-username': 400, 'weak-password': 400, 'username-taken': 409, 'bad-login': 401 };

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
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
  const decks = await readAnkiPackage(await readBody(req, MAX_PACKAGE), { saveImage: (bytes) => saveImage(mediaDir, bytes) });
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

async function staticFile(path, res) {
  if (path === '/') path = '/index.html';
  // Only the app itself is served; the data folder is not reachable by URL.
  const allowed = path === '/index.html' || ['/js/', '/css/', '/vendor/'].some((dir) => path.startsWith(dir));
  const file = join(ROOT, normalize(path));
  if (!allowed || !file.startsWith(ROOT)) throw new Error('not found');
  const body = await readFile(file);
  res.writeHead(200, {
    'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  res.end(body);
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
 * served through a proxy; `tts` replaces the speech engine (tests use a fake).
 */
export function createRecallServer({ dataDir, origin, tts }) {
  mkdirSync(dataDir, { recursive: true });
  const db = openDb(join(dataDir, 'recall.db'));
  const voice = tts ?? createTts({ root: ROOT, dataDir });
  const mediaDir = join(dataDir, 'media');
  const ownOrigin = origin ? new URL(origin).origin : null;
  const hosts = ownOrigin ? [...LOOPBACK_HOSTS, new URL(ownOrigin).hostname] : LOOPBACK_HOSTS;
  const secure = ownOrigin?.startsWith('https://') ? '; Secure' : '';
  const cookie = (token, age) => `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}${secure}`;
  const limits = {
    login: createLimiter({ max: 10, windowMs: 15 * 60 * 1000 }),
    signup: createLimiter({ max: 10, windowMs: 15 * 60 * 1000 }),
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

  async function speech(req, res) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const save = params.get('save') !== '0';
    const { body, type } = await voice.speak(params.get('text'), params.get('lang'), { save });
    // Saved audio never changes, so phones can keep what they have played.
    const cache = save ? 'private, max-age=31536000, immutable' : 'no-store';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache }).end(body);
  }

  async function sync(req, res, user) {
    const changes = await readJson(req, MAX_BODY);
    if (!validChanges(changes)) throw new HttpError(400, 'bad-request');
    sendJson(res, 200, applyChanges(db, user.id, changes, Date.now()));
  }

  async function state(res, user) {
    const engine = await voice.engine().catch(() => '');
    sendJson(res, 200, buildView(db, user.id, Date.now()), { 'X-Tts-Engine': encodeURIComponent(engine) });
  }

  async function admin(req, res, user, path) {
    const method = req.method;
    let m;
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
    if (method === 'GET' && path === '/api/tts') return speech(req, res);
    if (method === 'POST' && path === '/api/anki') return fileRoute(res, () => anki(mediaDir, req, res));
    if (method === 'POST' && path === '/api/media') return fileRoute(res, () => upload(mediaDir, req, res));
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
      else await staticFile(path, res);
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
    db.close();
  });
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
