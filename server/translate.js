// Translation of a card's Portuguese into Urdu, through Google's public gtx endpoint.
const ENDPOINT = 'https://translate.googleapis.com/translate_a/single';

/** Reads Google's array response: the Urdu script and its romanisation. */
export function parseGoogle(json) {
  const segments = Array.isArray(json?.[0]) ? json[0] : [];
  const urdu = segments
    .filter((s) => typeof s?.[0] === 'string' && typeof s?.[1] === 'string')
    .map((s) => s[0])
    .join('');
  if (!urdu) throw new Error('bad-response');
  const roman = segments.find((s) => s?.[0] === null && s?.[1] === null && typeof s?.[2] === 'string');
  return { urdu, urduRoman: roman ? roman[2] : '' };
}

export function createTranslator({ fetch = globalThis.fetch, timeoutMs = 15000 } = {}) {
  return {
    async toUrdu(text) {
      const params = new URLSearchParams({ client: 'gtx', sl: 'pt', tl: 'ur', q: text });
      params.append('dt', 't');
      params.append('dt', 'rm');
      const res = await fetch(`${ENDPOINT}?${params}`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`google-${res.status}`);
      return parseGoogle(await res.json());
    },
  };
}
