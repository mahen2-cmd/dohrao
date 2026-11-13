import * as api from './api.js';
import { hasRichContent, imageToken, mathSpans, mathToken, parseContent, speechText } from './content.js';
import { DAY, MINUTE, Rating, State, dayStart } from './fsrs.js';
import { parseSpreadsheet } from './importer.js';
import { TABBED_DECK_QUERY, clampAmount, ownTicks, pruneTicks, pullAllLabel, pullPreview } from './deckpage.js';
import { HEAT_WEEKS, PHONE_QUERY, canSwipeFrom, classifySwipe, inTab, isRevealTap, swipeLeaning, tabFilters } from './phone.js';
import { recentStudy, rightShare } from './progress.js';
import * as store from './store.js';
import { effectiveTopic, filterLabel, inFilter, readableTopicName, resolveFilter, topicKeyFromFileName, topicLabel } from './topics.js';

const app = document.getElementById('app');

// The phone layout (640px and narrower). Most of it is CSS; this is for the few places where
// what is listed differs by width. Crossing the breakpoint (a rotation) draws the screen again.
const phoneQuery = matchMedia(PHONE_QUERY);
const isPhone = () => phoneQuery.matches;
phoneQuery.addEventListener('change', () => render());
// Up to 899px the deck page shows tabs instead of the reserve beside the cards.
const tabbedQuery = matchMedia(TABBED_DECK_QUERY);
const isTabbedDeck = () => tabbedQuery.matches;
tabbedQuery.addEventListener('change', () => render());
const toasts = document.getElementById('toasts');

// The card currently on screen in study mode.
const session = { deckId: null, cardId: null, revealed: false, done: 0, spoken: null };
// Who is signed in ({ id, username, name, role }), or null.
let account = null;
// Set when the server could not be reached as the app started.
let offline = false;
let query = '';

// Filters on a deck's card list, reset whenever a different deck is opened.
const NO_FILTERS = { groups: [], due: 'any', added: 'any', lapses: 'any', topics: [], sort: 'newest' };
let filters = { ...NO_FILTERS };
let filtersDeck = null;
// Whether the filter and sort selects are open on a phone, where they start folded away.
let filtersOpen = false;
// On a phone the deck page shows one of its tabs: 'cards', 'reserve' or 'topics'.
let deckTab = 'cards';
// On a wide screen: the topic the reserve column pulls from ('' for all), and how many (null: the default).
let reserveTopic = '';
let pullAmount = null;
// Ids of the cards ticked in that list. Only cards on screen stay selected.
let selected = new Set();
// How many cards the list draws at first, and how many more each "Show more" adds.
const CARD_PAGE = 200;

const CARD_GROUPS = [
  ['new', 'New'],
  ['learning', 'Learning'],
  ['due', 'Due'],
  ['later', 'Not due yet'],
  ['reserve', 'On reserve'],
];
const FILTER_SELECTS = [
  ['due', 'Next review', [['any', 'Any time'], ['overdue', 'Overdue'], ['today', 'Today or overdue'], ['week', 'Within 7 days'], ['month', 'Within 30 days']]],
  ['added', 'Added', [['any', 'Any time'], ['today', 'Today'], ['week', 'In the last 7 days'], ['month', 'In the last 30 days']]],
  ['lapses', 'Forgotten', [['any', 'Any'], ['some', 'At least once'], ['many', '3 times or more']]],
  ['sort', 'Sort by', [['newest', 'Newest first'], ['oldest', 'Oldest first'], ['due', 'Next review'], ['front', 'Front, A to Z'], ['lapses', 'Most forgotten'], ['reserve', 'Reserve order']]],
];

// ---- DOM helpers ----------------------------------------------------------

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value == null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else if (key in el) el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  el.append(...children.flat(Infinity).filter((c) => c != null && c !== false));
  return el;
}

const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M9 7V4h6v3"/>',
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  download: '<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>',
  upload: '<path d="M12 16V5M7 9l5-5 5 5M5 20h14"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4-4"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.5"/>',
  speaker: '<path d="M4 9.5v5h3.5L12 18V6L7.5 9.5H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  play: '<path d="M7 5l12 7-12 7V5z"/>',
  chart: '<path d="M5 20v-8M12 20V5M19 20v-5"/>',
  calendar: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
  box: '<path d="M4 8h16v11H4zM3 5h18v3H3zM10 12h4"/>',
  decks: '<rect x="4" y="8" width="16" height="12" rx="2"/><path d="M7 5h10M9 2.5h6"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
  next: '<path d="M9 6l6 6-6 6"/>',
  sliders: '<path d="M4 6h16M7 12h10M10 18h4"/>',
  swap: '<path d="M7 4L3 8l4 4M3 8h14M17 12l4 4-4 4M21 16H7"/>',
  grip: '<path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01"/>',
  sigma: '<path d="M18 5H6l6 7-6 7h12"/>',
  more: '<path d="M6 12h.01M12 12h.01M18 12h.01"/>',
  image: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="M21 15l-5-5-9 9"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>',
  logout: '<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 16l-4-4 4-4M6 12h10"/>',
  shield: '<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M15 8l2 2"/>',
  share: '<circle cx="9" cy="8" r="3.5"/><path d="M3 20a6 6 0 0 1 12 0M18 8v6M15 11h6"/>',
};

