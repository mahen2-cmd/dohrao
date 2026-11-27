// The "How it works" page's text, in English, Urdu script and Roman Urdu, and the two decisions
// it makes without a page: which language to start in, and whether a key press opens it.
// Button names, counts and keys stay in English in every language, as the interface shows them.

import { frontShows } from './urdu.js';

/** The toggle's choices, in order: language code and label. */
export const HELP_LANGS = [
  ['en', 'English'],
  ['ur', 'اردو'],
  ['ur-Latn', 'Roman Urdu'],
];

/** Where the browser remembers the chosen language. */
export const HELP_LANG_KEY = 'dohrao.helpLang';

const KEYS = [['Space', 'Enter'], ['1', '2', '3', '4'], ['R'], ['E'], ['H'], ['Ctrl+Z'], ['?']];
const keys = (labels) => KEYS.map((k, i) => [k, labels[i]]);

/**
 * Each language's page. A section has `steps` (a numbered list), `terms` (a term and its
 * meaning), `text` (paragraphs) or `keys` (key names and what they do).
 */
export const HELP = {
  en: {
    title: 'How it works',
    intro: 'Dohrao is a flashcard app. It shows you each card again just before you would forget it, so a few minutes a day is enough to remember a lot.',
    sections: [
      {
        id: 'daily',
        heading: 'Every day',
        steps: [
          'Open Dohrao once a day and press Start review.',
          'Read the front of the card and try to remember the back. Then press Show answer.',
          'Press a button to say how well you remembered.',
          'When nothing is left, you are done for the day.',
        ],
        text: ['Missed a day? That’s fine. Your cards wait for you.'],
      },
      {
        id: 'buttons',
        heading: 'The four buttons',
        terms: [
          ['Again', 'You forgot. The card comes back in a few minutes.'],
          ['Hard', 'You remembered, with effort. It comes back sooner than with Good.'],
          ['Good', 'You remembered. This is the usual answer.'],
          ['Easy', 'It took no effort. It comes back much later.'],
        ],
        text: ['Under each button is when the card would come back. Answer honestly: the schedule only works if your answers are true.'],
      },
      {
        id: 'counts',
        heading: 'New, Learning and Due',
        terms: [
          ['New', 'Cards you haven’t studied yet. A few join each day.'],
          ['Learning', 'Cards you saw recently. They come back later the same day.'],
          ['Due', 'Cards you know, back today to check you still remember them.'],
        ],
      },
      {
        id: 'reserve',
        heading: 'The reserve',
        text: [
          'Cards on the reserve are kept out of study until you pull them in.',
          'A deck someone gives you starts on your reserve, so at first it says Nothing due. Open the deck, choose how many cards to pull in, and press Pull in. They become New cards. Pull in more whenever you are ready.',
        ],
      },
      {
        id: 'keys',
        heading: 'Keyboard shortcuts (on a computer)',
        keys: keys([
          'Show the answer, then answer Good',
          'Again, Hard, Good, Easy',
          'Read the card aloud again',
          'Edit the card',
          'Back to your decks',
          'Undo your last answer',
          'Open this page',
        ]),
      },
    ],
  },
  ur: {
    title: 'یہ کیسے کام کرتا ہے',
    intro: 'دہراؤ ایک فلیش کارڈ ایپ ہے۔ یہ ہر کارڈ آپ کو عین اُس وقت دوبارہ دکھاتی ہے جب آپ اسے بھولنے والے ہوں، اس لیے روزانہ چند منٹ بہت کچھ یاد رکھنے کے لیے کافی ہیں۔',
    sections: [
      {
        id: 'daily',
        heading: 'ہر روز',
        steps: [
          'دن میں ایک بار دہراؤ کھولیں اور Start review دبائیں۔',
          'کارڈ کا سامنے والا حصہ پڑھیں اور پیچھے والا حصہ یاد کرنے کی کوشش کریں۔ پھر Show answer دبائیں۔',
          'ایک بٹن دبا کر بتائیں کہ آپ کو کتنا اچھا یاد تھا۔',
          'جب کچھ باقی نہ رہے تو آج کا کام ختم۔',
        ],
        text: ['کوئی دن رہ گیا؟ کوئی بات نہیں۔ آپ کے کارڈ آپ کا انتظار کریں گے۔'],
      },
      {
        id: 'buttons',
        heading: 'چار بٹن',
        terms: [
          ['Again', 'آپ بھول گئے۔ کارڈ چند منٹ میں واپس آئے گا۔'],
          ['Hard', 'یاد تھا، مگر مشکل سے۔ یہ Good کے مقابلے میں جلدی واپس آئے گا۔'],
          ['Good', 'آپ کو یاد تھا۔ عام طور پر یہی جواب ہوتا ہے۔'],
          ['Easy', 'بالکل آسان تھا۔ یہ کافی دیر بعد واپس آئے گا۔'],
        ],
        text: ['ہر بٹن کے نیچے لکھا ہوتا ہے کہ کارڈ کب واپس آئے گا۔ ایمانداری سے جواب دیں: شیڈول تبھی ٹھیک چلتا ہے جب آپ کے جواب سچے ہوں۔'],
      },
      {
        id: 'counts',
        heading: 'New، Learning اور Due',
        terms: [
          ['New', 'وہ کارڈ جو آپ نے ابھی تک نہیں پڑھے۔ ہر روز چند نئے کارڈ شامل ہوتے ہیں۔'],
          ['Learning', 'وہ کارڈ جو آپ نے ابھی حال ہی میں دیکھے۔ یہ اسی دن بعد میں دوبارہ آتے ہیں۔'],
          ['Due', 'وہ کارڈ جو آپ جانتے ہیں، آج یہ دیکھنے کے لیے واپس آئے ہیں کہ آپ کو اب بھی یاد ہیں۔'],
        ],
      },
      {
        id: 'reserve',
        heading: 'ریزرو',
        text: [
          'ریزرو پر رکھے کارڈ پڑھائی میں شامل نہیں ہوتے، جب تک آپ انہیں خود نہ لائیں۔',
          'کسی کا دیا ہوا ڈیک شروع میں آپ کے ریزرو پر ہوتا ہے، اس لیے پہلے اس پر Nothing due لکھا آتا ہے۔ ڈیک کھولیں، چنیں کہ کتنے کارڈ لانے ہیں، اور Pull in دبائیں۔ یہ New کارڈ بن جائیں گے۔ جب بھی تیار ہوں، اور لے آئیں۔',
        ],
      },
      {
        id: 'keys',
        heading: 'کی بورڈ شارٹ کٹ (کمپیوٹر پر)',
        keys: keys([
          'جواب دکھائیں، پھر Good',
          'Again، Hard، Good، Easy',
          'کارڈ دوبارہ سنیں',
          'کارڈ میں تبدیلی کریں',
          'اپنے ڈیکس پر واپس جائیں',
          'آخری جواب واپس لیں',
          'یہ صفحہ کھولیں',
        ]),
      },
    ],
  },
  'ur-Latn': {
    title: 'Yeh kaise kaam karta hai',
    intro: 'Dohrao aik flashcard app hai. Yeh har card aap ko ain us waqt dobara dikhati hai jab aap usay bhoolne wale hon, is liye roz chand minute bohat kuch yaad rakhne ke liye kaafi hain.',
    sections: [
      {
        id: 'daily',
        heading: 'Har roz',
        steps: [
          'Din mein aik baar Dohrao kholein aur Start review dabayein.',
          'Card ka saamne wala hissa parhein aur peeche wala hissa yaad karne ki koshish karein. Phir Show answer dabayein.',
          'Aik button daba kar batayein ke aap ko kitna acha yaad tha.',
          'Jab kuch baqi na rahe to aaj ka kaam khatam.',
        ],
        text: ['Koi din reh gaya? Koi baat nahin. Aap ke cards aap ka intezar karenge.'],
      },
      {
        id: 'buttons',
        heading: 'Chaar button',
        terms: [
          ['Again', 'Aap bhool gaye. Card chand minute mein wapas aaye ga.'],
          ['Hard', 'Yaad tha, magar mushkil se. Yeh Good ke muqablay mein jaldi wapas aaye ga.'],
          ['Good', 'Aap ko yaad tha. Aam taur par yehi jawab hota hai.'],
          ['Easy', 'Bilkul aasaan tha. Yeh kaafi der baad wapas aaye ga.'],
        ],
        text: ['Har button ke neeche likha hota hai ke card kab wapas aaye ga. Imandari se jawab dein: schedule tabhi theek chalta hai jab aap ke jawab sachay hon.'],
      },
      {
        id: 'counts',
        heading: 'New, Learning aur Due',
        terms: [
          ['New', 'Woh cards jo aap ne abhi tak nahin parhe. Har roz chand naye cards shamil hote hain.'],
          ['Learning', 'Woh cards jo aap ne abhi haal hi mein dekhe. Yeh usi din baad mein dobara aate hain.'],
          ['Due', 'Woh cards jo aap jaante hain, aaj yeh dekhne ke liye wapas aaye hain ke aap ko ab bhi yaad hain.'],
        ],
      },
      {
        id: 'reserve',
        heading: 'Reserve',
        text: [
          'Reserve par rakhe cards parhai mein shamil nahin hote, jab tak aap unhein khud na layein.',
          'Kisi ka diya hua deck shuru mein aap ke reserve par hota hai, is liye pehle us par Nothing due likha aata hai. Deck kholein, chunein ke kitne cards lane hain, aur Pull in dabayein. Yeh New cards ban jayenge. Jab bhi tayyar hon, aur le aayein.',
        ],
      },
      {
        id: 'keys',
        heading: 'Keyboard shortcuts (computer par)',
        keys: keys([
          'Jawab dikhayein, phir Good',
          'Again, Hard, Good, Easy',
          'Card dobara sunein',
          'Card mein tabdeeli karein',
          'Apne decks par wapas jayein',
          'Aakhri jawab wapas lein',
          'Yeh safha kholein',
        ]),
      },
    ],
  },
};

/**
 * The language the page starts in: the saved choice if it is one of the toggle's, else the Urdu
 * writing of the first deck whose front shows Urdu, else English. `decks` is undefined signed out.
 */
export function initialHelpLang(saved, decks) {
  if (HELP_LANGS.some(([code]) => code === saved)) return saved;
  const urdu = (decks ?? []).find((deck) => frontShows(deck) !== 'en');
  if (!urdu) return 'en';
  return urdu.urduScript === 'roman' ? 'ur-Latn' : 'ur';
}

/** Whether a key press opens the page: `?` (Shift is how it is typed), with no Ctrl, Cmd or Alt, and not while typing. */
export const isHelpKey = ({ key, ctrlKey, metaKey, altKey, typing }) => key === '?' && !ctrlKey && !metaKey && !altKey && !typing;
