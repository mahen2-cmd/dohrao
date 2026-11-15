// Pure helpers that decide where a card's Urdu goes and when it shows.
// Shared by the browser and the server.
import { speechText } from './content.js';

/** The card fields that hold Urdu. */
export const URDU_FIELDS = ['urdu', 'urduRoman', 'urduOf', 'urduBy'];

/** Whether `user` may switch on Urdu translation for a deck; the server translates only the admin's. */
export const canTranslateDecks = (user) => user?.role === 'admin';

/** What a card's English side can show. */
export const FRONTS = ['en', 'ur', 'both'];

/** What an assignment row's switch sets the front to; a row from before `front` existed is Urdu when on. */
export const switchedFront = (row) => row.front ?? (row.urdu === 1 ? 'ur' : 'en');

const SIDES = ['front', 'back'];

/** The side of a card that holds Portuguese. A reversed copy swaps the sides. */
export function portugueseSide(card, deck) {
  const backIsPortuguese = String(deck.backLang ?? '').startsWith('pt');
  return backIsPortuguese !== Boolean(card.reversed) ? 'back' : 'front';
}

/** The side of a card that holds English: the other one. */
export const englishSide = (card, deck) => SIDES[1 - SIDES.indexOf(portugueseSide(card, deck))];

/** What the Portuguese side says, without images, maths or markup. */
export const portugueseText = (card, deck) => speechText(card[portugueseSide(card, deck)] ?? '').trim();

/** True when the card has no Urdu yet, or its Urdu is stale and wasn't written by hand. */
export function needsUrdu(card, deck) {
  if (!deck.urdu) return false;
  const text = portugueseText(card, deck);
  if (!text) return false;
  return !card.urdu || (card.urduBy !== 'manual' && card.urduOf !== text);
}

/** What the English side shows: 'en', 'ur' or 'both'. The newer of the person's choice and the admin's switch wins. */
export function frontShows(deck) {
  const own = deck.frontShows;
  // The switch is 'en', 'ur' or 'both'; true and false are its older form (Urdu, English).
  const switched = deck.urduSwitch == null ? undefined : typeof deck.urduSwitch === 'string' ? deck.urduSwitch : (deck.urduSwitch ? 'ur' : 'en');
  if (!own) return switched ?? 'en';
  if (!switched) return own;
  return (deck.frontShowsAt ?? 0) >= (deck.urduSwitchAt ?? 0) ? own : switched;
}

/** The English side of a card as it should be shown: its English and Urdu, either of which may be absent. */
export function shownSide(card, deck) {
  const choice = frontShows(deck);
  const hasUrdu = Boolean(deck.urdu && card.urdu);
  const showsUrdu = hasUrdu && choice !== 'en';
  const roman = deck.urduScript === 'roman' && card.urduRoman;
  return {
    english: showsUrdu && choice === 'ur' ? null : card[englishSide(card, deck)],
    urdu: showsUrdu ? (roman ? card.urduRoman : card.urdu) : null,
    urduLang: roman ? 'ur-Latn' : 'ur',
  };
}