function icon(name) {
  const span = h('span', { class: 'icon', 'aria-hidden': 'true' });
  span.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[name]}</svg>`;
  return span;
}

/** A small menu behind a "more" button. It closes when an item is chosen or on a click elsewhere. */
function menu(label, items, glyph = 'more', extra = '') {
  const el = h(
    'details',
    { class: `menu ${extra}`.trim() },
    h('summary', { class: 'icon-btn', title: label, 'aria-label': label }, icon(glyph)),
    h('div', { class: 'menu-items', onclick: () => el.removeAttribute('open') }, items),
  );
  return el;
}
document.addEventListener('click', (e) => {
  // On a phone an open menu is a sheet over a dimmed backdrop, drawn by the menu itself: a tap
  // on the backdrop lands on the menu element and closes it too.
  for (const open of document.querySelectorAll('details.menu[open]')) if (!open.contains(e.target) || e.target === open) open.removeAttribute('open');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isPhone()) for (const open of document.querySelectorAll('details.menu[open]')) open.removeAttribute('open');
});
// A sheet takes the focus when it opens, so a keyboard or screen reader lands in it.
document.addEventListener(
  'toggle',
  (e) => {
    const menu = e.target;
    if (isPhone() && menu.matches?.('details.menu') && menu.open) menu.querySelector('.menu-items > :is(a, button)')?.focus();
  },
  true,
);

const iconButton = (name, label, onclick, extra = '') =>
  h('button', { class: `icon-btn ${extra}`, type: 'button', title: label, 'aria-label': label, onclick }, icon(name));

const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

function toast(message) {
  const el = h('div', { class: 'toast' }, message);
  toasts.append(el);
  setTimeout(() => el.remove(), 2600);
}

function formatInterval(ms) {
  const minutes = Math.max(1, Math.round(ms / MINUTE));
  if (minutes < 60) return `${minutes}m`;
  const days = Math.round(ms / DAY);
  if (days < 1) return `${Math.round(minutes / 60)}h`;
  if (days < 30) return `${days}d`;
  if (days < 365) return `${+(days / 30).toFixed(1)}mo`;
  return `${+(days / 365).toFixed(1)}y`;
}

function cardStatus(card, now) {
  if (card.reserved) return { kind: 'zero', label: 'On reserve' };
  if (card.state === State.New) return { kind: 'new', label: 'New' };
  if (card.state !== State.Review) return { kind: 'learning', label: 'Learning' };
  const days = Math.round((new Date(card.due).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / DAY);
  if (days <= 0) return { kind: 'review', label: 'Due today' };
  return { kind: 'zero', label: `Due in ${formatInterval(days * DAY)}` };
}

function tomorrowText({ tomorrow: t, reserve }) {
  if (!t.total) return reserve ? 'Nothing comes tomorrow. Pull some cards in from the reserve.' : 'Nothing comes tomorrow.';
  return `Tomorrow: ${plural(t.total, 'card')} (${t.new.toLocaleString()} new, ${t.learning.toLocaleString()} learning, ${t.review.toLocaleString()} due)`;
}

// A count is a coloured dot beside a figure: Anki's blue for new, ochre for learning, green for due.
const countOf = (kind, n, label) =>
  h('span', { class: `count ${n ? kind : 'zero'}`, title: `${n} ${label.toLowerCase()}` }, h('i', { class: 'dot', 'aria-hidden': 'true' }), h('b', null, n.toLocaleString()), h('span', null, label));

function countPills(c) {
  return h('div', { class: 'counts' }, countOf('new', c.new, 'New'), countOf('learning', c.learning, 'Learning'), countOf('review', c.review, 'Due'));
}

const statusMark = (status, label = status.label, extra = '') =>
  h('span', { class: `status ${status.kind} ${extra}` }, h('i', { class: 'dot', 'aria-hidden': 'true' }), label);

// ---- Card content ---------------------------------------------------------
// A side's text, with its maths typeset by KaTeX (loaded by index.html from vendor/katex/)
// and its images shown from the server.

/** Marks display maths too wide for its box, which then fades at the edge to show it scrolls. */
function markOverflow(root) {
  requestAnimationFrame(() => {
    for (const el of root.querySelectorAll('.katex-display')) el.classList.toggle('overflows', el.scrollWidth > el.clientWidth + 1);
  });
}

const mediaUrl = (name) => `api/media/${encodeURIComponent(name)}`;

function mathElement(tex, display, onclick) {
  const el = h('span', { class: `math${display ? ' display' : ''}${onclick ? ' editable' : ''}`, title: onclick && 'Edit this maths', onclick });
  if (globalThis.katex) globalThis.katex.render(tex, el, { displayMode: display, throwOnError: false });
  else el.textContent = display ? `\\[${tex}\\]` : `\\(${tex}\\)`;
  return el;
}

/** The nodes that show a card side. With `editMath`, clicking the nth piece of maths calls `editMath(n)`. */
const rich = (text, editMath) => {
  let n = 0;
  return parseContent(text).map((part) => {
    if (part.text !== undefined) return part.text;
    if (part.math !== undefined) {
      const index = n++;
      return mathElement(part.math, part.display, editMath && (() => editMath(index)));
    }
    return h('img', {
      class: 'card-image',
      src: mediaUrl(part.image),
      alt: '',
      loading: 'lazy',
      onerror: (e) => e.target.replaceWith(h('span', { class: 'image-missing' }, 'Image not found')),
    });
  });
};

// ---- Equation editor ------------------------------------------------------
// MathLive, from vendor/mathlive/, loaded the first time it is needed. It shares KaTeX's fonts.

let mathLive = null;

function loadMathLive() {
  mathLive ??= import('../vendor/mathlive/mathlive.min.mjs').then(({ MathfieldElement }) => {
    MathfieldElement.fontsDirectory = new URL('../vendor/katex/fonts/', import.meta.url).href;
    MathfieldElement.soundsDirectory = null;
  });
  mathLive.catch(() => (mathLive = null));
  return mathLive;
}

// Shortcuts above the equation box. In each, #0 stands for what is selected and #? for an
// empty slot to fill in.
const matrix = (n) => `\\begin{bmatrix}${Array.from({ length: n }, () => Array(n).fill('#?').join('&')).join('\\\\')}\\end{bmatrix}`;
const MATH_TOOLS = [
  ['a/b', 'Fraction', '\\frac{#0}{#?}'],
  ['√', 'Square root', '\\sqrt{#0}'],
  ['xⁿ', 'Power', '#0^{#?}'],
  ['xₙ', 'Subscript', '#0_{#?}'],
  ['ẋ', 'Rate of change (dot)', '\\dot{#0}'],
  ['v⃗', 'Vector arrow', '\\vec{#0}'],
  ['2×2', '2 by 2 matrix', matrix(2)],
  ['3×3', '3 by 3 matrix', matrix(3)],
  ['4×4', '4 by 4 matrix', matrix(4)],
];

/**
 * Open the equation editor on `math` (LaTeX), and call `onsave(math, display)` with the result.
 * `display` is whether the maths sits on a line of its own.
 */
async function openMathDialog({ math = '', display = false, editing = false }, onsave) {
  try {
    await loadMathLive();
  } catch {
    toast('Could not load the equation editor.');
    return;
  }
  const field = h('math-field', { class: 'math-input', 'aria-label': 'Equation' });
  field.value = math;
  const ownLine = h('input', { type: 'checkbox', checked: display });
  const form = h(
    'form',
    {
      onsubmit: (e) => {
        e.preventDefault();
        // An empty slot left in a fraction or power is written as a placeholder; drop it.
        const latex = field
          .getValue('latex-expanded')
          .replace(/\\placeholder(?:\[[^\]]*\])?\{([^{}]*)\}/g, '$1')
          .trim();
        if (!latex) return field.focus();
        // Close first: closing hands the focus back, and the text box should end up with it.
        dialog.close();
        onsave(latex, ownLine.checked);
      },
    },
    h(
      'div',
      { class: 'math-tools', role: 'toolbar', 'aria-label': 'Insert' },
      MATH_TOOLS.map(([text, title, latex]) =>
        h(
          'button',
          {
            class: 'btn sm',
            type: 'button',
            title,
            'aria-label': title,
            // Keep the focus, and so the selection, in the equation box.
            onmousedown: (e) => e.preventDefault(),
            onclick: () => {
              field.insert(latex, { selectionMode: 'placeholder', focus: true });
              field.focus();
            },
          },
          text,
        ),
      ),
    ),
    field,
    h('small', { class: 'field-note math-help' }, 'Type maths as it looks: / starts a fraction, ^ a power and _ a subscript, and the arrow keys move between the parts and between the cells of a matrix. Type sqrt, theta, omega, pi or sum by name. More is in the menu at the end of the box. On a phone, a maths keyboard opens.'),
    h('label', { class: 'check' }, ownLine, 'On a line of its own, centred'),
    h(
      'div',
      { class: 'modal-foot' },
      h('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, 'Cancel'),
      h('button', { class: 'btn primary', type: 'submit' }, editing ? 'Save' : 'Insert'),
    ),
  );
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  // The dialog sits above the page, so the maths keyboard opens in a layer inside it, and
  // the dialog moves to the top of the screen to stay clear of it.
  const keyboard = globalThis.mathVirtualKeyboard;
  const keyboardLayer = h('div', { class: 'math-keyboard' });
  const placeDialog = () => dialog.element.classList.toggle('with-keyboard', keyboard.visible);
  const dialog = modal(editing ? 'Edit maths' : 'Insert maths', form, {
    narrow: true,
    onclose: () => {
      keyboard.hide();
      keyboard.container = document.body;
      keyboard.removeEventListener('geometrychange', placeDialog);
      keyboard.removeEventListener('virtual-keyboard-toggle', placeDialog);
    },
  });
  dialog.element.append(keyboardLayer);
  keyboard.container = keyboardLayer;
  keyboard.addEventListener('geometrychange', placeDialog);
  keyboard.addEventListener('virtual-keyboard-toggle', placeDialog);
  field.focus();
}

/** Keep an image on the server, returning the name a card refers to it by. */
async function uploadImage(blob) {
  const res = await fetch('api/media', { method: 'POST', body: blob });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()).name;
}

// ---- Speech ---------------------------------------------------------------
// Uses the server's voice when there is one, otherwise the browser's own. Only a side's words
// are read: its maths and images are skipped.

const LANGUAGES = [
  ['pt-PT', 'Portuguese (Portugal)'],
  ['en-US', 'English (US)'],
  ['en-GB', 'English (UK)'],
];
let player = null;
let speechToken = 0;

const ttsUrl = (text, lang, save = true) => `api/tts?text=${encodeURIComponent(text)}&lang=${encodeURIComponent(lang)}${save ? '' : '&save=0'}`;
const serverVoice = () => store.storageInfo().voice;
const canSpeak = () => Boolean(serverVoice()) || 'speechSynthesis' in window;

function stopSpeaking() {
  speechToken++;
  player?.pause();
  player = null;
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}

/** Read `text` aloud. With `save` false, the server makes the audio without keeping it. */
async function speak(text, lang, rate = 1, save = true) {
  stopSpeaking();
  if (!text.trim()) return;
  if (!serverVoice()) {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang;
    utterance.rate = rate;
    utterance.voice = speechSynthesis.getVoices().find((v) => v.lang.replace('_', '-') === lang) ?? null;
    speechSynthesis.speak(utterance);
    return;
  }
  const token = speechToken;
  try {
    const res = await fetch(ttsUrl(text, lang, save));
    if (!res.ok) throw new Error(await res.text());
    const url = URL.createObjectURL(await res.blob());
    if (token !== speechToken) return; // moved on while the audio was loading
    player = new Audio(url);
    player.playbackRate = rate; // the browser keeps the pitch natural
    player.addEventListener('ended', () => URL.revokeObjectURL(url));
    await player.play();
  } catch (error) {
    // The browser refuses sound before the first click or key press; that is not an error.
    const blocked = error.name === 'NotAllowedError' || error.name === 'AbortError';
    if (token === speechToken && !blocked) toast(error.message || 'Could not play audio');
  }
}

/** Generate audio ahead of time so it plays instantly later. */
function prepareSpeech(text, lang) {
  if (serverVoice() && text.trim()) fetch(ttsUrl(text, lang)).catch(() => {});
}

// A reversed card shows the deck's back on its front, so each of its sides takes the
// language and the auto-play setting of the deck's other side.
const deckSide = (card, side) => (card.reversed ? (side === 'front' ? 'back' : 'front') : side);
const sideLang = (card, deck, side) => deck[`${deckSide(card, side)}Lang`];

/** Read the words on one side of a card aloud, in that side's language. */
const speakSideOf = (card, deck, side) => speak(speechText(card[side]), sideLang(card, deck, side), deck.speechRate, deck.saveAudio);

const speaksSide = (card, deck, side) => deck.speak === deckSide(card, side) || deck.speak === 'both';

/** Make a side's audio ahead of time, unless its deck keeps no audio to play later. */
function prepareSideSpeech(card, deck, side) {
  if (deck.saveAudio) prepareSpeech(speechText(card[side]), sideLang(card, deck, side));
}

function prepareCardSpeech(card) {
  const deck = store.deck(card.deckId);
  for (const side of ['front', 'back']) {
    if (speaksSide(card, deck, side)) prepareSideSpeech(card, deck, side);
  }
}

const speakButton = (card, deck, side) =>
  canSpeak() &&
  speechText(card[side]) !== '' &&
  h('button', { class: 'speak', type: 'button', title: `Listen to the ${side} (R)`, 'aria-label': `Listen to the ${side}`, onclick: () => speakSideOf(card, deck, side) }, icon('speaker'));

// ---- Theme ----------------------------------------------------------------

function applyTheme() {
  const saved = store.setting('theme');
  const system = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = saved ?? system;
}

function toggleTheme() {
  store.setSetting('theme', document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  applyTheme();
  render();
}

// ---- Dialogs --------------------------------------------------------------

function modal(title, content, { narrow = false, onclose } = {}) {
  const dialog = h(
    'dialog',
    { class: `modal ${narrow ? 'narrow' : ''}` },
    h(
      'div',
      { class: 'modal-body' },
      h('div', { class: 'modal-head' }, h('h2', null, title), iconButton('close', 'Close', () => close())),
      content,
    ),
  );
  // Clean up synchronously; the native `close` event (fired late, e.g. on Esc) is a fallback.
  const finish = () => {
    if (!dialog.isConnected) return;
    dialog.remove();
    onclose?.();
  };
  const close = () => {
    dialog.close();
    finish();
  };
  // Close on a backdrop click, but not when a drag merely ends outside the box.
  let pressedBackdrop = false;
  dialog.addEventListener('mousedown', (e) => (pressedBackdrop = e.target === dialog));
  dialog.addEventListener('click', (e) => pressedBackdrop && e.target === dialog && close());
  dialog.addEventListener('close', finish);
  document.body.append(dialog);
  dialog.showModal();
  return { close, element: dialog };
}

function confirmDialog({ title, message, confirmLabel = 'Delete' }) {
  return new Promise((resolve) => {
    let confirmed = false;
    const dialog = modal(
      title,
      [
        h('p', { class: 'message' }, message),
        h(
          'div',
          { class: 'modal-foot' },
          h('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, 'Cancel'),
          h(
            'button',
            {
              class: 'btn danger',
              type: 'button',
              onclick: () => {
                confirmed = true;
                dialog.close();
              },
            },
            confirmLabel,
          ),
        ),
      ],
      { narrow: true, onclose: () => resolve(confirmed) },
    );
  });
}

/** The quiet line naming who gave a deck, or nothing for a deck of your own. */
const deckFrom = (deck) => deck.assigned && h('span', { class: 'deck-from' }, `From ${deck.from}`);

/**
 * Create a deck, or change one's settings. A deck given by the admin shows only the settings
 * that are the user's own; its name and languages are the owner's.
 */
function openDeckDialog(deck) {
  const defaults = deck ?? store.DECK_DEFAULTS;
  const own = !deck || store.editable(deck.id);
  const name = h('input', { type: 'text', required: true, maxLength: 80, value: deck?.name ?? '', placeholder: 'e.g. Spanish vocabulary' });
  const newPerDay = h('input', { type: 'number', required: true, min: 0, max: 9999, step: 1, value: defaults.newPerDay });
  const retention = h('input', { type: 'number', required: true, min: 70, max: 97, step: 1, value: Math.round(defaults.retention * 100) });
  const easyInterval = h('input', { type: 'number', required: true, min: 0, max: 365, step: 1, value: defaults.easyInterval });
  const scheduler = h(
    'select',
    null,
    [['fsrs', 'FSRS'], ['sm2', 'SM-2 (older Anki default)']].map(([value, label]) =>
      h('option', { value, selected: value === defaults.scheduler }, label),
    ),
  );
  const speakSide = h(
    'select',
    null,
    [['none', 'Off'], ['front', 'Front'], ['back', 'Back'], ['both', 'Both sides']].map(([value, label]) =>
      h('option', { value, selected: value === defaults.speak }, label),
    ),
  );
  const languageSelect = (selected) =>
    h('select', null, LANGUAGES.map(([value, label]) => h('option', { value, selected: value === selected }, label)));
  const frontLang = languageSelect(defaults.frontLang);
  const backLang = languageSelect(defaults.backLang);

  const speechRate = h(
    'select',
    null,
    [[1, 'Normal'], [0.9, 'Slightly slower'], [0.8, 'Slower'], [0.7, 'Slow'], [0.6, 'Very slow']].map(([value, label]) =>
      h('option', { value, selected: value === defaults.speechRate }, label),
    ),
  );
  const saveAudio = h('input', { type: 'checkbox', checked: defaults.saveAudio });

  const form = h(
    'form',
    {
      onsubmit: (e) => {
        e.preventDefault();
        const values = {
          scheduler: scheduler.value,
          newPerDay: Number(newPerDay.value),
          retention: Number(retention.value) / 100,
          easyInterval: Number(easyInterval.value),
          ...(canSpeak() && { speak: speakSide.value, speechRate: Number(speechRate.value) }),
          ...(own && {
            name: name.value.trim(),
            ...(canSpeak() && { frontLang: frontLang.value, backLang: backLang.value }),
            ...(serverVoice() && { saveAudio: saveAudio.checked }),
          }),
        };
        if (own && !values.name) return name.focus();
        if (deck) store.updateDeck(deck.id, values);
        else store.createDeck(values);
        dialog.close();
      },
    },
    own && h('label', { class: 'field' }, h('span', null, 'Name'), name),
    h(
      'div',
      { class: 'field-row' },
      h('label', { class: 'field' }, h('span', null, 'New cards per day'), newPerDay),
      h('label', { class: 'field' }, h('span', null, 'Easy interval (days)'), easyInterval),
    ),
    h(
      'div',
      { class: 'field-row' },
      h('label', { class: 'field' }, h('span', null, 'Scheduling'), scheduler),
      h('label', { class: 'field' }, h('span', null, 'FSRS retention (%)'), retention),
    ),
    h('small', { class: 'field-note' }, 'Anki default grows each interval by the card\u2019s ease, as Anki does out of the box. FSRS matches Anki with FSRS switched on. You can switch at any time.'),
    canSpeak() && [
      h(
        'div',
        { class: 'field-row', style: 'margin-top: 16px' },
        h('label', { class: 'field' }, h('span', null, 'Auto-play audio'), speakSide),
        h('label', { class: 'field' }, h('span', null, 'Speaking speed'), speechRate),
      ),
      own &&
        h(
          'div',
          { class: 'field-row' },
          h('label', { class: 'field' }, h('span', null, 'Front language'), frontLang),
          h('label', { class: 'field' }, h('span', null, 'Back language'), backLang),
        ),
      h('small', { class: 'field-note' }, 'Auto-play reads a side aloud when it appears, in that side’s language. You can always play either side with its speaker button. Maths is read out in words, in English; images are skipped.'),
      own && serverVoice() && [
        h('label', { class: 'check', style: 'margin-top: 12px' }, saveAudio, 'Keep the audio made for this deck'),
        h('small', { class: 'field-note' }, 'Turn this off for decks that are mostly maths: audio is then made each time it plays instead of being kept, and “npm run cache-voice” leaves the deck out.'),
      ],
    ],
    h(
      'div',
      { class: 'modal-foot' },
      h('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, 'Cancel'),
      h('button', { class: 'btn primary', type: 'submit' }, deck ? 'Save' : 'Create deck'),
    ),
  );
  const dialog = modal(deck ? 'Deck settings' : 'New deck', form, { narrow: true, onclose: render });
  (own ? name : newPerDay).focus();
}

/**
 * Put `text` in a text box in place of `start` to `end` (the selection unless given), on a line
 * of its own when `ownLine` is set.
 */
function insertText(textarea, text, { start = textarea.selectionStart, end = textarea.selectionEnd, ownLine = false } = {}) {
  const { value } = textarea;
  const before = ownLine && start && value[start - 1] !== '\n' ? '\n' : '';
  const after = ownLine && end < value.length && value[end] !== '\n' ? '\n' : '';
  textarea.setRangeText(before + text + after, start, end, 'end');
  textarea.focus();
  textarea.dispatchEvent(new Event('input'));
}

const insertAtCursor = (textarea, text) => insertText(textarea, text, { ownLine: true });

/**
 * The editor for one side of a card: its text box, buttons to add maths and images, paste or
 * drop for images, and a preview of the side once it holds maths or images. Clicking maths in
 * the preview, or pressing Maths with the cursor in some, opens it in the equation editor.
 */
function sideEditor(label, textarea) {
  const preview = h('div', { class: 'side-preview', 'aria-live': 'polite' });
  const editMath = (span) =>
    openMathDialog({ ...span, editing: true }, (math, display) =>
      insertText(textarea, mathToken(math, display), { start: span.start, end: span.end, ownLine: display && !span.display }),
    );
  const update = () => {
    preview.hidden = !hasRichContent(textarea.value);
    if (!preview.hidden) {
      preview.replaceChildren(...rich(textarea.value, (n) => editMath(mathSpans(textarea.value)[n])));
      markOverflow(preview);
    }
  };
  const mathButton = () => {
    const { selectionStart: start, selectionEnd: end } = textarea;
    const inside = mathSpans(textarea.value).find((span) => span.start <= start && end <= span.end && start < span.end);
    if (inside) return editMath(inside);
    openMathDialog({}, (math, display) => insertText(textarea, mathToken(math, display), { start, end, ownLine: display }));
  };
  const isImage = (file) => file.type.startsWith('image/');
  const addImages = async (files) => {
    try {
      const names = [];
      for (const file of files.filter(isImage)) names.push(await uploadImage(file));
      if (names.length) insertAtCursor(textarea, names.map(imageToken).join('\n'));
    } catch (error) {
      toast(error.message || 'Could not add that image.');
    }
  };
  const picker = h('input', {
    type: 'file',
    accept: 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml',
    multiple: true,
    hidden: true,
    onchange: () => {
      addImages([...picker.files]);
      picker.value = '';
    },
  });
  textarea.setAttribute('aria-label', label);
  textarea.addEventListener('input', update);
  textarea.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files ?? [])].filter(isImage);
    if (!files.length) return;
    e.preventDefault();
    addImages(files);
  });
  textarea.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
  });
  textarea.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files ?? [])].filter(isImage);
    if (!files.length) return;
    e.preventDefault();
    textarea.focus();
    addImages(files);
  });
  update();
  return h(
    'div',
    { class: 'field' },
    h(
      'div',
      { class: 'field-head' },
      h('span', null, label),
      h(
        'div',
        { class: 'field-tools' },
        h('button', { class: 'btn ghost sm', type: 'button', title: `Write maths on the ${label.toLowerCase()}, or edit the maths at the cursor`, onclick: mathButton }, icon('sigma'), 'Maths'),
        h('button', { class: 'btn ghost sm', type: 'button', title: `Add an image to the ${label.toLowerCase()}`, onclick: () => picker.click() }, icon('image'), 'Add image'),
      ),
      picker,
    ),
    textarea,
    preview,
  );
}

function openCardDialog({ card, deckId }) {
  if (!store.editable(card?.deckId ?? deckId)) return;
  const front = h('textarea', { required: true, value: card?.front ?? '', placeholder: 'Question or prompt' });
  const back = h('textarea', { required: true, value: card?.back ?? '', placeholder: 'Answer' });
  const deckSelect = h(
    'select',
    null,
    store.decks().filter((d) => store.editable(d.id)).map((d) => h('option', { value: d.id, selected: d.id === (card?.deckId ?? deckId) }, d.name)),
  );
  // Only a card that has never been studied can wait on the reserve.
  const reserved = h('input', { type: 'checkbox', checked: Boolean(card?.reserved) });
  const canReserve = !card || card.state === State.New;
  const note = h('span', { class: 'note' }, 'Ctrl + Enter to save');
  // Topics belong to a deck, so the choices follow the deck chosen.
  const currentTopic = (deck) => (card && deck && card.deckId === deck.id ? effectiveTopic(deck, card) : '');
  const topicSelect = h('select', { 'aria-label': 'Topic' });
  const topicField = h('label', { class: 'field' }, h('span', null, 'Topic'), topicSelect);
  const fillTopics = () => {
    const d = store.deck(deckSelect.value);
    topicSelect.replaceChildren(...topicChoices(d, currentTopic(d)).flat(Infinity).filter(Boolean));
    topicField.hidden = !(d?.topics ?? []).length;
  };
  deckSelect.addEventListener('change', fillTopics);
  fillTopics();

  const submitOnCtrlEnter = (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      form.requestSubmit();
    }
  };
  front.addEventListener('keydown', submitOnCtrlEnter);
  back.addEventListener('keydown', submitOnCtrlEnter);

  const form = h(
    'form',
    {
      onsubmit: (e) => {
        e.preventDefault();
        const values = { front: front.value.trim(), back: back.value.trim() };
        if (!values.front) return front.focus();
        if (!values.back) return back.focus();
        const topic = topicField.hidden ? '' : topicSelect.value;
        if (card) {
          const wasIn = currentTopic(store.deck(deckSelect.value));
          const moved = deckSelect.value !== card.deckId;
          const chosen = topic !== wasIn || (moved && topic);
          store.updateCard(card.id, { ...values, deckId: deckSelect.value, reserved: (canReserve && reserved.checked) || undefined });
          if (chosen) store.setCardsTopic([card.id], topic || null, Date.now());
          // A topic from the old deck means nothing in the new one.
          else if (moved && card.topic) store.clearCardTopic(card.id, Date.now());
          prepareCardSpeech(store.card(card.id));
          dialog.close();
          return;
        }
        // Stay open so several cards can be added in a row.
        const added = store.addCard(deckSelect.value, values.front, values.back, Date.now(), { reserved: reserved.checked });
        if (topic) store.setCardsTopic([added.id], topic, Date.now());
        else requestSort(deckSelect.value);
        prepareCardSpeech(added);
        front.value = back.value = '';
        for (const box of [front, back]) box.dispatchEvent(new Event('input'));
        note.textContent = reserved.checked ? 'Card added to the reserve' : 'Card added';
        note.className = 'note ok';
        front.focus();
        render();
      },
    },
    sideEditor('Front', front),
    sideEditor('Back', back),
    h('small', { class: 'field-note', style: 'margin: -6px 0 14px' }, 'Paste or drop images into a side. Press Maths to write an equation, or click one in the preview to change it. Maths can also be typed as LaTeX: \\( x^2 \\) within a line, \\[ x^2 \\] on its own line.'),
    h('label', { class: 'field' }, h('span', null, 'Deck'), deckSelect),
    topicField,
    canReserve && h('label', { class: 'check' }, reserved, 'Keep on reserve, out of study until pulled in'),
    h(
      'div',
      { class: 'modal-foot' },
      note,
      h('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, card ? 'Cancel' : 'Done'),
      h('button', { class: 'btn primary', type: 'submit' }, card ? 'Save' : 'Add card'),
    ),
  );
  const dialog = modal(card ? 'Edit card' : 'Add card', form, { onclose: render });
  front.focus();
}

/** How many people have been given a deck and still have it. Only an admin gives decks. */
async function recipientsOf(deckId) {
  if (account?.role !== 'admin') return 0;
  const given = await api.admin.decks();
  return given.find((d) => d.id === deckId)?.recipients.filter((r) => r.active).length ?? 0;
}

async function removeDeck(deck) {
  const n = store.cardsIn(deck.id).length;
  let people;
  try {
    people = await recipientsOf(deck.id);
  } catch {
    toast('Could not check who has this deck. Try again when you are online.');
    return;
  }
  const ok = await confirmDialog({
    title: `Delete “${deck.name}”?`,
    message: people
      ? `${people === 1 ? '1 person has' : `${people.toLocaleString()} people have`} this deck. Deleting it removes it and their progress.`
      : n
        ? `This deck and its ${plural(n, 'card')} will be permanently deleted.`
        : 'This deck will be permanently deleted.',
    confirmLabel: 'Delete deck',
  });
  if (!ok) return;
  store.deleteDeck(deck.id);
  if (location.hash !== '#/') location.hash = '#/';
  else render();
}

async function removeCards(ids) {
  const one = ids.length === 1;
  const ok = await confirmDialog({
    title: `Delete ${plural(ids.length, 'card')}?`,
    message: `${one ? 'This card and its' : 'These cards and their'} review history will be permanently deleted.`,
    confirmLabel: `Delete ${plural(ids.length, 'card')}`,
  });
  if (!ok) return;
  const deleted = store.deleteCards(ids);
  selected = new Set();
  toast(`${plural(deleted, 'card')} deleted`);
  render();
}

/** Put a reversed copy of each card on the reserve, and leave the copies ticked, ready to be moved. */
function addReversedCards(ids) {
  const added = store.addReversed(ids);
  const skipped = ids.length - added.length;
  const already = skipped ? `${skipped.toLocaleString()} already had one` : '';
  if (added.length) {
    selected = new Set(added.map((card) => card.id));
    toast(`${plural(added.length, 'reversed card')} added to the reserve${already && `, ${already}`}`);
  } else {
    toast(skipped === 1 ? 'This card already has a reversed version' : 'These cards already have reversed versions');
  }
  render();
}

/** Put cards back on the reserve, after asking first if that wipes out their progress. */
async function returnCardsToReserve(ids) {
  const studied = ids.map(store.card).filter((card) => card && !card.reserved && card.state !== State.New).length;
  if (studied) {
    const one = studied === 1;
    const which = ids.length === 1 ? 'This card has' : one ? 'One of these cards has' : `${studied.toLocaleString()} of these cards have`;
    const ok = await confirmDialog({
      title: `Put ${plural(ids.length, 'card')} back on reserve?`,
      message: `${which} already been studied. ${one ? 'Its' : 'Their'} progress will be reset, and ${one ? 'it starts' : 'they start'} over as new when pulled in again.`,
      confirmLabel: 'Put back on reserve',
    });
    if (!ok) return;
  }
  const moved = store.returnToReserve(ids);
  toast(`${plural(moved, 'card')} put back on reserve`);
  render();
}

async function removeCard(card) {
  const ok = await confirmDialog({
    title: 'Delete this card?',
    message: 'The card and its review history will be permanently deleted.',
    confirmLabel: 'Delete card',
  });
  if (!ok) return;
  store.deleteCard(card.id);
  render();
}

// ---- Import cards from a spreadsheet ------------------------------------------

const columnName = (i) => (i >= 26 ? columnName(Math.floor(i / 26) - 1) : '') + String.fromCharCode(65 + (i % 26));
const cardKey = (text) => text.trim().toLowerCase();

/** Work out which rows become cards, and why the others are left out. */
function planImport(rows, { front, back, header, skipExisting, existing }) {
  const seen = new Set(skipExisting ? existing : []);
  const plan = { cards: [], incomplete: 0, duplicates: 0 };
  for (const row of header ? rows.slice(1) : rows) {
    const pair = [row[front] ?? '', row[back] ?? ''];
    if (!pair[0] || !pair[1]) plan.incomplete++;
    else if (skipExisting && seen.has(cardKey(pair[0]))) plan.duplicates++;
    else {
      seen.add(cardKey(pair[0]));
      plan.cards.push(pair);
    }
  }
  return plan;
}

/**
 * Keep the pictures read from a spreadsheet on the server, and point the cells at the stored
 * copies. A picture the server will not take, such as a drawing saved by Excel as EMF, is left
 * out, as is any picture whose upload fails. Returns the rows and how many were left out.
 */
async function storeSheetImages(rows, images) {
  const stored = new Map();
  for (const [path, bytes] of images) {
    stored.set(path, await uploadImage(new Blob([bytes])).catch(() => null));
  }
  const cells = rows.map((row) =>
    row.map((cell) =>
      cell
        .replace(/\[image:([^\]\s]+)\]/g, (_, path) => (stored.get(path) ? imageToken(stored.get(path)) : ''))
        .trim(),
    ),
  );
  return { rows: cells, skipped: [...stored.values()].filter((name) => !name).length };
}

// ---- Sorting into topics (admin, own decks) -------------------------------

// Decks being sorted now; one poll loop each. Sorting runs in the background, and studying carries on.
const sorting = new Set();
const proposing = new Set();
const SORT_LIMIT = 15 * 60 * 1000;
let sortingOffShown = false;
const newId = () => globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

const sortingOff = () => {
  if (sortingOffShown) return;
  sortingOffShown = true;
  toast('Sorting is off: no API key on the server');
};

/** Only the admin's own decks are ever sorted. */
const canSort = (deckId) => account?.role === 'admin' && !!store.deck(deckId) && store.editable(deckId);

/**
 * Sort a deck's unsorted cards into its topics, and wait for it to finish. Quiet unless it fails.
 * A deck with no topics is never sorted this way; it gets a proposal first. With `started`,
 * the server has already begun (after Approve) and only the waiting is done here.
 */
async function requestSort(deckId, { started = false } = {}) {
  if (!canSort(deckId) || sorting.has(deckId)) return;
  if (!started && !(store.deck(deckId).topics ?? []).length) return;
  sorting.add(deckId);
  try {
    try {
      await store.flush();
    } catch {
      toast('Could not save before sorting. Try again in a moment.');
      return;
    }
    const before = store.unsortedCount(deckId);
    if (!started) {
      try {
        await api.admin.sort(deckId);
      } catch (error) {
        if (error.message === 'no-sorter') sortingOff();
        else toast('Could not start sorting. Try again in a moment.');
        return;
      }
    }
    render();
    let failures = 0;
    const giveUp = Date.now() + SORT_LIMIT;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      // Signed out, or the deck is gone: nothing left to wait for.
      if (!canSort(deckId)) return;
      if (Date.now() > giveUp) {
        toast('Sorting is taking a long time. Check back later.');
        return;
      }
      try {
        if (!(await api.admin.sortStatus(deckId)).running) break;
        failures = 0;
      } catch {
        if (++failures >= 3) {
          toast('Lost track of the sort. Reload to see where it got to.');
          return;
        }
      }
    }
    try {
      await store.refresh();
    } catch {
      toast('Sorted, but could not reload the deck. Reload the page.');
      return;
    }
    const done = before - store.unsortedCount(deckId);
    toast(done > 0 ? `Sorted ${plural(done, 'card')}` : 'Sorting finished');
  } catch {
    toast('Sorting stopped. Try again in a moment.');
  } finally {
    sorting.delete(deckId);
    render();
  }
}

/** The deck's saved proposal for groups and topics, or a new one. The AI call can take a while. */
async function startProposal(deck) {
  if (proposing.has(deck.id)) return;
  proposing.add(deck.id);
  render();
  try {
    await store.flush();
    let proposal;
    try {
      proposal = await api.admin.proposal(deck.id);
    } catch (error) {
      if (error.message !== 'not-found') throw error;
      proposal = await api.admin.propose(deck.id);
    }
    openProposalDialog(deck, proposal);
  } catch (error) {
    if (error.message === 'no-sorter') sortingOff();
    else toast('Could not make a proposal. Try again in a moment.');
  } finally {
    proposing.delete(deck.id);
    render();
  }
}

/** Review a proposed set of groups and topics, change it, and approve it. No card moves before Approve. */
function openProposalDialog(deck, proposal) {
  const groups = proposal.groups.map((g) => ({ ...g }));
  const topics = proposal.topics.map((t) => ({ ...t, groupId: groups.some((g) => g.id === t.groupId) ? t.groupId : null }));
  const box = h('div', { class: 'topics-edit' });
  const note = h('span', { class: 'note' });
  const nameInput = (item, label) =>
    h('input', { type: 'text', value: item.name, maxlength: 60, 'aria-label': label, oninput: (e) => (item.name = e.target.value) });
  const topicRow = (t) =>
    h(
      'div',
      { class: 'topic-row' },
      nameInput(t, 'Topic name'),
      h(
        'select',
        { 'aria-label': 'Group of this topic', onchange: (e) => ((t.groupId = e.target.value || null), draw()) },
        h('option', { value: '', selected: !t.groupId }, 'No group'),
        groups.map((g) => h('option', { value: g.id, selected: g.id === t.groupId }, g.name || 'Unnamed group')),
      ),
      iconButton('trash', 'Delete topic', () => (topics.splice(topics.indexOf(t), 1), draw()), 'danger'),
    );
  function draw() {
    box.replaceChildren(
      ...groups.map((g) =>
        h(
          'div',
          { class: 'topic-group' },
          h(
            'div',
            { class: 'topic-group-head' },
            nameInput(g, 'Group name'),
            iconButton(
              'trash',
              'Delete group, its topics stay without a group',
              () => {
                groups.splice(groups.indexOf(g), 1);
                topics.forEach((t) => t.groupId === g.id && (t.groupId = null));
                draw();
              },
              'danger',
            ),
          ),
          topics.filter((t) => t.groupId === g.id).map(topicRow),
        ),
      ),
      topics.some((t) => !t.groupId) && h('div', { class: 'topic-group' }, h('div', { class: 'topic-group-head' }, h('strong', null, 'No group')), topics.filter((t) => !t.groupId).map(topicRow)),
      h('button', { class: 'btn', type: 'button', onclick: () => (groups.push({ id: newId(), name: 'New group' }), draw()) }, icon('plus'), 'Add group'),
    );
  }
  draw();
  const approve = h('button', { class: 'btn primary', type: 'submit' }, 'Approve and sort');
  const dialog = modal(
    `Topics for ${deck.name}`,
    h(
      'form',
      {
        onsubmit: async (e) => {
          e.preventDefault();
          for (const item of [...groups, ...topics]) item.name = item.name.trim();
          if (!topics.length) return void (note.textContent = 'Keep at least one topic.');
          if ([...groups, ...topics].some((item) => !item.name || item.name.length > 60)) return void (note.textContent = 'Every name needs 1 to 60 characters.');
          approve.disabled = true;
          try {
            await api.admin.approve(deck.id, { groups: groups.map(({ id, name }) => ({ id, name })), topics: topics.map(({ id, name, groupId }) => ({ id, name, groupId })) });
          } catch (error) {
            approve.disabled = false;
            if (error.message === 'no-sorter') sortingOff();
            else note.textContent = 'Could not approve. Try again in a moment.';
            return;
          }
          dialog.close();
          toast('Sorting started. You can keep studying.');
          requestSort(deck.id, { started: true });
        },
      },
      h('p', { class: 'message', style: 'margin-bottom: 12px' }, 'This is how Dohrao would sort the deck. Nothing moves until you approve. Rename, move or delete anything first.'),
      box,
      h('div', { class: 'modal-foot' }, note, h('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, 'Cancel'), approve),
    ),
  );
}

/** How many of a deck's topics sit outside any group, counted only when the deck has groups. */
function looseTopics(deck) {
  const groups = deck?.groups ?? [];
  if (!groups.length) return 0;
  return (deck.topics ?? []).filter((t) => !groups.some((g) => g.id === t.groupId)).length;
}

/** On a deck page: the unsorted count with Sort now, or the way in to a first sort. */
/** While the deck's cards are being sorted into topics, a line saying so; otherwise null. */
function sortStatus(deck) {
  if (sorting.has(deck.id)) return h('p', { class: 'message', role: 'status' }, 'Sorting cards into topics. You can keep studying.');
  if (proposing.has(deck.id)) return h('p', { class: 'message', role: 'status' }, 'Reading the cards to suggest topics. This can take a minute.');
  return null;
}

/** On a wide screen, sorting into topics is an item in the deck's ⋯ menu, when there is anything to sort. */
function sortAction(deck) {
  if (!canSort(deck.id) || sorting.has(deck.id) || proposing.has(deck.id)) return null;
  const unsorted = store.unsortedCount(deck.id);
  if ((deck.topics ?? []).length > 0) {
    if (unsorted > 0) return h('button', { type: 'button', onclick: () => requestSort(deck.id) }, icon('check'), `Sort ${unsorted.toLocaleString()} unsorted`);
    return looseTopics(deck) > 0 ? h('button', { type: 'button', onclick: () => requestSort(deck.id) }, icon('check'), 'Sort now') : null;
  }
  return store.cardsIn(deck.id).length > 0 ? h('button', { type: 'button', onclick: () => startProposal(deck) }, icon('check'), 'Sort into topics') : null;
}

function sortBar(deck) {
  if (!canSort(deck.id)) return null;
  const hasTopics = (deck.topics ?? []).length > 0;
  const unsorted = store.unsortedCount(deck.id);
  const loose = looseTopics(deck);
  const status = sortStatus(deck);
  if (status) return status;
  if (hasTopics && (unsorted > 0 || loose > 0)) {
    const what = unsorted > 0 ? `${unsorted.toLocaleString()} unsorted` : `${plural(loose, 'topic')} without a group`;
    return h('p', { class: 'message' }, `${what} · `, h('button', { class: 'btn', type: 'button', onclick: () => requestSort(deck.id) }, 'Sort now'));
  }
  if (!hasTopics && store.cardsIn(deck.id).length > 0) {
    return h('p', { class: 'message' }, h('button', { class: 'btn', type: 'button', onclick: () => startProposal(deck) }, 'Sort this deck into topics'));
  }
  return null;
}

function pickImportFile(deck, toReserve = false) {
  const input = h('input', {
    type: 'file',
    accept: '.xlsx,.csv,.tsv,.txt',
    onchange: async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        const images = new Map();
        let rows = await parseSpreadsheet(await file.arrayBuffer(), file.name, images);
        if (!rows.length) throw new Error('That file has no rows to import.');
        if (images.size) {
          const result = await storeSheetImages(rows, images);
          rows = result.rows;
          if (result.skipped) toast(`${plural(result.skipped, 'picture')} in a format Dohrao cannot show will be left out`);
        }
        openImportDialog(deck, file.name, rows, toReserve);
      } catch (error) {
        toast(error.message || 'Could not read that file.');
      }
    },
  });
  input.click();
}

function openImportDialog(deck, fileName, rows, toReserve = false) {
  const width = Math.max(...rows.map((row) => row.length));
  const existing = store.cardsIn(deck.id).map((card) => cardKey(card.front));
  const columnSelect = (selected) =>
    h(
      'select',
      { onchange: () => update() },
      Array.from({ length: width }, (_, i) => {
        const sample = rows.find((row) => row[i])?.[i] ?? 'empty';
        const words = sample.replace(/\[image:[^\]\s]+\]/g, '(image)');
        const label = `${columnName(i)}: ${words.length > 28 ? `${words.slice(0, 28)}…` : words}`;
        return h('option', { value: i, selected: i === selected }, label);
      }),
    );
  const front = columnSelect(0);
  const back = columnSelect(Math.min(1, width - 1));
  const header = h('input', { type: 'checkbox', onchange: () => update() });
  const skipExisting = h('input', { type: 'checkbox', checked: true, onchange: () => update() });
  const reserved = h('input', { type: 'checkbox', checked: toReserve });
  // A file named like a topic file puts all its cards in that topic.
  const topicKey = topicKeyFromFileName(fileName);
  const preview = h('div', { class: 'import-preview' });
  const summary = h('p', { class: 'import-summary' });
  const submit = h('button', { class: 'btn primary', type: 'submit' });

  const plan = () =>
    planImport(rows, {
      front: Number(front.value),
      back: Number(back.value),
      header: header.checked,
      skipExisting: skipExisting.checked,
      existing,
    });

  function update() {
    const { cards, incomplete, duplicates } = plan();
    const sameColumn = front.value === back.value;
    const table = h(
      'table',
      null,
      h('thead', null, h('tr', null, h('th', null, 'Front'), h('th', null, 'Back'))),
      h('tbody', null, cards.slice(0, 5).map(([f, b]) => h('tr', null, h('td', null, rich(f)), h('td', null, rich(b))))),
    );
    const more = cards.length > 5 ? [h('div', { class: 'import-more' }, `and ${cards.length - 5} more`)] : [];
    preview.replaceChildren(table, ...more);
    preview.hidden = !cards.length;
    const skipped = [
      incomplete && `${plural(incomplete, 'row')} missing a front or back`,
      duplicates && `${plural(duplicates, 'duplicate')}`,
    ].filter(Boolean);
    summary.textContent = sameColumn
      ? 'Front and back are set to the same column. Choose two different columns.'
      : (cards.length ? '' : 'Nothing to import. ') + (skipped.length ? `Skipping ${skipped.join(' and ')}.` : '');
    summary.hidden = !summary.textContent;
    submit.textContent = cards.length ? `Import ${plural(cards.length, 'card')}` : 'Import';
    submit.disabled = !cards.length || sameColumn;
  }

  const form = h(
    'form',
    {
      onsubmit: (e) => {
        e.preventDefault();
        const { cards } = plan();
        if (!cards.length) return;
        const hadTopic = !!topicKey && (store.deck(deck.id).topics ?? []).some((t) => t.key === topicKey);
        store.addCards(deck.id, cards, Date.now(), { reserved: reserved.checked, ...(topicKey && { topicKey }) });
        dialog.close();
        if (!topicKey) requestSort(deck.id);
        else if (!hadTopic) {
          // A new topic from a file that fits no group yet: the sorter puts it in one.
          const after = store.deck(deck.id);
          const made = (after.topics ?? []).find((t) => t.key === topicKey);
          if (made && made.groupId == null && (after.groups ?? []).length) requestSort(deck.id);
        }
        toast(`Imported ${plural(cards.length, 'card')} into ${reserved.checked ? `the reserve of ${deck.name}` : deck.name}`);
      },
    },
    h('p', { class: 'message', style: 'margin-bottom: 16px' }, `${fileName}: ${plural(rows.length, 'row')}${width > 26 ? '' : `, ${plural(width, 'column')}`}`),
    h(
      'div',
      { class: 'field-row' },
      h('label', { class: 'field' }, h('span', null, 'Front'), front),
      h('label', { class: 'field' }, h('span', null, 'Back'), back),
    ),
    topicKey && h('p', { class: 'message', style: 'margin-bottom: 12px' }, `Cards go into the topic ${readableTopicName(topicKey)}`),
    h('label', { class: 'check' }, header, 'The first row is a header, skip it'),
    h('label', { class: 'check' }, skipExisting, 'Skip cards already in this deck'),
    h('label', { class: 'check' }, reserved, 'Put these cards on reserve, to pull in when you want them'),
    preview,
    summary,
    h(
      'div',
      { class: 'modal-foot' },
      h('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, 'Cancel'),
      submit,
    ),
  );
  update();
  const dialog = modal(`Import into ${deck.name}`, form, { onclose: render });
  submit.focus();
}

// ---- Import decks from Anki ---------------------------------------------------

function pickAnkiFile() {
  const input = h('input', {
    type: 'file',
    accept: '.apkg,.colpkg',
    onchange: async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        // The whole package goes, as the server stores the images the cards show.
        const res = await fetch('api/anki', { method: 'POST', body: file });
        if (!res.ok) throw new Error(await res.text());
        openAnkiDialog(file.name, await res.json());
      } catch (error) {
        toast(error.message || 'Could not read that file.');
      }
    },
  });
  input.click();
}

function openAnkiDialog(fileName, { decks, suspended, blank, sound, missingImages }) {
  const known = store.ankiCardIds();
  const incoming = decks
    .map((deck) => ({ ...deck, cards: deck.cards.filter((card) => !known.has(card.ankiId)) }))
    .filter((deck) => deck.cards.length);
  const total = incoming.reduce((sum, deck) => sum + deck.cards.length, 0);
  // Cards already here are skipped; say which decks hold them, as a file can reuse another deck's ids.
  const duplicates = store.ankiDuplicates(decks);
  const fresh = incoming.reduce((sum, deck) => sum + deck.cards.filter((card) => card.state === State.New).length, 0);
  const reserved = h('input', { type: 'checkbox' });

  const breakdown = (cards) => {
    const count = (...states) => cards.filter((card) => states.includes(card.state)).length;
    return [
      [count(State.New), 'new'],
      [count(State.Learning, State.Relearning), 'learning'],
      [count(State.Review), 'in review'],
    ]
      .filter(([n]) => n)
      .map(([n, label]) => `${n} ${label}`)
      .join(', ');
  };
  const notes = [
    ...duplicates.map(({ deck, cards }) => `${plural(cards, 'card')} ${cards === 1 ? 'is' : 'are'} already in “${deck}” and will be skipped.`),
    suspended && `${plural(suspended, 'suspended card')} will be left out.`,
    blank && `${plural(blank, 'card')} with no text on the front will be left out.`,
    sound && 'Audio is not imported. Images and maths are.',
    missingImages && `${plural(missingImages, 'image')} named on cards ${missingImages === 1 ? 'is' : 'are'} missing from the file or in a format Dohrao cannot show, and will be left out.`,
    ...incoming
      .filter((deck) => deck.custom.length)
      .map((deck) => `“${deck.name}” has its own ${deck.custom.join(', ')} in Anki. Dohrao uses Anki’s defaults for these, so some intervals will differ.`),
  ].filter(Boolean);

  const form = h(
    'form',
    {
      onsubmit: (e) => {
        e.preventDefault();
        const touched = new Set();
        const added = store.importAnkiDecks(incoming, Date.now(), { reserved: reserved.checked, touched });
        dialog.close();
        for (const id of touched) requestSort(id);
        const onReserve = !reserved.checked ? '' : fresh === added ? ' onto the reserve' : `, ${fresh.toLocaleString()} of them on reserve`;
        toast(`Imported ${plural(added, 'card')} from Anki${onReserve}`);
      },
    },
    h(
      'p',
      { class: 'message' },
      total ? `${fileName}: every card keeps its due date, interval and ease from Anki.` : `${fileName}: nothing new to import.`,
    ),
    total > 0 &&
      h(
        'div',
        { class: 'import-preview' },
        h(
          'table',
          null,
          h('thead', null, h('tr', null, h('th', null, 'Deck'), h('th', null, 'Cards'))),
          h('tbody', null, incoming.map((deck) => h('tr', null, h('td', null, deck.name), h('td', null, breakdown(deck.cards))))),
        ),
      ),
    fresh > 0 &&
      h(
        'label',
        { class: 'check', style: 'margin-top: 14px' },
        reserved,
        fresh === total ? 'Put these cards on reserve, to pull in when you want them' : `Put the ${plural(fresh, 'new card')} on reserve, to pull in when you want them`,
      ),
    notes.map((note) => h('p', { class: 'import-summary' }, note)),
    h(
      'div',
      { class: 'modal-foot' },
      h('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, 'Cancel'),
      h('button', { class: 'btn primary', type: 'submit', disabled: !total }, total ? `Import ${plural(total, 'card')}` : 'Import'),
    ),
  );
  const dialog = modal('Import from Anki', form, { onclose: render });
}

// ---- Backup ---------------------------------------------------------------

function exportBackup() {
  const url = URL.createObjectURL(new Blob([store.exportData()], { type: 'application/json' }));
  h('a', { href: url, download: `recall-backup-${new Date().toISOString().slice(0, 10)}.json` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function loadSampleDeck() {
  const deck = store.createDeck({ name: 'How memory works' });
  const cards = [
    ['What is spaced repetition?', 'Reviewing material at increasing intervals, just before you would forget it.'],
    ['What does FSRS stand for?', 'Free Spaced Repetition Scheduler'],
    ['In FSRS, what is “stability”?', 'The number of days it takes for your chance of recalling a card to fall to 90%.'],
    ['In FSRS, what is “retrievability”?', 'The probability that you can recall a card right now.'],
    ['In FSRS, what is “difficulty”?', 'A value from 1 to 10 describing how hard a card is to remember. Harder cards gain stability more slowly.'],
    ['What is the testing effect?', 'Actively recalling information strengthens memory more than re-reading it.'],
  ];
  cards.forEach(([front, back], i) => store.addCard(deck.id, front, back, Date.now() + i));
  render();
}

// ---- Views ----------------------------------------------------------------

function storageChip() {
  if (store.storageInfo().ok) return h('span', { class: 'save-chip', title: 'Your changes are saved' }, icon('check'), h('span', null, 'Saved'));
  return h(
    'span',
    { class: 'save-chip error', title: 'Cannot reach Dohrao. Your changes are kept on this device and are sent when the connection is back.' },
    icon('alert'),
    h('span', null, 'Not saved, retrying'),
  );
}

/** Log out after sending what is left; with answers unsent or no connection, stay signed in and say so. */
async function logOut() {
  try {
    await store.logOut();
  } catch (error) {
    // The session had already ended: start again at the login screen, keeping unsent changes.
    if (error.message === 'signed-out') return location.reload();
    if (error.message === 'unsaved') toast("Some answers haven't been saved yet. Try again when you're online.");
    else toast('Could not log out without a connection. Try again when you are online.');
    return;
  }
  account = null;
  history.replaceState(null, '', location.pathname + location.search);
  render();
}

/** The signed-in user's name, opening Admin (for admins), Export backup on phones, and Log out. */
function accountMenu() {
  const name = account?.name ?? 'Account';
  const el = h(
    'details',
    { class: 'menu account' },
    h('summary', { title: name, 'aria-label': `Account: ${name}` }, icon('user'), h('span', { class: 'account-name' }, name)),
    h(
      'div',
      { class: 'menu-items', onclick: () => el.removeAttribute('open') },
      account?.username && h('div', { class: 'menu-who' }, h('b', null, account.name), h('span', null, account.username)),
      account?.role === 'admin' && h('a', { href: '#/admin' }, icon('shield'), 'Admin'),
      h('button', { class: 'phone-only', type: 'button', onclick: exportBackup }, icon('download'), 'Export backup'),
      h('button', { type: 'button', onclick: logOut }, icon('logout'), 'Log out'),
    ),
  );
  return el;
}

/** The app's name, Dohrao ("revise!"), with its Urdu spelling beside it. */
function brand(tag, attrs = {}) {
  return h(tag, { ...attrs, class: 'brand' }, 'Dohrao', h('span', { class: 'brand-ur', lang: 'ur', dir: 'rtl' }, 'دہراؤ'));
}

/** The top bar; `title` is what a phone shows on its left in place of the app's name. */
function topbar(title) {
  const dark = document.documentElement.dataset.theme === 'dark';
  const here = location.hash.split('/')[1] || '';
  // On a phone the same links become a tab bar along the bottom, each with its icon.
  const tab = (path, label, glyph) =>
    h('a', { href: `#/${path}`, 'aria-current': (path === here || (path === '' && here === 'deck')) && 'page' }, icon(glyph), h('span', null, label));
  return h(
    'header',
    { class: 'topbar' },
    brand('a', { href: '#/' }),
    title && h('span', { class: 'topbar-title phone-only' }, title),
    h('nav', { class: 'nav', 'aria-label': 'Main' }, tab('', 'Decks', 'decks'), tab('upcoming', 'Upcoming', 'calendar'), tab('stats', 'Statistics', 'chart')),
    h('span', { class: 'spacer' }),
    storageChip(),
    // On a phone, Export backup moves into the account menu so the bar fits.
    iconButton('download', 'Export backup', exportBackup, 'wide-only'),
    iconButton(dark ? 'sun' : 'moon', dark ? 'Light theme' : 'Dark theme', toggleTheme),
    accountMenu(),
  );
}

