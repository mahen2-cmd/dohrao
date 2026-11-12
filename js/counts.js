// Merging answer counts kept on two devices.

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Combine two copies of the answer counts (`daily` or `log`), keeping the larger count at each
 * place: per day, and per deck and kind of answer within `log`. What only one copy has is kept,
 * so a day counted on one device is not lost when another saves its own.
 */
export function mergeCounts(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return Math.max(a, b);
  if (Array.isArray(a) && Array.isArray(b)) {
    return Array.from({ length: Math.max(a.length, b.length) }, (_, i) => (i in a ? (i in b ? mergeCounts(a[i], b[i]) : a[i]) : b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const out = { ...a };
    for (const [key, value] of Object.entries(b)) out[key] = key in a ? mergeCounts(a[key], value) : value;
    return out;
  }
  return b ?? a;
}