const NUMBER_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
const weekdayLong = new Intl.DateTimeFormat(undefined, { weekday: 'long' });

/** "Thursday evening": the day, and the part of it, that the home page greets. */
function partOfDay(now) {
  const d = new Date(now);
  const hour = d.getHours();
  const part = hour < 4 ? 'night' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  // Days roll over at 4am, so the small hours still belong to the day before.
  return `${weekdayLong.format(hour < 4 ? addDays(d, -1) : d)} ${part}`;
}

/** The day's headline: how much is left to study, in a sentence. */
function todayHeadline(due, reviewedToday) {
  if (!due) return reviewedToday ? 'All caught up for today.' : 'Nothing is due today.';
  const count = due <= 10 ? NUMBER_WORDS[due] : due.toLocaleString();
  return `${count} ${due === 1 ? 'card' : 'cards'}, then you’re done.`;
}

/** Today at a glance: the headline and the way into the first deck with cards due, beside the day's figures. */
function todayPanel(all, now) {
  const { reviewedToday, streak } = store.stats(now);
  const due = all.reduce((total, { c }) => total + c.total, 0);
  const tomorrow = all.reduce((total, { c }) => total + c.tomorrow.total, 0);
  const waiting = all.filter(({ c }) => c.total);
  const first = waiting[0]?.deck;
  const days = store.recentDays(7, now);

  return h(
    'section',
    { class: 'today', 'aria-label': 'Today' },
    h(
      'div',
      { class: 'today-main' },
      h('p', { class: 'today-when' }, partOfDay(now)),
      h('h1', null, todayHeadline(due, reviewedToday)),
      // On a phone the day's figures fit on one line under the headline.
      h('p', { class: 'today-line phone-only' }, `${reviewedToday.toLocaleString()} reviewed today · ${streak}-day streak · ${tomorrow.toLocaleString()} tomorrow`),
      first &&
        h(
          'div',
          { class: 'today-go wide-only' },
          h('a', { class: 'btn primary lg', href: `#/study/${first.id}` }, icon('play'), 'Start review'),
          h('span', null, waiting.length > 1 ? `${first.name} first, then ${plural(waiting.length - 1, 'more deck')}` : `From ${first.name}`),
        ),
      // On a phone the way in is docked above the tab bar, in reach of the thumb.
      first &&
        h(
          'div',
          { class: 'dock phone-only' },
          h('a', { class: 'btn primary lg', href: `#/study/${first.id}` }, icon('play'), 'Start review', h('span', { class: 'dock-count' }, `· ${due.toLocaleString()}`)),
          h('span', null, waiting.length > 1 ? `${first.name} first, then ${plural(waiting.length - 1, 'more deck')}` : `From ${first.name}`),
        ),
    ),
    h(
      'dl',
      { class: 'today-figures wide-only' },
      h('div', null, h('dd', null, reviewedToday.toLocaleString()), h('dt', null, 'reviewed today')),
      h(
        'div',
        { class: 'streak' },
        h(
          'div',
          { class: 'streak-days', 'aria-hidden': 'true' },
          days.map(({ date, n }, i) =>
            withTip(h('i', { class: `${n ? 'on' : ''} ${i === days.length - 1 ? 'now' : ''}` }), n ? plural(n, 'review') : 'No reviews', longDate.format(date)),
          ),
        ),
        h('dd', null, `${streak}-day`),
        h('dt', null, 'streak'),
      ),
      h('div', null, h('dd', null, tomorrow.toLocaleString()), h('dt', null, 'due tomorrow')),
    ),
  );
}

function renderHome() {
  const now = Date.now();
  const decks = store.decks();
  const all = decks.map((deck) => ({ deck, c: store.counts(deck.id, now) }));

  const row = ({ deck, c }) =>
    h(
      'li',
      { class: 'deck' },
      h(
        'a',
        { class: 'deck-main', href: `#/deck/${deck.id}` },
        h('span', { class: 'deck-name' }, deck.name),
        deckFrom(deck),
        h('span', { class: 'deck-meta wide-only' }, plural(c.cards, 'card') + (c.reserve ? ` · ${c.reserve.toLocaleString()} on reserve` : '') + (c.tomorrow.total ? ` · ${c.tomorrow.total.toLocaleString()} tomorrow` : '')),
        // A phone keeps the row to one short line; the reserve shows on the deck's own page.
        h('span', { class: 'deck-meta phone-only' }, plural(c.cards, 'card') + (c.tomorrow.total ? ` · ${c.tomorrow.total.toLocaleString()} tomorrow` : '')),
      ),
      // On a phone: today's total and a chevron, the whole row opening the deck.
      h(
        'a',
        { class: 'deck-due phone-only', href: `#/deck/${deck.id}`, tabindex: '-1', 'aria-hidden': 'true' },
        c.total ? [h('i', { class: 'dot' }), c.total.toLocaleString()] : c.cards ? h('span', { class: 'deck-done' }, 'Done') : '',
        icon('next'),
      ),
      countPills(c),
      h(
        'div',
        { class: 'deck-actions' },
        iconButton('edit', 'Deck settings', () => openDeckDialog(deck)),
        store.editable(deck.id) && iconButton('trash', 'Delete deck', () => removeDeck(deck), 'danger'),
        c.total
          ? h('a', { class: 'btn', href: `#/study/${deck.id}` }, `Study ${c.total}`)
          : c.cards
            ? h('span', { class: 'caught-up' }, icon('check'), 'Caught up')
            : store.editable(deck.id)
              ? h('button', { class: 'btn', type: 'button', onclick: () => openCardDialog({ deckId: deck.id }) }, icon('plus'), 'Add cards')
              : h('span', { class: 'caught-up' }, 'No cards yet'),
      ),
    );

  const body = decks.length
    ? [
        todayPanel(all, now),
        h(
          'div',
          { class: 'section-head' },
          h('h2', null, 'Decks'),
          h(
            'div',
            { class: 'actions' },
            h('button', { class: 'btn wide-only', type: 'button', title: 'Import decks from an Anki .apkg file', onclick: pickAnkiFile }, icon('upload'), 'Import from Anki'),
            h('button', { class: 'btn wide-only', type: 'button', onclick: () => openDeckDialog() }, icon('plus'), 'New deck'),
            menu(
              'New deck or import',
              [
                h('button', { type: 'button', onclick: () => openDeckDialog() }, icon('plus'), 'New deck'),
                h('button', { type: 'button', onclick: pickAnkiFile }, icon('upload'), 'Import from Anki'),
              ],
              'plus',
              'phone-only',
            ),
          ),
        ),
        h('ul', { class: 'deck-list', 'aria-label': 'Decks' }, all.map(row)),
      ]
    : h(
        'div',
        { class: 'empty' },
        h('h2', null, 'Create your first deck'),
        h('p', null, 'Decks group related cards. Add a few cards, then study a little every day. Dohrao schedules each review for you.'),
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'btn primary', type: 'button', onclick: () => openDeckDialog() }, icon('plus'), 'New deck'),
          h('button', { class: 'btn', type: 'button', onclick: pickAnkiFile }, icon('upload'), 'Import from Anki'),
          h('button', { class: 'btn', type: 'button', onclick: loadSampleDeck }, 'Try a sample deck'),
        ),
      );

  app.replaceChildren(
    h(
      'div',
      { class: 'page' },
      topbar(partOfDay(now)),
      !decks.length && h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Decks'), h('p', { class: 'sub' }, 'Nothing here yet'))),
      body,
    ),
  );
}

/** A deck's topic counts; a card whose topic no longer exists counts as Unsorted (see `effectiveTopic`). */
const topicTotals = (deck, now) => store.topicCounts(deck.id, now);

const countsText = (n) => [n.due && `${n.due.toLocaleString()} due`, n.fresh && `${n.fresh.toLocaleString()} new`].filter(Boolean).join(', ') || 'Nothing due';

/** Choose which topics to study. The choice is the user's own, so it is kept even on a deck the admin gave. */
function openTopicPicker(deck) {
  const now = Date.now();
  const totals = topicTotals(deck, now);
  const groups = deck.groups ?? [];
  const topics = deck.topics ?? [];
  const live = new Set(['unsorted', ...groups.map((g) => `g:${g.id}`), ...topics.map((t) => `t:${t.id}`)]);
  const picked = new Set((deck.studyFilter ?? []).filter((e) => live.has(e)));
  const sum = (ids) =>
    ids.reduce(
      (a, id) => {
        const n = totals.get(id);
        return n ? { due: a.due + n.due, fresh: a.fresh + n.fresh } : a;
      },
      { due: 0, fresh: 0 },
    );

  const boxes = new Map();
  const row = (entry, label, n, { nested = false } = {}) => {
    const box = h('input', {
      type: 'checkbox',
      checked: picked.has(entry),
      onchange: () => {
        if (box.checked) picked.add(entry);
        else picked.delete(entry);
        sync();
      },
    });
    boxes.set(entry, box);
    return h('label', { class: `pick-row${nested ? ' nested' : ''}` }, box, h('span', { class: 'pick-name' }, label), h('span', { class: 'pick-count' }, countsText(n)));
  };
  const everything = h('input', {
    type: 'checkbox',
    onchange: () => {
      picked.clear();
      sync();
    },
  });
  const sync = () => {
    everything.checked = picked.size === 0;
    for (const [entry, box] of boxes) {
      box.checked = picked.has(entry);
      // A ticked group already holds all its topics.
      if (entry.startsWith('t:')) {
        const t = topics.find((x) => `t:${x.id}` === entry);
        const inGroup = Boolean(t.groupId) && picked.has(`g:${t.groupId}`);
        box.disabled = inGroup;
        if (inGroup) box.checked = true;
      }
    }
  };

  const items = [h('label', { class: 'pick-row' }, everything, h('span', { class: 'pick-name' }, 'Everything'), h('span', { class: 'pick-count' }, countsText(sum([...totals.keys()]))))];
  for (const g of groups) {
    const own = topics.filter((t) => t.groupId === g.id);
    const inner = h('div', { class: 'pick-topics', hidden: true }, own.map((t) => row(`t:${t.id}`, t.name, sum([t.id]), { nested: true })));
    const toggle = h('button', {
      class: 'icon-btn pick-toggle',
      type: 'button',
      'aria-expanded': 'false',
      'aria-label': `Show the topics in ${g.name}`,
      onclick: () => {
        inner.hidden = !inner.hidden;
        toggle.setAttribute('aria-expanded', String(!inner.hidden));
      },
    }, icon('chevron'));
    items.push(h('div', { class: 'pick-group' }, h('div', { class: 'pick-head' }, row(`g:${g.id}`, g.name, sum(own.map((t) => t.id))), own.length > 0 && toggle), inner));
  }
  for (const t of topics.filter((x) => !groups.some((g) => g.id === x.groupId))) items.push(row(`t:${t.id}`, t.name, sum([t.id])));
  if (totals.has('')) items.push(row('unsorted', 'Unsorted', sum([''])));
  sync();

  const { newLeft } = store.counts(deck.id, now);
  const dialog = modal(
    'Study which topics',
    [
      h('p', { class: 'pick-note' }, `${plural(newLeft, 'new card')} left today for this deck.`),
      h('div', { class: 'pick-list' }, items),
      h(
        'div',
        { class: 'pick-actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, 'Cancel'),
        h(
          'button',
          {
            class: 'btn primary',
            type: 'button',
            onclick: () => {
              store.updateDeck(deck.id, { studyFilter: [...picked] });
              dialog.close();
              render();
            },
          },
          'Save',
        ),
      ),
    ],
    { narrow: true },
  );
}

/**
 * The topic choices for a select: everything, each group, each topic, then Unsorted. Values are
 * filter entries. With `totals` each shows how many cards are on reserve; without, just the name.
 */
function topicOptions(deck, totals, everything = 'Everything') {
  const groups = deck.groups ?? [];
  const topics = deck.topics ?? [];
  const reserveOf = (ids) => ids.reduce((a, id) => a + (totals.get(id)?.reserve ?? 0), 0);
  const opt = (value, label, ids) => h('option', { value }, totals ? `${label} (${reserveOf(ids).toLocaleString()})` : label);
  const out = [opt('', everything, totals ? [...totals.keys()] : [])];
  for (const g of groups) out.push(opt(`g:${g.id}`, g.name, topics.filter((t) => t.groupId === g.id).map((t) => t.id)));
  for (const t of topics) {
    const group = groups.find((g) => g.id === t.groupId);
    out.push(opt(`t:${t.id}`, group ? `${group.name}: ${t.name}` : t.name, [t.id]));
  }
  if (!totals || totals.has('')) out.push(opt('unsorted', 'Unsorted', ['']));
  return out;
}

/** Options to put one card in one topic: Unsorted, then each topic (grouped). The value is a topic id, or '' for Unsorted. */
function topicChoices(deck, value) {
  const groups = deck?.groups ?? [];
  const topics = deck?.topics ?? [];
  const opt = (t) => h('option', { value: t.id, selected: t.id === value }, t.name);
  return [
    h('option', { value: '', selected: !value }, 'Unsorted'),
    groups.map((g) => {
      const own = topics.filter((t) => t.groupId === g.id);
      return own.length > 0 && h('optgroup', { label: g.name }, own.map(opt));
    }),
    topics.filter((t) => !groups.some((g) => g.id === t.groupId)).map(opt),
  ];
}

/** The topic a card sits in, if that topic still exists. */

/** Move ticked cards into a topic, or out of any topic. */
function openMoveToTopic(deck, ids) {
  const select = h('select', { 'aria-label': 'Topic' }, topicChoices(deck, ''));
  const dialog = modal(
    `Move ${plural(ids.length, 'card')} to a topic`,
    h(
      'form',
      {
        onsubmit: (e) => {
          e.preventDefault();
          const moved = store.setCardsTopic(ids, select.value || null, Date.now());
          const where = select.value ? `“${select.selectedOptions[0].textContent}”` : 'Unsorted';
          dialog.close();
          toast(`${plural(moved, 'card')} moved to ${where}`);
          render();
        },
      },
      h('label', { class: 'field' }, h('span', null, 'Topic'), select),
      h('div', { class: 'modal-foot' }, h('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, 'Cancel'), h('button', { class: 'btn primary', type: 'submit' }, 'Move')),
    ),
    { narrow: true },
  );
  select.focus();
}

/** Manage a deck's groups and topics. A deck given by the admin is shown but not changed. */
function openTopicsDialog(deck) {
  const editable = store.editable(deck.id);
  const box = h('div', { class: 'topics-edit' });
  const cardsIn = (topicId) => store.cardsIn(deck.id).filter((c) => c.topic === topicId).length;
  const nameInput = (value, label, save) => {
    const input = h('input', {
      type: 'text',
      value,
      required: true,
      maxlength: 80,
      'aria-label': label,
      onchange: () => {
        const name = input.value.trim();
        if (!name) input.value = value;
        else {
          value = name;
          input.value = name;
          save(name);
        }
      },
    });
    return input;
  };
  const groupSelect = (value, label, onchange) => {
    const select = h(
      'select',
      { 'aria-label': label, onchange: () => onchange(select.value || null) },
      h('option', { value: '', selected: !value }, 'No group'),
      (deck.groups ?? []).map((g) => h('option', { value: g.id, selected: g.id === value }, g.name)),
    );
    return select;
  };
  const removeTopic = async (t) => {
    const n = cardsIn(t.id);
    const ok = await confirmDialog({
      title: `Delete “${t.name}”?`,
      message: n ? `${plural(n, 'card')} in this topic will become Unsorted.` : 'No cards are in this topic.',
      confirmLabel: 'Delete topic',
    });
    if (!ok) return;
    store.deleteTopic(deck.id, t.id, Date.now());
    draw();
  };
  const removeGroup = async (g) => {
    const n = (deck.topics ?? []).filter((t) => t.groupId === g.id).length;
    const ok = await confirmDialog({
      title: `Delete the group “${g.name}”?`,
      message: n ? `Its ${plural(n, 'topic')} stay, with no group. No cards change.` : 'The group is empty.',
      confirmLabel: 'Delete group',
    });
    if (!ok) return;
    store.deleteGroup(deck.id, g.id, Date.now());
    draw();
  };
  const topicRow = (t) => {
    const n = cardsIn(t.id);
    if (!editable) return h('div', { class: 'topic-row' }, h('span', { class: 'topic-name' }, t.name), h('span', { class: 'pick-count' }, plural(n, 'card')));
    return h(
      'div',
      { class: 'topic-row' },
      nameInput(t.name, `Name of the topic ${t.name}`, (name) => store.renameTopic(deck.id, t.id, name, Date.now())),
      (deck.groups ?? []).length > 0 &&
        groupSelect(t.groupId, `Group of ${t.name}`, (groupId) => {
          store.moveTopic(deck.id, t.id, groupId, Date.now());
          draw();
        }),
      h('span', { class: 'pick-count' }, plural(n, 'card')),
      iconButton('trash', `Delete the topic ${t.name}`, () => removeTopic(t), 'danger'),
    );
  };
  const add = (placeholder, label, onadd, withGroup) => {
    const input = h('input', { type: 'text', required: true, maxlength: 80, placeholder, 'aria-label': label });
    const group = withGroup && (deck.groups ?? []).length > 0 ? groupSelect(null, 'Group for the new topic', () => {}) : null;
    return h(
      'form',
      {
        class: 'topic-row topic-add',
        onsubmit: (e) => {
          e.preventDefault();
          const name = input.value.trim();
          if (!name) return input.focus();
          onadd(name, group?.value || null);
          draw();
        },
      },
      input,
      group,
      h('button', { class: 'btn', type: 'submit' }, icon('plus'), 'Add'),
    );
  };

  const draw = () => {
    deck = store.deck(deck.id);
    const groups = deck.groups ?? [];
    const topics = deck.topics ?? [];
    const loose = topics.filter((t) => !groups.some((g) => g.id === t.groupId));
    const unsorted = store.cardsIn(deck.id).filter((c) => !effectiveTopic(deck, c)).length;
    box.replaceChildren(
      !editable && h('p', { class: 'pick-note' }, `${deck.from ? `${deck.from} sets` : 'The owner sets'} this deck's topics. You can see them here, but not change them.`),
      !topics.length && !groups.length && h('p', { class: 'pick-note' }, editable ? 'This deck has no topics yet. Add one below, then move cards into it.' : 'This deck has no topics.'),
      groups.map((g) =>
        h(
          'section',
          { class: 'topic-group' },
          h(
            'div',
            { class: 'topic-group-head' },
            editable ? nameInput(g.name, `Name of the group ${g.name}`, (name) => store.renameGroup(deck.id, g.id, name, Date.now())) : h('b', null, g.name),
            editable && iconButton('trash', `Delete the group ${g.name}`, () => removeGroup(g), 'danger'),
          ),
          topics.filter((t) => t.groupId === g.id).map(topicRow),
        ),
      ),
      loose.length > 0 && h('section', { class: 'topic-group' }, groups.length > 0 && h('div', { class: 'topic-group-head' }, h('b', null, 'No group')), loose.map(topicRow)),
      topics.length > 0 && h('p', { class: 'pick-note' }, `${plural(unsorted, 'card')} Unsorted.`),
      editable && [
        h('h3', { class: 'topics-sub' }, 'Add a topic'),
        add('Topic name', 'Name of the new topic', (name, groupId) => store.createTopic(deck.id, name, groupId, Date.now()), true),
        h('h3', { class: 'topics-sub' }, 'Add a group'),
        add('Group name', 'Name of the new group', (name) => store.createGroup(deck.id, name, Date.now()), false),
      ],
    );
  };
  draw();
  const dialog = modal('Topics', [box, h('div', { class: 'pick-actions' }, h('button', { class: 'btn primary', type: 'button', onclick: () => dialog.close() }, 'Done'))], { onclose: render });
}

/** A deck's reserve: how many cards are waiting, and the controls to pull some in or rearrange them. */
function reserveBar(deck, n) {
  const hasTopics = (deck.topics ?? []).length > 0;
  const topic = hasTopics && h('select', { class: 'reserve-topic', 'aria-label': 'Which topic to pull in from' }, topicOptions(deck, topicTotals(deck, Date.now())));
  const pull = (count) => {
    const pulled = store.pullFromReserve(deck.id, count, Date.now(), topic && topic.value ? [topic.value] : undefined);
    toast(`${plural(pulled, 'card')} pulled in as new ${pulled === 1 ? 'card' : 'cards'}`);
    render();
  };
  const amount = h('input', { type: 'number', required: true, min: 1, max: n, step: 1, value: Math.min(n, 10), 'aria-label': 'How many cards to pull in' });
  const reorder = () => {
    query = '';
    filters = { ...NO_FILTERS, groups: ['reserve'], sort: 'reserve' };
    deckTab = 'reserve';
    render();
  };
  // Shown as buttons on a wide screen, and folded into a menu on a phone.
  const more = [
    n > 1 && ['Pull all', hasTopics ? 'Pull all' : `Pull all ${n.toLocaleString()}`, null, () => pull(n), null],
    n > 1 && ['Choose cards', 'Choose cards', 'check', reorder, 'List the reserve in the order it is pulled in, to tick cards to pull in or to rearrange it'],
    store.editable(deck.id) && ['Import to reserve', 'Import to reserve', 'upload', () => pickImportFile(deck, true), 'Import cards from a CSV or Excel file straight into the reserve'],
  ].filter(Boolean);
  return h(
    'form',
    {
      class: 'reserve',
      onsubmit: (e) => {
        e.preventDefault();
        pull(Number(amount.value));
      },
    },
    icon('box'),
    h(
      'div',
      { class: 'reserve-text' },
      h('b', null, n ? `${plural(n, 'card')} on reserve` : 'Nothing on reserve'),
      h('span', null, n ? 'Kept out of study until you pull them in, the first in line first.' : 'Cards on reserve are kept out of study until you pull them in.'),
    ),
    n > 0 && [topic, amount, h('button', { class: 'btn primary', type: 'submit' }, 'Pull in')],
    more.map(([, label, glyph, onclick, title]) => h('button', { class: 'btn reserve-wide', type: 'button', title, onclick }, glyph && icon(glyph), label)),
    more.length > 0 && h('div', { class: 'reserve-narrow' }, menu('More for the reserve', more.map(([, label, glyph, onclick]) => h('button', { type: 'button', onclick }, icon(glyph ?? 'down'), label)))),
  );
}

/**
 * A deck's card list, in one of three views: 'all' (every card, the filters as set), 'cards'
 * (the cards being studied) or 'reserve' (the reserve, in the order it is pulled in). Lists
 * share the ticked cards, but each prunes and acts only on its own.
 *
 * `column` makes a reserve list the wide screen's reserve column: narrowed to `column.topics`,
 * each row numbered by its place in the queue with the cards Pull in would take tinted
 * (`column.preview()`), and the ticked cards' actions handed to `column.onDraw` for its foot.
 */
function cardList(deck, view, { filters, filtering, editable, hasTopics, now, column = null }) {
  const cards = store.cardsIn(deck.id);
  const list = h('div', { class: 'deck-cards' });
  const shown = h('span', { class: 'count' });
  // Ids of the reserve cards being dragged to a new place.
  let dragged = null;
  // How many matching cards are drawn; a deck can hold thousands, and drawing them all is slow.
  let limit = CARD_PAGE;

  const drawList = (fresh = false) => {
    if (fresh) limit = CARD_PAGE;
    const q = query.trim();
    // A view narrows the list: the reserve, or everything else.
    const matches = store
      .findCards(deck.id, { text: q, ...(view === 'all' ? filters : tabFilters(filters, view)), ...(column && { topics: column.topics }) }, now)
      .filter((card) => view === 'all' || inTab(card, view));
    shown.textContent = q || filtering ? `${matches.length.toLocaleString()} of ${plural(cards.length, 'card')}` : plural(cards.length, 'card');
    // Only cards on screen stay ticked; ticks in another list's view are that list's to keep.
    pruneTicks(selected, matches, view, store.card);
    const mine = new Set(ownTicks(selected, matches, view));
    const pick = (ids, on) => {
      for (const id of ids) on ? selected.add(id) : selected.delete(id);
      drawList();
    };
    // In reserve order, the reserve cards shown can be moved: `line` is those, first to last.
    const line = view === 'reserve' || (view === 'all' && filters.sort === 'reserve') ? matches.filter((card) => card.reserved) : [];
    const picked = line.filter((card) => selected.has(card.id));
    const waiting = line.filter((card) => !selected.has(card.id));
    const movable = picked.length > 0 && picked.length === mine.size;
    // Ticked cards not on reserve, which can be put back on it.
    const unreserved = matches.filter((card) => selected.has(card.id) && !card.reserved).map((card) => card.id);
    // Ticked cards on reserve, which can be pulled in.
    const reserved = matches.filter((card) => selected.has(card.id) && card.reserved).map((card) => card.id);
    const move = (ids, where) => {
      dragged = null;
      store.moveInReserve(deck.id, ids, where);
      drawList();
    };
    // One place up or down among the cards shown, which gathers the ticked cards together.
    const step = (down) => {
      const edge = line.indexOf(picked.at(down ? -1 : 0));
      const anchor = line[edge + (down ? 1 : -1)] ?? waiting.at(down ? -1 : 0);
      if (anchor) move([...mine], { [down ? 'after' : 'before']: anchor.id });
    };
    const toTop = () => {
      const first = store.reserveIn(deck.id).find((card) => !selected.has(card.id));
      if (first) move([...mine], { before: first.id });
    };
    const moveButton = (label, title, onclick, glyph) => h('button', { class: 'btn', type: 'button', title, onclick }, glyph && icon(glyph), label);
    column?.onDraw({ ticked: [...mine], movable: movable && line.length > 1, step, toTop, toBottom: () => move([...mine]), untick: () => pick([...mine], false) });
    if (!matches.length) {
      const message = q && !filtering ? `No cards match “${q}”.` : q ? `No cards match “${q}” with these filters.` : 'No cards match these filters.';
      list.replaceChildren(h('div', { class: 'card-list' }, h('div', { class: 'list-empty' }, message)));
      return;
    }
    // In the reserve column: each card's place in the queue, and the ones Pull in would take.
    const preview = column?.preview();
    const lastNext = preview && [...preview.next].at(-1);
    list.replaceChildren(
      h(
        'div',
        { class: 'card-list' },
        h(
          'div',
          { class: 'select-bar' },
          h(
            'label',
            { class: 'pick' },
            h('input', {
              type: 'checkbox',
              checked: mine.size === matches.length,
              indeterminate: mine.size > 0 && mine.size < matches.length,
              onchange: (e) => pick(matches.map((card) => card.id), e.target.checked),
            }),
            // The reserve column's foot says how many are ticked; its top only offers to tick them all.
            mine.size && !column ? `${mine.size.toLocaleString()} selected` : matches.length === cards.length || column ? 'Select all' : `Select all ${matches.length.toLocaleString()} shown`,
          ),
          column
            ? line.length > 1 && !mine.size && h('span', { class: 'hint' }, 'Drag to reorder')
            : [
          line.length > 1 && !mine.size && h('span', { class: 'hint' }, 'Drag cards to reorder them, or tick several to move them together.'),
          // Only with the whole reserve in view, so nothing out of sight moves.
          line.length > 1 &&
            !mine.size &&
            line.length === store.reserveIn(deck.id).length &&
            moveButton('Reverse order', 'Turn the whole reserve around, so the last card is pulled in first', () => {
              store.reverseReserve(deck.id);
              drawList();
            }, 'swap'),
          movable &&
            line.length > 1 &&
            h(
              'div',
              { class: 'bulk-move' },
              moveButton('Up', 'Move up one place', () => step(false), 'up'),
              moveButton('Down', 'Move down one place', () => step(true), 'down'),
              moveButton('To top', 'Move to the front of the reserve, to be pulled in first', toTop),
              moveButton('To bottom', 'Move to the end of the reserve, to be pulled in last', () => move([...mine])),
            ),
          // On a phone these become a toolbar along the bottom: an icon over a short label each.
          mine.size > 0 &&
            h(
              'div',
              { class: 'bulk' },
              movable &&
                line.length > 1 &&
                menu(
                  'Move',
                  [
                    h('button', { type: 'button', onclick: () => step(false) }, icon('up'), 'Up one place'),
                    h('button', { type: 'button', onclick: () => step(true) }, icon('down'), 'Down one place'),
                    h('button', { type: 'button', onclick: toTop }, icon('up'), 'To the top'),
                    h('button', { type: 'button', onclick: () => move([...mine]) }, icon('down'), 'To the bottom'),
                  ],
                  'swap',
                  'phone-only bulk-menu',
                ),
            reserved.length > 0 &&
              h(
                'button',
                {
                  class: 'btn primary',
                  type: 'button',
                  title: 'Pull the ticked reserve cards in as new cards, in their reserve order',
                  onclick: () => {
                    const pulled = store.pullCards(reserved);
                    toast(`${plural(pulled, 'card')} pulled in as new ${pulled === 1 ? 'card' : 'cards'}`);
                    render();
                  },
                },
                icon('box'),
                reserved.length === mine.size ? 'Pull in' : `Pull in ${reserved.length.toLocaleString()}`,
              ),
            unreserved.length > 0 &&
              h(
                'button',
                { class: 'btn', type: 'button', title: 'Take the ticked cards out of study and put them at the end of the reserve', 'data-short': 'To reserve', onclick: () => returnCardsToReserve(unreserved) },
                icon('box'),
                'Back to reserve',
              ),
            editable && [
              hasTopics &&
                h('button', { class: 'btn', type: 'button', title: 'Put the ticked cards in a topic, or take them out of one', 'data-short': 'Topic', onclick: () => openMoveToTopic(deck, [...mine]) }, h('span', { class: 'phone-only' }, icon('check')), 'Move to topic…'),
              h(
                'button',
                { class: 'btn', type: 'button', title: 'Add a copy of each ticked card with its front and back swapped, on the reserve', 'data-short': 'Reversed', onclick: () => addReversedCards([...mine]) },
                icon('swap'),
                'Add reversed',
              ),
              h('button', { class: 'btn danger', type: 'button', 'data-short': 'Delete', onclick: () => removeCards([...mine]) }, icon('trash'), `Delete ${plural(mine.size, 'card')}`),
            ],
            ),
          mine.size > 0 && h('button', { class: 'btn ghost bulk-cancel', type: 'button', onclick: () => pick([...mine], false) }, 'Cancel'),
              ],
        ),
        matches.slice(0, limit).map((card) => {
          const status = cardStatus(card, now);
          const sortable = line.length > 1 && card.reserved;
          // Dropping on the lower half of a row puts the cards after it.
          const below = (e) => {
            const box = row.getBoundingClientRect();
            return e.clientY > box.top + box.height / 2;
          };
          const mark = (side) => {
            row.classList.toggle('drop-before', side === 'before');
            row.classList.toggle('drop-after', side === 'after');
          };
          const row = h(
            'div',
            {
              class: `card-row ${selected.has(card.id) ? 'selected' : ''} ${editable ? '' : 'read-only'} ${hasTopics && !column ? 'has-topic' : ''} ${preview?.next.has(card.id) ? 'next' : ''} ${card.id === lastNext ? 'next-last' : ''}`,
              onclick: editable && (() => openCardDialog({ card })),
              // A phone reorders through the Move sheet: touch does not drag rows.
              ...(sortable && !isPhone() && {
                draggable: true,
                // Dragging a ticked card takes the other ticked cards along.
                ondragstart: (e) => {
                  dragged = selected.has(card.id) ? picked.map((c) => c.id) : [card.id];
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', card.front);
                },
                ondragover: (e) => {
                  if (!dragged || dragged.includes(card.id)) return;
                  e.preventDefault();
                  mark(below(e) ? 'after' : 'before');
                },
                ondragleave: () => mark(),
                ondrop: (e) => {
                  if (!dragged || dragged.includes(card.id)) return;
                  e.preventDefault();
                  move(dragged, { [below(e) ? 'after' : 'before']: card.id });
                },
                ondragend: () => {
                  dragged = null;
                },
              }),
            },
            h(
              'label',
              { class: 'pick', onclick: (e) => e.stopPropagation() },
              sortable && h('span', { class: 'grip', title: 'Drag to reorder' }, icon('grip')),
              h('input', { type: 'checkbox', 'aria-label': 'Select card', checked: selected.has(card.id), onchange: (e) => pick([card.id], e.target.checked) }),
            ),
            column && h('span', { class: 'place' }, preview.place.get(card.id)?.toLocaleString()),
            h('div', { class: 'text' }, rich(card.front)),
            h('div', { class: 'text back-text' }, rich(card.back)),
            !column && hasTopics && h('div', { class: 'topic-name' }, topicLabel(deck, card)),
            !column && statusMark(status, status.label, 'due'),
            !column &&
              editable &&
              h(
                'div',
                { class: 'row-actions', onclick: (e) => e.stopPropagation() },
                iconButton('edit', 'Edit card', () => openCardDialog({ card })),
                iconButton('trash', 'Delete card', () => removeCard(card), 'danger'),
              ),
          );
          if (isPhone()) holdToTick(row, () => pick([card.id], true));
          return row;
        }),
        matches.length > limit &&
          h(
            'div',
            { class: 'list-more' },
            h(
              'button',
              {
                class: 'btn',
                type: 'button',
                onclick: () => {
                  limit += CARD_PAGE;
                  drawList();
                  list.querySelector('.list-more .btn')?.focus({ preventScroll: true });
                },
              },
              `Show ${Math.min(CARD_PAGE, matches.length - limit).toLocaleString()} more`,
            ),
            h('span', null, `${limit.toLocaleString()} of ${matches.length.toLocaleString()} shown`),
          ),
      ),
    );
  };
  return { el: list, count: shown, draw: drawList };
}

function renderDeck(deck) {
  const now = Date.now();
  // A deck given by the admin is studied here, but its cards are changed only by its owner.
  const editable = store.editable(deck.id);
  const c = store.counts(deck.id, now, deck.studyFilter);
  const cards = store.cardsIn(deck.id);
  if (filtersDeck !== deck.id) {
    filters = { ...NO_FILTERS };
    filtersDeck = deck.id;
    selected = new Set();
    deckTab = 'cards';
    reserveTopic = '';
    pullAmount = null;
  }
  if (reserveTopic && !topicOptions(deck, null).some((o) => o.value === reserveTopic)) reserveTopic = '';
  const hasTopics = (deck.topics ?? []).length > 0;
  // A topic filter that no longer exists (deleted, or the deck changed) is dropped.
  if (filters.topics.length && !topicOptions(deck, null).some((o) => o.value === filters.topics[0])) filters = { ...filters, topics: [] };
  const filtering = Object.keys(NO_FILTERS).some((key) => key !== 'sort' && String(filters[key]) !== String(NO_FILTERS[key]));
  const setFilters = (patch) => {
    filters = { ...filters, ...patch };
    render();
  };

  const groupCounts = {};
  for (const card of cards) {
    const group = store.cardGroup(card, now);
    groupCounts[group] = (groupCounts[group] ?? 0) + 1;
  }
  const phone = isPhone();
  const tabbed = isTabbedDeck();
  // Beside the reserve column, the studying cards' filters leave out the reserve's chip and order.
  const groups = phone ? CARD_GROUPS : CARD_GROUPS.filter(([group]) => group !== 'reserve');
  const selects = phone ? FILTER_SELECTS : FILTER_SELECTS.map(([key, label, options]) => [key, label, key === 'sort' ? options.filter(([value]) => value !== 'reserve') : options]);
  const filterBar = [
    h(
      'div',
      { class: 'chips', role: 'group', 'aria-label': 'Show cards that are' },
      groups.map(([group, label]) => {
        const on = filters.groups.includes(group);
        return h(
          'button',
          {
            class: 'chip',
            type: 'button',
            'data-group': group,
            'aria-pressed': String(on),
            onclick: () => setFilters({ groups: on ? filters.groups.filter((g) => g !== group) : [...filters.groups, group] }),
          },
          label,
          h('b', null, (groupCounts[group] ?? 0).toLocaleString()),
        );
      }),
    ),
    h(
      'button',
      {
        class: 'btn filter-toggle',
        type: 'button',
        'aria-expanded': String(filtersOpen || filtering),
        onclick: () => {
          filtersOpen = !(filtersOpen || filtering);
          render();
        },
      },
      filtering ? 'Filters on' : 'Filter and sort',
    ),
    h(
      'div',
      { class: `filters ${filtersOpen || filtering ? 'open' : ''}` },
      selects.map(([key, label, options]) => {
        const select = h(
          'select',
          { onchange: () => setFilters({ [key]: select.value }) },
          options.map(([value, text]) => h('option', { value, selected: value === filters[key] }, text)),
        );
        return h('label', { class: key !== 'sort' && filters[key] !== NO_FILTERS[key] ? 'on' : '' }, h('span', null, label), select);
      }),
      hasTopics &&
        (() => {
          const select = h(
            'select',
            { onchange: () => setFilters({ topics: select.value ? [select.value] : [] }) },
            topicOptions(deck, null, 'All topics').map((o) => (o.value === (filters.topics[0] ?? '') ? Object.assign(o, { selected: true }) : o)),
          );
          return h('label', { class: filters.topics.length ? 'on' : '' }, h('span', null, 'Topic'), select);
        })(),
      filtering && h('button', { class: 'btn ghost', type: 'button', onclick: () => setFilters({ ...NO_FILTERS, sort: filters.sort }) }, icon('close'), 'Clear filters'),
    ),
  ];

  const options = { filters, filtering, editable, hasTopics, now };
  // Up to 899px one list fills the chosen tab; wider, the reserve and the studying cards sit side by side.
  const reserveCol = !tabbed && reserveColumn(deck, editable, options);
  const lists = tabbed ? [cardList(deck, deckTab === 'reserve' ? 'reserve' : 'cards', options)] : [reserveCol.list, cardList(deck, 'cards', options)].filter(Boolean);
  if (tabbed) {
    lists[0].el.id = 'deck-cards';
    lists[0].el.setAttribute('role', 'tabpanel');
    lists[0].el.setAttribute('aria-labelledby', `deck-tab-${deckTab}`);
  }
  const studyList = !tabbed && lists.at(-1);

  const search = h('input', {
    type: 'search',
    placeholder: tabbed ? 'Search cards' : `Search all ${cards.length.toLocaleString()} cards`,
    value: query,
    'aria-label': 'Search cards',
    oninput: () => {
      query = search.value;
      for (const list of lists) list.draw(true);
    },
  });
  const searchBox = h('div', { class: 'search' }, icon('search'), search);
  // Beside the search on a wide screen: the filters open from one button.
  const filterButton = h(
    'button',
    {
      class: `btn filter-open ${filtering ? 'on' : ''}`,
      type: 'button',
      'aria-expanded': String(filtersOpen || filtering),
      onclick: () => {
        filtersOpen = !(filtersOpen || filtering);
        render();
      },
    },
    icon('sliders'),
    filtering ? 'Filters on' : 'Filter and sort',
  );
  // The chips and the dropdowns, shown together when the filters are open.
  const filterPanel = (filtersOpen || filtering) && h('div', { class: 'filter-panel' }, filterBar[0], filterBar[2]);

  let content;
  if (!cards.length) {
    content = h(
      'div',
      { class: 'empty' },
      h('h2', null, 'No cards yet'),
      editable
        ? [
            h('p', null, 'Add a question on the front and its answer on the back, or import a list from an Excel file.'),
            h(
              'div',
              { class: 'row' },
              h('button', { class: 'btn primary', type: 'button', onclick: () => openCardDialog({ deckId: deck.id }) }, icon('plus'), 'Add card'),
              h('button', { class: 'btn', type: 'button', onclick: () => pickImportFile(deck) }, icon('upload'), 'Import from Excel'),
            ),
          ]
        : h('p', null, `Cards appear here when ${deck.from} adds them.`),
    );
  } else if (phone) {
    content = [
      reserveBar(deck, c.reserve),
      h(
        'div',
        { class: 'toolbar' },
        searchBox,
        lists[0].count,
        // On a phone the filters open from a button beside the search.
        h(
          'button',
          {
            class: `icon-btn filter-icon phone-only ${filtering ? 'on' : ''}`,
            type: 'button',
            title: 'Filter and sort',
            'aria-label': 'Filter and sort',
            'aria-expanded': String(filtersOpen || filtering),
            onclick: () => {
              filtersOpen = !(filtersOpen || filtering);
              render();
            },
          },
          icon('sliders'),
        ),
      ),
      filterBar,
      lists[0].el,
    ];
  } else if (tabbed) {
    // A tablet or a narrow window: the phone's tabs, each drawing only what it needs.
    content =
      deckTab === 'topics'
        ? null
        : deckTab === 'reserve'
          ? [reserveBar(deck, c.reserve), h('div', { class: 'toolbar' }, searchBox), lists[0].el]
          : [h('div', { class: 'toolbar' }, searchBox, filterButton), filterPanel, lists[0].el];
  } else {
    content = h(
      'div',
      { class: 'deck-columns' },
      reserveCol.el,
      h(
        'section',
        { class: 'deck-studying', 'aria-label': 'Studying' },
        h('div', { class: 'column-head' }, h('h2', null, 'Studying'), h('span', null, plural(cards.length - c.reserve, 'card'))),
        h('div', { class: 'toolbar' }, searchBox, filterButton),
        filterPanel,
        studyList.el,
      ),
    );
  }
  if (cards.length) for (const list of lists) list.draw();

  const status = !phone && sortStatus(deck);
  app.replaceChildren(
    h(
      'div',
      { class: `page screen-drill${tabbed ? '' : ' deck-page'}`, 'data-tab': deckTab },
      topbar(),
      h('a', { class: 'back', href: '#/' }, icon('back'), 'All decks'),
      h(
        'div',
        { class: 'page-head', style: 'margin-top: 14px' },
        h(
          'div',
          null,
          h('h1', null, deck.name),
          deckFrom(deck),
          phone
            ? [countPills(c), h('div', { class: 'deck-meta tomorrow' }, tomorrowText(c), ' ', h('a', { href: `#/upcoming/${deck.id}` }, 'See the days ahead'))]
            : h('div', { class: 'deck-line' }, countPills(c), c.tomorrow.total > 0 && h('span', { class: 'deck-meta' }, `${c.tomorrow.total.toLocaleString()} tomorrow`)),
        ),
        h(
          'div',
          { class: 'actions' },
          editable && h('button', { class: 'btn wide-only', type: 'button', onclick: () => openCardDialog({ deckId: deck.id }) }, icon('plus'), 'Add card'),
          menu('More for this deck', [
            h('a', { href: `#/upcoming/${deck.id}` }, icon('calendar'), 'Upcoming cards'),
            h('a', { href: `#/stats/${deck.id}` }, icon('chart'), 'Statistics'),
            editable && h('button', { type: 'button', title: 'Import cards from an Excel or CSV file', onclick: () => pickImportFile(deck) }, icon('upload'), 'Import from Excel'),
            (hasTopics || editable) && h('button', { type: 'button', title: 'See the deck\'s groups and topics', onclick: () => openTopicsDialog(deck) }, icon('check'), 'Topics…'),
            !phone && sortAction(deck),
            h('button', { type: 'button', onclick: () => openDeckDialog(deck) }, icon('edit'), 'Deck settings'),
            editable && h('button', { type: 'button', class: 'danger', onclick: () => removeDeck(deck) }, icon('trash'), 'Delete deck'),
          ]),
          hasTopics && h('button', { class: 'btn topic-pick wide-only', type: 'button', title: 'Choose which topics to study', onclick: () => openTopicPicker(deck) }, h('span', null, filterLabel(deck, deck.studyFilter)), icon('chevron')),
          c.total > 0
            ? h('a', { class: 'btn primary wide-only', href: `#/study/${deck.id}` }, icon('play'), `Study ${c.total}`)
            : h('button', { class: 'btn primary wide-only', type: 'button', disabled: true }, 'Nothing due'),
        ),
      ),
      cards.length > 0 && tabbed && deckTabs(deck, c, cards, editable || hasTopics),
      phone ? sortBar(deck) : status,
      cards.length > 0 && tabbed && deckTab === 'topics' && topicsTab(deck, editable),
      content,
      deckDock(deck, c, editable),
    ),
  );
}

/**
 * On a wide screen, the reserve's own column: every reserve card in the order it is pulled in,
 * with Pull in at its foot and the cards it would take tinted. Returns the column and its list
 * (null when the reserve is empty).
 */
function reserveColumn(deck, editable, options) {
  const hasTopics = (deck.topics ?? []).length > 0;
  const topics = reserveTopic ? [reserveTopic] : [];
  // What Pull in takes from, asked afresh each time: dragging a card changes the order.
  const queue = () => store.findCards(deck.id, { groups: ['reserve'], topics, sort: 'reserve' }, Date.now());
  const total = store.reserveIn(deck.id).length;
  const amount = (n = queue().length) => clampAmount(pullAmount ?? 10, n);
  const topicName = reserveTopic && topicOptions(deck, null).find((o) => o.value === reserveTopic)?.textContent;
  const pulledToast = (pulled) => toast(`${plural(pulled, 'card')} pulled in as new ${pulled === 1 ? 'card' : 'cards'}`);
  const pullNext = (n) => {
    pulledToast(store.pullFromReserve(deck.id, n, Date.now(), topics.length ? topics : undefined));
    render();
  };

  const waiting = queue().length;
  const more = [
    waiting > 1 && h('button', { type: 'button', onclick: () => pullNext(Infinity) }, icon('box'), pullAllLabel(waiting, topicName)),
    total > 1 &&
      h(
        'button',
        {
          type: 'button',
          title: 'Turn the whole reserve around, so the last card is pulled in first',
          onclick: () => {
            store.reverseReserve(deck.id);
            render();
          },
        },
        icon('swap'),
        'Reverse order',
      ),
    editable && h('button', { type: 'button', title: 'Import cards from a CSV or Excel file straight into the reserve', onclick: () => pickImportFile(deck, true) }, icon('upload'), 'Import to reserve'),
  ].filter(Boolean);
  const head = h(
    'div',
    { class: 'column-head' },
    h('h2', null, 'Reserve'),
    h('span', null, `${total.toLocaleString()} · pulled in from the top`),
    more.length > 0 && menu('More for the reserve', more),
  );

  if (!total) {
    return {
      list: null,
      el: h(
        'section',
        { class: 'deck-reserve', 'aria-label': 'Reserve' },
        head,
        h(
          'div',
          { class: 'reserve-box reserve-empty' },
          h('b', null, 'Nothing on reserve'),
          h('p', null, 'Cards on reserve are kept out of study until you pull them in.'),
          editable && h('button', { class: 'btn', type: 'button', onclick: () => pickImportFile(deck, true) }, icon('upload'), 'Import to reserve'),
        ),
      ),
    };
  }

  // The foot with nothing ticked: the topic, how many, and Pull in. Built once, so typing in the
  // number keeps its focus while the tint follows it.
  const topicSelect =
    hasTopics &&
    h(
      'select',
      {
        class: 'reserve-topic',
        'aria-label': 'Which topic to pull in from',
        onchange: (e) => {
          reserveTopic = e.target.value;
          render();
        },
      },
      topicOptions(deck, topicTotals(deck, Date.now())).map((o) => Object.assign(o, { selected: o.value === reserveTopic })),
    );
  const amountBox = h('input', {
    type: 'number',
    min: 1,
    max: waiting,
    step: 1,
    value: amount(waiting),
    'aria-label': 'How many cards to pull in',
    oninput: () => {
      pullAmount = amountBox.value === '' ? null : Number(amountBox.value);
      list.draw();
    },
    onchange: () => {
      amountBox.value = amount();
    },
  });
  const pullButton = h('button', { class: 'btn primary', type: 'submit' });
  const plain = h(
    'form',
    {
      class: 'reserve-pull',
      onsubmit: (e) => {
        e.preventDefault();
        pullNext(amount());
      },
    },
    topicSelect,
    waiting > 0 ? h('div', { class: 'foot-row' }, amountBox, pullButton) : h('p', { class: 'foot-note' }, 'Nothing on reserve in this topic.'),
  );

  const foot = h('div', { class: 'reserve-foot' });
  const drawFoot = ({ ticked, movable, step, toTop, toBottom, untick }) => {
    if (!ticked.length) {
      pullButton.textContent = `Pull in the next ${amount().toLocaleString()}`;
      if (foot.firstChild !== plain) foot.replaceChildren(plain);
      return;
    }
    const moveButton = (label, title, onclick, glyph) => h('button', { class: 'btn', type: 'button', title, onclick }, glyph && icon(glyph), label);
    foot.replaceChildren(
      h('div', { class: 'foot-row' }, h('b', null, `${ticked.length.toLocaleString()} selected`), h('button', { class: 'btn ghost', type: 'button', onclick: untick }, 'Cancel')),
      h(
        'div',
        { class: 'foot-row wrap' },
        h(
          'button',
          {
            class: 'btn primary',
            type: 'button',
            title: 'Pull the ticked reserve cards in as new cards, in their reserve order',
            onclick: () => {
              pulledToast(store.pullCards(ticked));
              render();
            },
          },
          icon('box'),
          `Pull in ${ticked.length.toLocaleString()}`,
        ),
        movable && [
          moveButton('Up', 'Move up one place', () => step(false), 'up'),
          moveButton('Down', 'Move down one place', () => step(true), 'down'),
          moveButton('To top', 'Move to the front of the reserve, to be pulled in first', toTop),
          moveButton('To bottom', 'Move to the end of the reserve, to be pulled in last', toBottom),
        ],
        editable && h('button', { class: 'btn danger', type: 'button', onclick: () => removeCards(ticked) }, icon('trash'), 'Delete'),
      ),
    );
  };

  const list = cardList(deck, 'reserve', { ...options, column: { topics, preview: () => pullPreview(queue(), amount()), onDraw: drawFoot } });
  return { list, el: h('section', { class: 'deck-reserve', 'aria-label': 'Reserve' }, head, h('div', { class: 'reserve-box' }, list.el, foot)) };
}

/**
 * On a phone, holding a finger on a card row ticks it; moving the finger first (to scroll)
 * cancels, and the tap that ends a hold does not also open the card.
 */
function holdToTick(row, tick) {
  let timer = null;
  let start = null;
  const cancel = () => clearTimeout(timer);
  row.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    start = { x: e.clientX, y: e.clientY };
    timer = setTimeout(() => {
      heldAt = Date.now();
      navigator.vibrate?.(10);
      tick();
    }, 450);
  });
  row.addEventListener('pointermove', (e) => {
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) cancel();
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) row.addEventListener(type, cancel);
}
// When a hold last ticked a row. Ticking redraws the list, so the tap that ends the hold lands
// on a new row: any click just after a hold is swallowed, wherever it lands.
let heldAt = 0;
document.addEventListener(
  'click',
  (e) => {
    if (Date.now() - heldAt > 700) return;
    heldAt = 0;
    e.stopPropagation();
    e.preventDefault();
  },
  true,
);
document.addEventListener('contextmenu', (e) => Date.now() - heldAt < 700 && e.preventDefault());

/** On a phone: the deck's tabs, Cards, Reserve and (when there is anything to show) Topics. */
function deckTabs(deck, c, cards, withTopics) {
  const tabs = [
    ['cards', 'Cards', cards.length - c.reserve],
    ['reserve', 'Reserve', c.reserve],
    withTopics && ['topics', 'Topics', null],
  ].filter(Boolean);
  if (!withTopics && deckTab === 'topics') deckTab = 'cards';
  const choose = (key, focus) => {
    deckTab = key;
    render();
    if (focus) document.getElementById(`deck-tab-${key}`)?.focus();
  };
  // Arrow keys, Home and End move between the tabs, as in any tab list.
  const onkeydown = (e) => {
    const keys = tabs.map(([key]) => key);
    const at = keys.indexOf(deckTab);
    const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: keys.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    choose(keys[(to + keys.length) % keys.length], true);
  };
  return h(
    'div',
    { class: 'deck-tabs', role: 'tablist', 'aria-label': 'Show', onkeydown },
    tabs.map(([key, label, n]) =>
      h(
        'button',
        {
          type: 'button',
          role: 'tab',
          id: `deck-tab-${key}`,
          'aria-controls': key === 'topics' ? 'deck-topics' : 'deck-cards',
          'aria-selected': String(deckTab === key),
          tabindex: deckTab === key ? '0' : '-1',
          onclick: () => choose(key, false),
        },
        label,
        n !== null && h('b', null, n.toLocaleString()),
      ),
    ),
  );
}

/** On a phone, the Topics tab: what to study, managing topics, and each topic, which filters the cards. */
function topicsTab(deck, editable) {
  const now = Date.now();
  const hasTopics = (deck.topics ?? []).length > 0;
  const rows = hasTopics
    ? topicOptions(deck, null)
        .slice(1)
        .map((o) => ({ value: o.value, name: o.textContent, n: store.findCards(deck.id, { topics: [o.value] }, now).length }))
    : [];
  return h(
    'section',
    { class: 'deck-topics', id: 'deck-topics', role: 'tabpanel', 'aria-labelledby': 'deck-tab-topics' },
    h(
      'div',
      { class: 'deck-topics-actions' },
      hasTopics && h('button', { class: 'btn', type: 'button', onclick: () => openTopicPicker(deck) }, icon('play'), 'Choose what to study'),
      h('button', { class: 'btn', type: 'button', onclick: () => openTopicsDialog(deck) }, icon('check'), editable ? 'Manage topics…' : 'Topics…'),
    ),
    rows.length > 0 &&
      h(
        'ul',
        { class: 'deck-topic-list' },
        rows.map(({ value, name, n }) =>
          h(
            'li',
            null,
            h(
              'button',
              {
                type: 'button',
                onclick: () => {
                  filters = { ...filters, topics: [value] };
                  deckTab = 'cards';
                  render();
                },
              },
              h('span', null, name),
              h('b', null, n.toLocaleString()),
              icon('next'),
            ),
          ),
        ),
      ),
  );
}

/** On a phone: Add card and Study, docked at the bottom, with what Study will study above them. */
function deckDock(deck, c, editable) {
  const topics = (deck.topics ?? []).length > 0;
  return h(
    'div',
    { class: 'dock deck-dock phone-only' },
    topics && h('button', { class: 'dock-topic', type: 'button', onclick: () => openTopicPicker(deck) }, `Studying: ${filterLabel(deck, deck.studyFilter)}`, icon('next')),
    h(
      'div',
      { class: 'dock-row' },
      editable && h('button', { class: 'btn dock-add', type: 'button', title: 'Add card', 'aria-label': 'Add card', onclick: () => openCardDialog({ deckId: deck.id }) }, icon('plus')),
      c.total > 0
        ? h('a', { class: 'btn primary lg', href: `#/study/${deck.id}` }, icon('play'), `Study ${c.total.toLocaleString()}`)
        : h('button', { class: 'btn primary lg', type: 'button', disabled: true }, 'Nothing due'),
    ),
  );
}

const RATINGS = [
  { rating: Rating.Again, label: 'Again', kind: 'again' },
  { rating: Rating.Hard, label: 'Hard', kind: 'hard' },
  { rating: Rating.Good, label: 'Good', kind: 'good' },
  { rating: Rating.Easy, label: 'Easy', kind: 'easy' },
];

// Where each answer would send the card, on a logarithmic time line from a minute to a year.
const RULER_TICKS = [
  ['1m', MINUTE],
  ['1h', 60 * MINUTE],
  ['1d', DAY],
  ['1w', 7 * DAY],
  ['1mo', 30 * DAY],
  ['1y', 365 * DAY],
];
const rulerAt = (ms) => {
  const span = Math.log(365 * DAY / MINUTE);
  return Math.min(1, Math.max(0, Math.log(Math.max(ms, MINUTE) / MINUTE) / span)) * 100;
};

// Marks closer than this (in % of the ruler) are pushed apart, so each stays readable on a phone.
const RULER_GAP = 4;

function intervalRuler(options, now) {
  const at = RATINGS.map(({ rating }) => rulerAt(options[rating].due - now));
  for (let i = 1; i < at.length; i++) at[i] = Math.max(at[i], at[i - 1] + RULER_GAP);
  for (let i = at.length - 1; i >= 0; i--) at[i] = Math.min(at[i], 100 - RULER_GAP * (at.length - 1 - i));
  return h(
    'div',
    { class: 'ruler', 'aria-hidden': 'true' },
    h(
      'div',
      { class: 'ruler-line' },
      RATINGS.map(({ rating, kind }, i) => h('i', { class: `mark ${kind}`, style: `left: ${at[i]}%; --i: ${i}`, 'data-n': String(rating) })),
    ),
    h('div', { class: 'ruler-ticks' }, RULER_TICKS.map(([label, ms]) => h('span', { style: `left: ${rulerAt(ms)}%` }, label))),
  );
}

// Sessions up to this many cards show a segment per card in the progress bar.
const MAX_SEGMENTS = 24;

/** A side that is a word or a short phrase, plain text on one line, which the card sets larger. */
const isShort = (text) => text.length <= 28 && !/\n|\\[([]|\[image:/.test(text);

function currentStudyCard(deckId, now) {
  const deck = store.deck(deckId);
  let card = session.cardId && store.card(session.cardId);
  if (!card || card.deckId !== deckId || card.reserved || !inFilter(card, resolveFilter(deck, deck.studyFilter), deck)) {
    card = store.nextCard(deckId, now, deck.studyFilter);
    session.cardId = card?.id ?? null;
    session.revealed = false;
  }
  return card;
}

// How many times the answer has been shown on this device; a phone's "tap anywhere" hint
// goes away after the first few.
const HINT_KEY = 'dohrao.revealHints';
const REVEAL_HINTS = 5;
function revealCount() {
  try {
    return Number(localStorage.getItem(HINT_KEY)) || 0;
  } catch {
    return REVEAL_HINTS;
  }
}

function reveal() {
  session.revealed = true;
  const shown = revealCount();
  if (shown < REVEAL_HINTS) {
    try {
      localStorage.setItem(HINT_KEY, String(shown + 1));
    } catch {}
  }
  render();
}

function rate(rating) {
  if (!session.cardId || !session.revealed) return;
  store.answerCard(session.cardId, rating);
  session.cardId = null;
  session.done++;
  render();
}

/**
 * On a phone, swipe the shown answer to rate it: right Good, left Again, up Easy, down Hard.
 * The card follows the finger; past the threshold a stamp shows the answer and when the card
 * would come back, and letting go there rates it. Short of it the card springs back.
 */
function attachSwipe(card, options, now) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const scrollsX = (el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible';
  // A card long enough to scroll keeps up and down for scrolling. Its length can change after
  // it is drawn (an image loading), so this is checked again whenever its content resizes, and
  // once more as each drag starts.
  const fits = () => card.scrollHeight <= card.clientHeight + 1;
  let verticalAllowed = true;
  const measure = () => {
    verticalAllowed = fits();
    card.style.touchAction = verticalAllowed ? 'none' : 'pan-y';
  };
  measure();
  const resized = new ResizeObserver(() => (card.isConnected ? measure() : resized.disconnect()));
  for (const child of card.children) resized.observe(child);
  for (const img of card.querySelectorAll('img')) img.addEventListener('load', measure);
  // The stamp sits on the screen above the card, so it shows however far the card is scrolled.
  const stamp = h('div', { class: 'swipe-stamp', 'aria-hidden': 'true' });
  card.after(stamp);
  const marks = [...app.querySelectorAll('.ruler .mark')];
  let start = null;

  const show = (dx, dy) => {
    const box = { dx, dy, width: card.clientWidth, height: card.clientHeight, verticalAllowed };
    const rating = classifySwipe(box);
    const leaning = swipeLeaning(box);
    if (!reduce) {
      card.style.setProperty('--swipe-x', `${dx}px`);
      card.style.setProperty('--swipe-y', `${verticalAllowed ? dy : 0}px`);
      card.style.setProperty('--swipe-rot', `${Math.max(-8, Math.min(8, dx / 20))}deg`);
    }
    const r = RATINGS.find((x) => x.rating === rating);
    stamp.className = `swipe-stamp ${r ? `on ${r.kind}` : ''}`;
    stamp.textContent = r ? `${r.label.toUpperCase()} · ${options[rating].state === State.Review ? '' : '<'}${formatInterval(options[rating].due - now)}` : '';
    marks.forEach((mark, i) => mark.classList.toggle('lean', RATINGS[i].rating === leaning));
    return rating;
  };
  const reset = () => {
    start = null;
    card.classList.remove('swiping');
    show(0, 0);
  };

  // One finger swipes; a second one landing does not restart or steer it.
  card.addEventListener('pointerdown', (e) => {
    if (start || e.pointerType !== 'touch' || !canSwipeFrom(e.target, { scrollsX, stop: card })) return;
    measure();
    start = { x: e.clientX, y: e.clientY, id: e.pointerId };
    card.classList.add('swiping');
  });
  card.addEventListener('pointermove', (e) => {
    if (start && e.pointerId === start.id) show(e.clientX - start.x, e.clientY - start.y);
  });
  card.addEventListener('pointerup', (e) => {
    if (!start || e.pointerId !== start.id) return;
    const rating = show(e.clientX - start.x, e.clientY - start.y);
    if (rating) rate(rating);
    else reset();
  });
  card.addEventListener('pointercancel', (e) => start && e.pointerId === start.id && reset());
}

/** On a phone, the study card's tools in a sheet: edit, listen again, delete. Null when there are none. */
function cardOptions(card, deck) {
  const editable = store.editable(deck.id);
  const side = session.revealed ? 'back' : 'front';
  const items = [
    editable && h('button', { type: 'button', onclick: () => openCardDialog({ card }) }, icon('edit'), 'Edit card'),
    canSpeak() && speechText(card[side]) !== '' && h('button', { type: 'button', onclick: () => speakSideOf(card, deck, side) }, icon('speaker'), 'Listen again'),
    editable && h('button', { type: 'button', class: 'danger', onclick: () => removeCard(card) }, icon('trash'), 'Delete card'),
  ].filter(Boolean);
  return items.length > 0 && menu('Card options', items, 'more', 'phone-only');
}

function renderStudy(deck) {
  const now = Date.now();
  if (session.deckId !== deck.id) Object.assign(session, { deckId: deck.id, cardId: null, revealed: false, done: 0, spoken: null });
  const card = currentStudyCard(deck.id, now);
  const c = store.counts(deck.id, now, deck.studyFilter);
  const filtered = resolveFilter(deck, deck.studyFilter) !== null;
  const label = filterLabel(deck, deck.studyFilter);
  const total = session.done + c.total;
  const progress = total ? (session.done / total) * 100 : 100;
  // A short session shows one segment per card; a long one, a single bar.
  const bar =
    total > 1 && total <= MAX_SEGMENTS
      ? h('div', { class: 'progress segments', role: 'img', 'aria-label': `${session.done} of ${total} cards done` }, Array.from({ length: total }, (_, i) => h('i', { class: i < session.done ? 'done' : '' })))
      : h('div', { class: 'progress', role: 'img', 'aria-label': `${session.done} of ${total} cards done` }, h('div', { style: `width: ${progress}%` }));

  const top = [
    h(
      'div',
      { class: 'study-top' },
      h('a', { class: 'icon-btn', href: `#/deck/${deck.id}`, title: 'Stop studying', 'aria-label': 'Stop studying' }, icon('close')),
      h('div', { class: 'study-title' }, filtered ? `${deck.name} · ${label}` : deck.name),
      card && statusMark(cardStatus(card, now), card.state === State.Review ? 'Review' : cardStatus(card, now).label, 'state'),
      countPills(c),
      card && store.editable(deck.id) && h('div', { class: 'tools' }, iconButton('edit', 'Edit card (E)', () => openCardDialog({ card })), iconButton('trash', 'Delete card', () => removeCard(card), 'danger')),
      // On a phone: where you are in the session, and the card's tools in a sheet.
      card && h('span', { class: 'study-count phone-only' }, `${(session.done + 1).toLocaleString()} of ${total.toLocaleString()}`),
      card && cardOptions(card, deck),
    ),
    bar,
  ];

  if (!card) {
    const empty = c.cards === 0;
    // This topic is finished but the deck is not: offer the whole deck.
    const topicDone = filtered && !empty && store.counts(deck.id, now).total > 0;
    app.replaceChildren(
      h(
        'div',
        { class: 'study screen-drill' },
        top,
        h(
          'div',
          { class: 'done' },
          h('div', { class: 'badge' }, icon('check')),
          h('h1', null, empty ? 'This deck is empty' : topicDone ? `${label} is done for today` : 'All caught up'),
          h(
            'p',
            null,
            empty
              ? 'Add some cards to start studying.'
              : session.done
                ? `You reviewed ${plural(session.done, 'card')} this session. Come back tomorrow for more.`
                : filtered
                  ? `Nothing is due in ${label} right now.`
                  : 'Nothing is due in this deck right now.',
          ),
          // Tomorrow's numbers are for the whole deck, so they are left out while studying part of it.
          !empty && !filtered && h('p', null, tomorrowText(c)),
          topicDone && h('button', { class: 'btn primary', type: 'button', onclick: () => { store.updateDeck(deck.id, { studyFilter: [] }); render(); } }, 'Study everything'),
          h('a', { class: topicDone ? 'btn' : 'btn primary', href: empty ? `#/deck/${deck.id}` : '#/' }, empty ? 'Go to deck' : 'Back to decks'),
        ),
      ),
    );
    return;
  }

  const options = session.revealed ? store.previewCard(card.id, now) : null;

  // Read the side that has just appeared, once.
  const shown = `${card.id}:${session.revealed}`;
  if (session.spoken !== shown) {
    session.spoken = shown;
    const side = session.revealed ? 'back' : 'front';
    if (speaksSide(card, deck, side)) speakSideOf(card, deck, side);
    else stopSpeaking();
    if (!session.revealed && speaksSide(card, deck, 'back')) prepareSideSpeech(card, deck, 'back');
  }

  app.replaceChildren(
    h(
      'div',
      { class: 'study screen-drill' },
      top,
      h(
        'div',
        { class: 'flashcard' },
        h('div', { class: `face question ${isShort(card.front) ? 'short' : ''}` }, rich(card.front)),
        speakButton(card, deck, 'front'),
        session.revealed && [h('hr'), h('div', { class: `face answer ${isShort(card.back) ? 'short' : ''}` }, rich(card.back)), speakButton(card, deck, 'back')],
      ),
      h(
        'div',
        { class: 'answer-bar' },
        session.revealed
          ? [
              intervalRuler(options, now),
              h(
                'div',
                { class: 'ratings' },
                // Space and Enter also answer Good, so Good is the one the screen leans toward.
                RATINGS.map(({ rating, label, kind }) =>
                  h(
                    'button',
                    { class: `rate ${kind}`, type: 'button', title: rating === Rating.Good ? 'Good (3, Space or Enter)' : `${label} (${rating})`, onclick: () => rate(rating) },
                    h('span', { class: 'label' }, label),
                    h('span', { class: 'ivl' }, (options[rating].state === State.Review ? '' : '<') + formatInterval(options[rating].due - now)),
                    h('kbd', null, rating === Rating.Good ? 'Space' : String(rating)),
                  ),
                ),
              ),
            ]
          : [
              revealCount() < REVEAL_HINTS && h('p', { class: 'reveal-hint phone-only' }, 'Tap anywhere to show the answer'),
              h('button', { class: 'btn primary lg', type: 'button', onclick: reveal }, 'Show answer', h('kbd', null, 'Space')),
            ],
      ),
    ),
  );
  markOverflow(app);
  // On a phone a tap anywhere on the card shows the answer.
  const flashcard = app.querySelector('.flashcard');
  if (!session.revealed) flashcard.addEventListener('click', (e) => isPhone() && isRevealTap(e.target, flashcard) && reveal());
  else if (isPhone()) attachSwipe(flashcard, options, now);
}

// ---- Statistics -----------------------------------------------------------

// `bin` is how many days each bar of the forecast covers.
const RANGES = [
  { days: 30, bin: 1, label: '1 month', span: 'month' },
  { days: 91, bin: 7, label: '3 months', span: '3 months' },
  { days: 360, bin: 30, label: '1 year', span: 'year' },
];
let statsRange = RANGES[0];

const shortDate = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const longDate = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const monthName = new Intl.DateTimeFormat(undefined, { month: 'short' });

const sum = (list) => list.reduce((total, n) => total + n, 0);
const percent = (part, whole) => `${Math.round((part / whole) * 100)}%`;

function addDays(t, n) {
  const d = new Date(t);
  d.setDate(d.getDate() + n);
  return d;
}

/** A day key such as '2026-01-31', written out. */
const sinceDate = (key) => longDate.format(new Date(`${key}T12:00`));

// One tooltip shared by every chart.
const tip = h('div', { class: 'chart-tip', hidden: true });
let tipTimer = null;
document.body.append(tip);

/** Show `value` and `label` beside the pointer while it is over `el`. */
function withTip(el, value, label) {
  const show = (e) => {
    clearTimeout(tipTimer);
    tip.replaceChildren(h('b', null, value), h('span', null, label));
    tip.hidden = false;
    const x = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8);
    const y = e.clientY - tip.offsetHeight - 12;
    tip.style.left = `${Math.max(8, x)}px`;
    tip.style.top = `${y < 8 ? e.clientY + 18 : y}px`;
  };
  const hide = () => (tip.hidden = true);
  el.addEventListener('pointerdown', show);
  el.addEventListener('pointermove', show);
  // A finger leaves as soon as it lifts, so keep the tooltip up long enough to read.
  el.addEventListener('pointerleave', (e) => (e.pointerType === 'mouse' ? hide() : (tipTimer = setTimeout(hide, 1800))));
  return el;
}

/** The same figures as a chart, for screen readers. */
const dataTable = (caption, head, rows) =>
  h(
    'table',
    { class: 'sr-only' },
    h('caption', null, caption),
    h('thead', null, h('tr', null, head.map((text) => h('th', { scope: 'col' }, text)))),
    h('tbody', null, rows.map((row) => h('tr', null, row.map((text) => h('td', null, String(text)))))),
  );

const panel = (title, sub, ...content) =>
  h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, title), sub && h('p', null, sub)), content);

/** A round number at or above `max` for the top of an axis, and the step between its ticks. */
function axisTop(max) {
  const rough = Math.max(max, 4) / 4;
  const unit = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((m) => m * unit).find((size) => size >= rough);
  return { step, top: Math.ceil(Math.max(max, 4) / step) * step };
}

/**
 * Vertical bars from `[{ value, label, tick, parts }]`; `tick` is the text under a bar, if any,
 * and `parts`, if given, splits the bar into `[kind, value]` pieces, from the bottom up.
 */
function columnChart(items, unit) {
  const { step, top } = axisTop(Math.max(...items.map((item) => item.value)));
  const ticks = Array.from({ length: top / step + 1 }, (_, i) => i * step);
  return h(
    'div',
    { class: 'chart', 'aria-hidden': 'true' },
    h(
      'div',
      { class: 'chart-plot' },
      ticks.map((t) => h('div', { class: 'chart-tick', style: `bottom: ${(t / top) * 100}%` }, h('span', null, t >= 1000 ? `${+(t / 1000).toFixed(1)}K` : String(t)))),
      h(
        'div',
        { class: 'chart-cols' },
        items.map((item) =>
          withTip(
            h(
              'div',
              { class: 'chart-col' },
              item.value > 0 &&
                h(
                  'div',
                  { class: item.parts ? 'chart-bar split' : 'chart-bar', style: `height: ${(item.value / top) * 100}%` },
                  item.parts?.filter(([, n]) => n).map(([kind, n]) => h('i', { class: `k-${kind}`, style: `flex: ${n} 0 0` })),
                ),
            ),
            plural(item.value, unit),
            item.label,
          ),
        ),
      ),
    ),
    h('div', { class: 'chart-x' }, items.map((item) => h('span', null, item.tick ?? ''))),
  );
}

function forecastPanel(s, today) {
  const { days, bin, span } = statsRange;
  const every = { 1: 7, 7: 4, 30: 3 }[bin];
  const items = [];
  for (let i = 0; i < days; i += bin) {
    const from = addDays(today, i);
    const label =
      bin > 1
        ? `${shortDate.format(from)} to ${shortDate.format(addDays(today, i + bin - 1))}`
        : i === 0
          ? 'Today, with anything overdue'
          : longDate.format(from);
    const tick = (i / bin) % every ? null : i === 0 && bin === 1 ? 'Today' : shortDate.format(from);
    items.push({ value: sum(s.forecast.slice(i, i + bin)), label, tick });
  }
  const total = sum(s.forecast);
  const sub = total
    ? `${plural(total, 'review')} scheduled over the next ${span}, about ${+(total / days).toFixed(1)} a day.`
    : `No reviews are scheduled over the next ${span}.`;
  return panel(
    'Forecast',
    sub,
    columnChart(items, 'review'),
    dataTable('Reviews coming due', ['When', 'Reviews'], items.map((item) => [item.label, item.value])),
  );
}

/** A year of days as a grid of weeks, shaded by how many cards were answered. */
function activityPanel(s, today, deck) {
  // A phone shows the weeks that fit its width.
  const WEEKS = isPhone() ? HEAT_WEEKS.phone : HEAT_WEEKS.wide;
  const span = isPhone() ? `the last ${HEAT_WEEKS.phone} weeks` : 'the past year';
  const start = addDays(today, -((WEEKS - 1) * 7 + ((new Date(today).getDay() + 6) % 7))); // a Monday
  const days = [];
  for (let d = start; d <= today; d = addDays(d, 1)) days.push({ date: d, n: s.perDay[store.dayKey(d)] ?? 0 });
  const max = Math.max(...days.map((day) => day.n));
  const active = days.filter((day) => day.n);

  const months = [];
  for (let week = 0; week < WEEKS; week++) {
    const monday = addDays(start, week * 7);
    if (week === 0 || monday.getMonth() !== addDays(monday, -7).getMonth()) months.push({ week, name: monthName.format(monday) });
  }
  // The first month is often a sliver; drop its name when the next would run into it.
  if (months[1]?.week < 3) months.shift();

  const scroller = h(
    'div',
    { class: 'heat-scroll' },
    h('div', { class: 'heat-months' }, months.map(({ week, name }) => h('span', { style: `grid-column: ${week + 1}` }, name))),
    h(
      'div',
      { class: 'heat-grid' },
      days.map(({ date, n }) =>
        withTip(h('i', { class: `heat l${n ? Math.ceil((4 * n) / max) : 0}` }), n ? plural(n, 'review') : 'No reviews', longDate.format(date)),
      ),
    ),
  );
  const sub = active.length
    ? `${plural(sum(active.map((day) => day.n)), 'review')} on ${plural(active.length, 'day')} in ${span}.`
    : `No reviews in ${span}.`;
  const section = panel(
    'Activity',
    sub,
    h(
      'div',
      { class: 'heat-wrap' },
      h(
        'div',
        { class: 'heatmap', role: 'img', 'aria-label': `Calendar of reviews per day. ${sub}` },
        h('div', { class: 'heat-days', 'aria-hidden': 'true' }, ['Mon', '', 'Wed', '', 'Fri', '', ''].map((day) => h('span', null, day))),
        scroller,
      ),
      h(
        'div',
        { class: 'heat-key', 'aria-hidden': 'true' },
        'Less',
        [0, 1, 2, 3, 4].map((level) => h('i', { class: `heat l${level}` })),
        'More',
      ),
    ),
    deck && s.partial && h('p', { class: 'panel-note' }, `Reviews are counted for each deck separately ${s.loggedFrom ? `since ${sinceDate(s.loggedFrom)}` : 'from now on'}. Choose all decks to see earlier ones.`),
  );
  return { section, scroller };
}

const CARD_KINDS = [
  ['new', 'New', 'never studied'],
  ['learning', 'Learning', 'in their first steps, or being relearned'],
  ['young', 'Young', 'in review, with an interval under 21 days'],
  ['mature', 'Mature', 'in review, with an interval of 21 days or more'],
];

function cardsPanel(s) {
  const total = sum(Object.values(s.cards));
  return panel(
    'Cards',
    `${plural(total, 'card')} by how well you know them.`,
    h(
      'div',
      { class: 'stack', 'aria-hidden': 'true' },
      CARD_KINDS.filter(([kind]) => s.cards[kind]).map(([kind, label]) =>
        withTip(h('div', { class: `k-${kind}`, style: `flex-grow: ${s.cards[kind]}` }), plural(s.cards[kind], 'card'), `${label}, ${percent(s.cards[kind], total)}`),
      ),
    ),
    h(
      'ul',
      { class: 'legend' },
      CARD_KINDS.map(([kind, label, meaning]) =>
        h(
          'li',
          { title: `${label}: ${meaning}` },
          h('i', { class: `k-${kind}` }),
          h('span', null, label),
          h('b', null, s.cards[kind].toLocaleString()),
          h('span', { class: 'share' }, percent(s.cards[kind], total)),
        ),
      ),
    ),
  );
}

function answersPanel(s) {
  const { span } = statsRange;
  const names = RATINGS.map((r) => r.label);
  const max = Math.max(...s.answers.flat());
  const since = s.partial && s.loggedFrom && `Recorded since ${sinceDate(s.loggedFrom)}; reviews before that are not broken down.`;
  if (!max) {
    const message = s.partial && !s.loggedFrom ? 'Dohrao has only just started recording which button you press. Study some cards to see the breakdown here.' : `No answers in the past ${span}.`;
    return panel('Answer buttons', null, h('p', { class: 'panel-empty' }, message));
  }
  return panel(
    'Answer buttons',
    `How often you pressed each button over the past ${span}, by the kind of card.`,
    h(
      'div',
      { class: 'answers', 'aria-hidden': 'true' },
      s.answers.map((counts, kind) => {
        const total = sum(counts);
        return h(
          'div',
          { class: 'answer-kind' },
          h('div', { class: 'answer-head' }, h('b', null, store.ANSWER_KINDS[kind]), h('span', null, total ? `${percent(total - counts[0], total)} correct` : 'No answers')),
          h(
            'div',
            { class: 'answer-cols' },
            counts.map((n, i) =>
              withTip(
                h('div', { class: 'answer-col' }, h('span', { class: 'cap' }, n.toLocaleString()), h('div', { class: 'chart-bar', style: `height: ${(n / max) * 96}px` }), h('span', null, names[i])),
                plural(n, 'answer'),
                total ? `${names[i]} on ${store.ANSWER_KINDS[kind].toLowerCase()} cards, ${percent(n, total)}` : names[i],
              ),
            ),
          ),
        );
      }),
    ),
    dataTable('Answers by kind of card', ['Kind', ...names], s.answers.map((counts, kind) => [store.ANSWER_KINDS[kind], ...counts])),
    since && h('p', { class: 'panel-note' }, since),
  );
}

function renderStats(deck) {
  const now = Date.now();
  const decks = store.decks();
  const s = store.statistics(deck?.id, statsRange.days, now);
  const today = new Date(dayStart(now));
  const reviews = [...s.answers[1], ...s.answers[2]];
  const reviewed = sum(reviews);
  const hasCards = sum(Object.values(s.cards)) > 0;

  const deckSelect = h(
    'select',
    { 'aria-label': 'Deck', onchange: () => (location.hash = deckSelect.value ? `#/stats/${deckSelect.value}` : '#/stats') },
    h('option', { value: '' }, 'All decks'),
    decks.map((d) => h('option', { value: d.id, selected: d.id === deck?.id }, d.name)),
  );
  const activity = hasCards && activityPanel(s, today, deck);

  app.replaceChildren(
    h(
      'div',
      { class: 'page' },
      topbar(),
      deck && h('a', { class: 'back', href: `#/deck/${deck.id}` }, icon('back'), deck.name),
      h('div', { class: 'page-head', style: deck ? 'margin-top: 14px' : null }, h('h1', null, 'Statistics')),
      hasCards
        ? [
            h(
              'div',
              { class: 'filters stats-filters' },
              decks.length > 1 && deckSelect,
              h(
                'div',
                { class: 'segmented', role: 'group', 'aria-label': 'Period' },
                RANGES.map((range) =>
                  h(
                    'button',
                    {
                      type: 'button',
                      'aria-pressed': String(range === statsRange),
                      onclick: () => {
                        statsRange = range;
                        render();
                      },
                    },
                    range.label,
                  ),
                ),
              ),
            ),
            h(
              'div',
              { class: 'summary' },
              h('div', { class: 'stat' }, h('b', null, String(s.forecast[0])), s.forecast[0] === 1 ? 'review due today' : 'reviews due today'),
              h('div', { class: 'stat' }, h('b', null, String(s.reviewedToday)), 'reviewed today'),
              h('div', { class: 'stat' }, h('b', null, String(s.streak)), 'day streak'),
              reviewed > 0 &&
                h(
                  'div',
                  { class: 'stat', title: `Reviews you answered Hard, Good or Easy over the past ${statsRange.span}. Cards still being learned are not counted.` },
                  h('b', null, percent(reviewed - reviews[0] - reviews[4], reviewed)),
                  'retention',
                ),
            ),
            forecastPanel(s, today),
            activity.section,
            cardsPanel(s),
            answersPanel(s),
          ]
        : h(
            'div',
            { class: 'empty' },
            h('h2', null, 'Nothing to show yet'),
            h('p', null, 'Add some cards and study them. Your progress will be charted here.'),
            h('a', { class: 'btn primary', href: deck ? `#/deck/${deck.id}` : '#/' }, deck ? 'Go to deck' : 'Go to decks'),
          ),
    ),
  );
  // Show the most recent weeks when the calendar is wider than the screen.
  if (activity) activity.scroller.scrollLeft = activity.scroller.scrollWidth;
}

// ---- Upcoming -------------------------------------------------------------

// How many days ahead of today the page lists, and how often the chart labels a day.
const AHEAD = [
  { days: 7, every: 1, label: '1 week', span: 'week' },
  { days: 30, every: 7, label: '1 month', span: 'month' },
  { days: 90, every: 14, label: '3 months', span: '3 months' },
];
let ahead = AHEAD[0];

const dayName = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' });

// The kinds of card counted each day, as `store.upcoming` names them, and their colours.
const UPCOMING_KINDS = [
  ['new', 'New', 'new'],
  ['learning', 'Learning', 'learning'],
  ['review', 'Due', 'young'],
];

const breakdown = (day) => UPCOMING_KINDS.map(([kind, label]) => `${day[kind].toLocaleString()} ${label.toLowerCase()}`).join(', ');

function renderUpcoming(deck) {
  const now = Date.now();
  const decks = store.decks();
  const all = store.upcoming(deck?.id, Math.max(31, ahead.days + 1), now);
  const days = all.slice(0, ahead.days + 1);
  const name = (day, i) => (i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : dayName.format(day.start));
  const cards = deck ? store.cardsIn(deck.id) : decks.flatMap((d) => store.cardsIn(d.id));
  const hasCards = cards.length > 0;
  const reserve = cards.some((c) => c.reserved);

  const deckSelect = h(
    'select',
    { 'aria-label': 'Deck', onchange: () => (location.hash = deckSelect.value ? `#/upcoming/${deckSelect.value}` : '#/upcoming') },
    h('option', { value: '' }, 'All decks'),
    decks.map((d) => h('option', { value: d.id, selected: d.id === deck?.id }, d.name)),
  );
  const stat = (n, label) => h('div', { class: 'stat' }, h('b', null, n.toLocaleString()), label);
  const ahead7 = sum(all.slice(1, 8).map((d) => d.total));
  const ahead30 = sum(all.slice(1, 31).map((d) => d.total));

  const items = days.map((day, i) => ({
    value: day.total,
    label: `${i < 2 ? `${name(day, i)}, ${dayName.format(day.start)}` : longDate.format(day.start)}: ${breakdown(day)}`,
    tick: i % ahead.every ? null : i === 0 ? 'Today' : ahead.every === 1 ? weekday.format(day.start) : shortDate.format(day.start),
    parts: [...UPCOMING_KINDS].reverse().map(([kind, , colour]) => [colour, day[kind]]),
  }));
  const total = sum(days.slice(1).map((d) => d.total));
  const busiest = days.slice(1).reduce((best, day) => (day.total > best.total ? day : best), { total: 0 });
  const sub = total
    ? `${plural(total, 'card')} over the next ${ahead.span}, about ${+(total / ahead.days).toFixed(1)} a day. The busiest day is ${dayName.format(busiest.start)}, with ${busiest.total.toLocaleString()}.`
    : `Nothing comes up over the next ${ahead.span}.`;

  const table = h(
    'table',
    { class: 'upcoming' },
    h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Day'), UPCOMING_KINDS.map(([, label]) => h('th', { scope: 'col' }, label)), h('th', { scope: 'col' }, 'Total'))),
    h(
      'tbody',
      null,
      days.map((day, i) =>
        h(
          'tr',
          { class: [!day.total && 'none', i > 0 && new Date(day.start).getDay() === 1 && 'week-start'].filter(Boolean).join(' ') },
          h('th', { scope: 'row' }, name(day, i), i < 2 && h('span', null, dayName.format(day.start))),
          UPCOMING_KINDS.map(([kind]) => h('td', { class: day[kind] ? kind : null }, day[kind] ? day[kind].toLocaleString() : '–')),
          h('td', null, h('b', null, day.total.toLocaleString())),
        ),
      ),
    ),
  );

  app.replaceChildren(
    h(
      'div',
      { class: 'page' },
      topbar(),
      deck && h('a', { class: 'back', href: `#/deck/${deck.id}` }, icon('back'), deck.name),
      h('div', { class: 'page-head', style: deck ? 'margin-top: 14px' : null }, h('h1', null, 'Upcoming')),
      hasCards
        ? [
            h(
              'div',
              { class: 'filters stats-filters' },
              decks.length > 1 && deckSelect,
              h(
                'div',
                { class: 'segmented', role: 'group', 'aria-label': 'How far ahead' },
                AHEAD.map((range) =>
                  h(
                    'button',
                    {
                      type: 'button',
                      'aria-pressed': String(range === ahead),
                      onclick: () => {
                        ahead = range;
                        render();
                      },
                    },
                    range.label,
                  ),
                ),
              ),
            ),
            h('div', { class: 'summary' }, stat(all[0].total, 'today'), stat(all[1].total, 'tomorrow'), stat(ahead7, 'in the next 7 days'), stat(ahead30, 'in the next 30 days')),
            panel(
              'Cards each day',
              sub,
              columnChart(items, 'card'),
              h(
                'ul',
                { class: 'legend' },
                UPCOMING_KINDS.map(([kind, label, colour]) => h('li', null, h('i', { class: `k-${colour}` }), h('span', null, label), h('b', null, sum(days.map((d) => d[kind])).toLocaleString()))),
              ),
            ),
            panel(
              'Day by day',
              null,
              h('div', { class: 'table-scroll' }, table),
              h(
                'p',
                { class: 'panel-note' },
                'New cards are counted at each deck’s daily limit, supposing you study every day. The cards you study will come back on later days too, so those days fill up as you go.',
                reserve ? ' Cards on reserve are not counted until they are pulled in.' : '',
              ),
            ),
          ]
        : h(
            'div',
            { class: 'empty' },
            h('h2', null, 'Nothing coming up'),
            h('p', null, 'Add some cards and study them. The days they come back on will be listed here.'),
            h('a', { class: 'btn primary', href: deck ? `#/deck/${deck.id}` : '#/' }, deck ? 'Go to deck' : 'Go to decks'),
          ),
    ),
  );
}

// ---- Signing in -----------------------------------------------------------

const AUTH_ERRORS = {
  'bad-invite': 'That invite code doesn’t work. Check it with whoever sent it.',
  'username-taken': 'That username is taken.',
  'weak-password': 'Your password needs at least 8 characters.',
  'bad-username': 'Your username can only use 3–32 letters, numbers, dots, dashes or underscores, with no spaces.',
  'bad-name': 'Enter your name, up to 60 characters.',
  'bad-login': 'Wrong username or password.',
  'rate-limited': 'Too many attempts. Try again in a few minutes.',
};

/** What to say when logging in or signing up fails with `error`. */
function authMessage(error) {
  if (error instanceof TypeError) return 'Can’t reach Dohrao. Check your connection.';
  return AUTH_ERRORS[error.message] ?? 'Something went wrong. Try again.';
}

/**
 * A labelled, required input. `plain` fields (usernames, codes) are not capitalised or corrected.
 * A `hint` under the field says what it takes before anyone gets it wrong.
 */
function authField(label, attrs, plain = false, hint = null) {
  const input = h('input', { required: true, ...attrs, ...(plain && { autocapitalize: 'none' }) });
  if (plain) {
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('spellcheck', 'false');
  }
  return h('label', { class: 'field' }, h('span', null, label), input, hint && h('small', null, hint));
}

/** The login form, or with `mode` 'signup' the form that creates an account from an invite code. */
function renderAuth(mode) {
  const signup = mode === 'signup';
  const fields = signup
    ? [
        authField('Invite code', { name: 'code', autocomplete: 'off' }, true),
        authField('Your name', { name: 'name', autocomplete: 'name', maxlength: 60 }),
        authField('Username', { name: 'username', autocomplete: 'username', maxlength: 32 }, true, 'Letters, numbers, dots, dashes or underscores, with no spaces.'),
        authField('Password', { name: 'password', type: 'password', autocomplete: 'new-password', minLength: 8 }, false, 'At least 8 characters.'),
      ]
    : [
        authField('Username', { name: 'username', autocomplete: 'username' }, true),
        authField('Password', { name: 'password', type: 'password', autocomplete: 'current-password' }),
      ];
  const error = h('p', { class: 'auth-error', role: 'alert' });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, signup ? 'Create account' : 'Log in');
  const form = h(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        const values = Object.fromEntries(new FormData(form));
        submit.disabled = true;
        error.textContent = '';
        try {
          if (signup) await api.signUp(values);
          else await api.logIn(values.username, values.password);
          // A new account starts at home; logging in again stays where the session ended.
          if (signup) history.replaceState(null, '', location.pathname + location.search);
          location.reload();
        } catch (err) {
          error.textContent = authMessage(err);
          submit.disabled = false;
        }
      },
    },
    fields,
    error,
    submit,
  );
  const sub = signup
    ? 'You need an invite code from whoever invited you to Dohrao. They can see your study progress.'
    : store.storageInfo().signedOut
      ? 'Your session ended. Log in again and nothing you did here is lost.'
      : 'Pick up where you left off.';
  app.replaceChildren(
    h(
      'main',
      { class: 'auth', 'data-mode': mode },
      brand('p'),
      h('h1', null, signup ? 'Create your account' : 'Log in'),
      h('p', { class: 'sub' }, sub),
      form,
      h('p', { class: 'auth-switch' }, signup ? h('a', { href: '#/' }, 'Have an account? Log in') : h('a', { href: '#/signup' }, 'Have an invite code? Sign up')),
    ),
  );
}

/** Shown when the server cannot be reached at all as the app starts. */
function renderOffline() {
  app.replaceChildren(
    h(
      'main',
      { class: 'auth offline' },
      brand('p'),
      h('h1', null, 'Can’t reach Dohrao. Check your connection.'),
      h('button', { class: 'btn primary', type: 'button', onclick: () => location.reload() }, 'Try again'),
    ),
  );
}

// ---- Admin ----------------------------------------------------------------
// People, invite codes and the decks the admin gives. Loaded from the server on arrival and
// after each change; `fresh` is cleared on leaving, so coming back loads it again.

const adminState = { data: null, fresh: false, error: false };
const listFormat = new Intl.ListFormat(undefined, { type: 'conjunction' });

async function loadAdmin() {
  adminState.fresh = true;
  try {
    const [users, invites, decks, progress] = await Promise.all([api.admin.users(), api.admin.invites(), api.admin.decks(), api.admin.progress()]);
    adminState.data = { users, invites, decks, progress };
    adminState.error = false;
  } catch (error) {
    // The session ended, perhaps by resetting your own password: log in again.
    if (error.message === 'signed-out') return location.reload();
    adminState.error = true;
  }
  if (route().view === 'admin' && !document.querySelector('dialog[open]')) render();
}

/** Run an admin change, say `done` (or what `done` makes of its result), then load the screen again. */
async function adminChange(change, done) {
  let result;
  try {
    result = await change();
  } catch {
    toast('Could not save that. Try again.');
    return;
  }
  toast(typeof done === 'function' ? done(result) : done);
  await loadAdmin();
}

const adminRow = (main, meta, ...actions) =>
  h('li', { class: 'admin-row' }, h('div', { class: 'admin-main' }, main, h('span', { class: 'admin-meta' }, meta)), h('div', { class: 'admin-actions' }, actions));

function openResetDialog(user) {
  const password = h('input', { type: 'password', name: 'password', required: true, minLength: 8, autocomplete: 'new-password' });
  const error = h('p', { class: 'auth-error', role: 'alert' });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Set password');
  const form = h(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        submit.disabled = true;
        error.textContent = '';
        try {
          await api.admin.resetPassword(user.id, password.value);
        } catch (err) {
          error.textContent = err.message === 'not-found' ? 'That account no longer exists.' : authMessage(err);
          submit.disabled = false;
          return;
        }
        dialog.close();
        toast(`Password changed for ${user.name}`);
      },
    },
    h('label', { class: 'field' }, h('span', null, 'New password'), password, h('small', null, `${user.name} is logged out everywhere and logs in with this password.`)),
    error,
    h('div', { class: 'modal-foot' }, h('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, 'Cancel'), submit),
  );
  const dialog = modal(`Reset password for ${user.name}`, form, { narrow: true, onclose: render });
  password.focus();
}

function openGiveDialog(deck, users) {
  const people = users.filter((u) => u.id !== account.id);
  const had = new Set(deck.recipients.filter((r) => r.active).map((r) => r.userId));
  const boxes = people.map((u) => h('input', { type: 'checkbox', value: u.id, checked: had.has(u.id) }));
  const nameOf = (id) => people.find((u) => u.id === id).name;
  const form = h(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        const now = new Set(boxes.filter((box) => box.checked).map((box) => box.value));
        const added = [...now].filter((id) => !had.has(id));
        const removed = [...had].filter((id) => !now.has(id));
        dialog.close();
        if (!added.length && !removed.length) return;
        const said = [
          added.length && `Given to ${listFormat.format(added.map(nameOf))}`,
          removed.length && `${added.length ? 'taken' : 'Taken'} back from ${listFormat.format(removed.map(nameOf))}`,
        ].filter(Boolean);
        await adminChange(async () => {
          if (added.length) await api.admin.assign(deck.id, added);
          if (removed.length) await api.admin.unassign(deck.id, removed);
        }, said.join(', '));
      },
    },
    people.length
      ? [
          h('p', { class: 'message' }, 'They study it with their own progress and cannot change its cards. Taking it back hides it from them and keeps their progress.'),
          h('div', { class: 'give-list' }, people.map((u, i) => h('label', { class: 'check' }, boxes[i], h('span', null, u.name, ' ', h('span', { class: 'give-user' }, u.username))))),
        ]
      : h('p', { class: 'message' }, 'No one else has an account yet. Make an invite code and send it to them.'),
    h(
      'div',
      { class: 'modal-foot' },
      h('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, 'Cancel'),
      people.length > 0 && h('button', { class: 'btn primary', type: 'submit' }, 'Save'),
    ),
  );
  const dialog = modal(`Give “${deck.name}” to…`, form, { narrow: true, onclose: render });
  boxes[0]?.focus();
}

function copyCode(code) {
  const copied = navigator.clipboard?.writeText(code) ?? Promise.reject();
  copied.then(() => toast(`Copied ${code}`), () => toast(`Could not copy. The code is ${code}`));
}

function peopleSection({ users }) {
  return h(
    'section',
    { class: 'admin-section', 'aria-label': 'People' },
    h('div', { class: 'section-head' }, h('h2', null, 'People')),
    h(
      'ul',
      { class: 'admin-list' },
      users.map((u) =>
        adminRow(
          h('b', null, u.name),
          u.role === 'admin' ? `${u.username} · admin` : u.username,
          h('button', { class: 'btn', type: 'button', onclick: () => openResetDialog(u) }, icon('key'), 'Reset password'),
        ),
      ),
    ),
  );
}

function invitesSection({ invites }) {
  const active = invites.filter((invite) => !invite.revoked && invite.usesLeft > 0);
  const uses = h('input', { type: 'number', required: true, min: 1, max: 20, step: 1, value: 1, 'aria-label': 'Uses' });
  return h(
    'section',
    { class: 'admin-section', 'aria-label': 'Invite codes' },
    h(
      'div',
      { class: 'section-head' },
      h('h2', null, 'Invite codes'),
      h(
        'form',
        {
          class: 'actions invite-new',
          onsubmit: (e) => {
            e.preventDefault();
            adminChange(() => api.admin.createInvite(Number(uses.value)), ({ code }) => `Invite code ${code} made`);
          },
        },
        h('label', { class: 'uses' }, h('span', null, 'Uses'), uses),
        h('button', { class: 'btn primary', type: 'submit' }, icon('plus'), 'New invite code'),
      ),
    ),
    h(
      'ul',
      { class: 'admin-list' },
      active.length
        ? active.map((invite) =>
            adminRow(
              h('b', { class: 'invite-code' }, invite.code),
              `${plural(invite.usesLeft, 'use')} left · made ${shortDate.format(invite.created)}`,
              iconButton('copy', `Copy ${invite.code}`, () => copyCode(invite.code)),
              iconButton('close', `Revoke ${invite.code}`, () => adminChange(() => api.admin.revokeInvite(invite.code), `Invite code ${invite.code} revoked`), 'danger'),
            ),
          )
        : h('li', { class: 'admin-empty' }, 'No active invite codes. Make one to let someone sign up.'),
    ),
  );
}

function decksSection({ decks, users }) {
  const given = (deck) => {
    const names = deck.recipients.filter((r) => r.active).map((r) => r.name);
    return names.length ? `Given to ${listFormat.format(names)}` : 'Not given to anyone';
  };
  return h(
    'section',
    { class: 'admin-section', 'aria-label': 'Your decks' },
    h('div', { class: 'section-head' }, h('h2', null, 'Your decks')),
    h(
      'ul',
      { class: 'admin-list' },
      decks.length
        ? decks.map((deck) =>
            adminRow(
              h('b', null, deck.name),
              `${plural(deck.cards, 'card')} · ${given(deck)}`,
              h('button', { class: 'btn', type: 'button', onclick: () => openGiveDialog(deck, users) }, icon('share'), 'Give to…'),
            ),
          )
        : h('li', { class: 'admin-empty' }, 'You have no decks yet.'),
    ),
  );
}

// ---- Progress (admin only) -----------------------------------------------
// How each person is getting on. Days are counted in this device's time, like Stats.

const STATUS_LABELS = { known: 'known well', learning: 'learning', struggling: 'struggling', waiting: 'waiting', reserve: 'on reserve' };
const relativeDays = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

/** "today", "yesterday", "5 days ago" or "never", for a day key like '2026-01-31'. */
function lastStudiedText(key) {
  if (!key) return 'never';
  const [y, m, d] = key.split('-').map(Number);
  const days = Math.round((dayStart(Date.now()) - dayStart(new Date(y, m - 1, d, 12).getTime())) / DAY);
  return relativeDays.format(-days, 'day');
}

/** A row of small squares, one per day, filled on days with answers. */
function dayStrip(days) {
  return h(
    'span',
    { class: 'day-strip', role: 'img', 'aria-label': `Studied on ${plural(days.filter((d) => d.n).length, 'day')} of the last ${days.length}` },
    days.map((d) => withTip(h('i', { class: d.n ? 'on' : '' }), d.n ? plural(d.n, 'answer') : 'No answers', d.key)),
  );
}

/** One bar split by status: known well, learning, struggling, waiting, then the reserve. */
function progressBar(p) {
  const parts = ['known', 'learning', 'struggling', 'waiting', 'reserve'];
  return h(
    'span',
    { class: 'prog-bar', role: 'img', 'aria-label': `${p.known} known well, ${p.learning} learning, ${p.struggling} struggling, ${p.waiting} waiting, ${p.reserve} on reserve` },
    parts.map((part) => p[part] > 0 && h('i', { class: `prog-${part}`, style: `flex-grow: ${p[part]}` })),
  );
}

function progressSection({ progress }) {
  return h(
    'section',
    { class: 'admin-section', 'aria-label': 'Progress' },
    h('div', { class: 'section-head' }, h('h2', null, 'Progress')),
    h(
      'ul',
      { class: 'admin-list progress-list' },
      progress.map((p) => {
        const r = recentStudy(p.daily, Date.now());
        const learned = sum(p.decks.map((d) => d.learned));
        const total = sum(p.decks.map((d) => d.total));
        return h(
          'li',
          null,
          h(
            'a',
            { class: 'progress-row', href: `#/admin/${encodeURIComponent(p.user.id)}` },
            h('b', { class: 'progress-name' }, p.user.name),
            dayStrip(r.last14),
            h('span', { class: 'progress-fact' }, r.streak ? `${r.streak}-day streak` : 'no streak'),
            h('span', { class: 'progress-fact' }, total ? `${learned.toLocaleString()} of ${total.toLocaleString()} learned` : 'no decks yet'),
            h('span', { class: 'progress-fact muted' }, `last studied ${lastStudiedText(r.lastStudied)}`),
          ),
        );
      }),
    ),
  );
}

const personState = { id: null, data: null, error: false, query: '' };

async function loadPerson(id) {
  personState.id = id;
  personState.data = null;
  personState.error = false;
  personState.query = '';
  try {
    personState.data = await api.admin.personProgress(id);
  } catch (error) {
    if (error.message === 'signed-out') return location.reload();
    personState.error = true;
  }
  if (route().view === 'admin' && personState.id === id) render();
}

function renderPerson(id) {
  if (account.role !== 'admin') return;
  if (personState.id !== id) loadPerson(id);
  const p = personState.data;
  const back = h('a', { class: 'btn', href: '#/admin' }, icon('back'), 'Admin');
  if (!p) {
    app.replaceChildren(
      h(
        'div',
        { class: 'page' },
        topbar(),
        h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Progress')), back),
        personState.error
          ? h('div', { class: 'empty' }, h('h2', null, 'Could not load this person'), h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => loadPerson(id) }, 'Try again')))
          : h('p', { class: 'admin-empty' }, 'Loading…'),
      ),
    );
    return;
  }
  const now = Date.now();
  const r = recentStudy(p.daily, now);
  const right = rightShare(p.log, null, now);
  const summary = [
    `Studied ${r.daysIn30} of the last 30 days`,
    r.streak ? `${r.streak}-day streak` : 'no streak',
    `${plural(r.answersIn7, 'answer')} this week`,
    `${plural(r.answersIn30, 'answer')} in 30 days`,
    right !== null && `right ${Math.round(right * 100)}% of the time`,
    `last studied ${lastStudiedText(r.lastStudied)}`,
  ].filter(Boolean);

  const decks = p.decks.map((d) => {
    const share = rightShare(p.log, d.id, now);
    return h(
      'div',
      { class: 'person-deck' },
      h('h3', null, d.name, d.assigned ? h('span', { class: 'muted' }, ' · given by ', d.from) : h('span', { class: 'muted' }, ' · their own')),
      progressBar(d),
      h(
        'p',
        { class: 'muted' },
        [
          `${d.known.toLocaleString()} known well`,
          `${d.learning.toLocaleString()} learning`,
          `${d.struggling.toLocaleString()} struggling`,
          `${d.waiting.toLocaleString()} waiting`,
          `${d.reserve.toLocaleString()} on reserve`,
        ].join(' · '),
        h('br'),
        `Pulled in ${d.pulledIn.toLocaleString()} of ${d.total.toLocaleString()} cards`,
        share !== null ? ` · right ${Math.round(share * 100)}% of the time in the last 30 days` : '',
      ),
    );
  });

  const deckName = Object.fromEntries(p.decks.map((d) => [d.id, d.name]));
  const order = { struggling: 0, learning: 1, known: 2 };
  const list = h('ul', { class: 'person-cards' });
  const drawCards = () => {
    const q = personState.query.trim().toLowerCase();
    const shown = p.cards
      .filter((c) => !q || `${speechText(c.front)} ${speechText(c.back)}`.toLowerCase().includes(q))
      .sort((a, b) => order[a.status] - order[b.status] || b.lapses - a.lapses || a.due - b.due);
    list.replaceChildren(
      ...(shown.length
        ? shown.map((c) =>
            h(
              'li',
              null,
              h('span', { class: 'person-card-text' }, speechText(c.front), h('span', { class: 'muted' }, ' → '), speechText(c.back)),
              h(
                'span',
                { class: `person-card-status status-${c.status}` },
                STATUS_LABELS[c.status],
                c.lapses ? ` · forgot ${c.lapses}×` : '',
                ` · due ${lastStudiedText(store.dayKey(c.due))}`,
                p.decks.length > 1 ? ` · ${deckName[c.deckId] ?? ''}` : '',
              ),
            ),
          )
        : [h('li', { class: 'muted' }, p.cards.length ? 'No cards match.' : 'No cards started yet.')]),
    );
  };
  drawCards();
  const search = h('input', {
    type: 'search',
    placeholder: 'Search cards',
    'aria-label': 'Search cards',
    value: personState.query,
    oninput: () => {
      personState.query = search.value;
      drawCards();
    },
  });

  app.replaceChildren(
    h(
      'div',
      { class: 'page' },
      topbar(),
      h('div', { class: 'page-head' }, h('div', null, h('h1', null, p.user.name), h('p', { class: 'sub' }, summary.join(' · '))), back),
      activityPanel({ perDay: p.daily }, new Date(dayStart(now)), null).section,
      h('section', { class: 'admin-section', 'aria-label': 'Decks' }, h('div', { class: 'section-head' }, h('h2', null, 'Decks')), decks.length ? decks : h('p', { class: 'muted' }, 'No decks yet.')),
      h(
        'section',
        { class: 'admin-section', 'aria-label': 'Cards started' },
        h('div', { class: 'section-head' }, h('h2', null, `Cards started (${p.cards.length.toLocaleString()})`)),
        h('div', { class: 'search person-search' }, icon('search'), search),
        list,
      ),
    ),
  );
}

function renderAdmin() {
  if (!adminState.fresh) loadAdmin();
  const d = adminState.data;
  const body = d
    ? [progressSection(d), peopleSection(d), invitesSection(d), decksSection(d)]
    : adminState.error
      ? h('div', { class: 'empty' }, h('h2', null, 'Could not load this page'), h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: loadAdmin }, 'Try again')))
      : h('p', { class: 'admin-empty' }, 'Loading…');
  app.replaceChildren(
    h(
      'div',
      { class: 'page' },
      topbar(),
      h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Admin'), h('p', { class: 'sub' }, 'People, invite codes and the decks you give.'))),
      body,
    ),
  );
}

// ---- Routing and shortcuts ------------------------------------------------

function route() {
  const [, view = '', id] = location.hash.split('/');
  return { view, id, deck: id && store.deck(id) };
}

function render() {
  const { view, id, deck } = route();
  if (offline) return;
  if (!account || store.storageInfo().signedOut) {
    session.deckId = session.cardId = null;
    stopSpeaking();
    // A dialog left open would sit over the login form.
    for (const open of document.querySelectorAll('dialog[open]')) open.close();
    const mode = view === 'signup' ? 'signup' : 'login';
    // Leave a form being filled in alone when nothing about it changed.
    if (app.querySelector(`.auth[data-mode="${mode}"]`)) return;
    return renderAuth(mode);
  }
  if (view !== 'study' && session.deckId) {
    session.deckId = null;
    stopSpeaking();
  }
  if (view !== 'deck') {
    query = '';
    filtersDeck = null;
  }
  if (view !== 'admin') adminState.fresh = false;
  if (view !== 'admin' || !id) personState.id = null;
  tip.hidden = true;
  if (view === 'admin' && account.role !== 'admin') {
    history.replaceState(null, '', '#/');
    renderHome();
  } else if (view === 'admin' && id) renderPerson(decodeURIComponent(id));
  else if (view === 'admin') renderAdmin();
  else if (view === 'deck' && deck) renderDeck(deck);
  else if (view === 'study' && deck) renderStudy(deck);
  else if (view === 'stats') renderStats(deck);
  else if (view === 'upcoming') renderUpcoming(deck);
  else renderHome();
}

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (document.querySelector('dialog[open]')) return;
  if (e.target.closest?.('input, textarea, select, button, a')) return;
  if (route().view !== 'study' || !session.cardId) return;

  if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault();
    if (session.revealed) rate(Rating.Good);
    else reveal();
  } else if (session.revealed && ['1', '2', '3', '4'].includes(e.key)) {
    rate(Number(e.key));
  } else if (e.key.toLowerCase() === 'r' && canSpeak()) {
    // Replay: the side this deck reads aloud, or else whichever side appeared last.
    const card = store.card(session.cardId);
    const deck = store.deck(card.deckId);
    const side = deck.speak === 'front' || !session.revealed ? 'front' : 'back';
    speakSideOf(card, deck, side);
  } else if (e.key.toLowerCase() === 'e' && store.editable(session.deckId)) {
    e.preventDefault();
    openCardDialog({ card: store.card(session.cardId) });
  }
});

window.addEventListener('hashchange', () => {
  window.scrollTo(0, 0);
  render();
});

// Counts change as the day rolls over and learning steps come due. Another device may also have
// changed the state meanwhile; when it is reloaded, the listener below renders it.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (!document.querySelector('dialog[open]') && route().view !== 'study') render();
  if (!document.querySelector('dialog[open]')) store.refresh();
});

applyTheme();
try {
  const [{ signedIn }, me] = await Promise.all([store.load(), api.me().catch(() => null)]);
  // Signed in even if the name did not come back; the menu then just says "Account".
  if (signedIn) account = me?.user ?? {};
  store.onStorageChange((message) => {
    render();
    if (message) toast(message);
  });
  applyTheme();
  render();
} catch {
  offline = true;
  applyTheme();
  renderOffline();
}
