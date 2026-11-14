// Calls to the Recall server for accounts and the admin screen.

/**
 * Send one request and resolve to the parsed JSON answer (null when there is none).
 * A refusal throws `Error(code)`, with the server's error code, 'rate-limited' for too many
 * attempts, or the status when the answer names no code.
 */
async function call(method, path, body) {
  const res = await fetch(path, {
    method,
    cache: 'no-store',
    ...(body !== undefined && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON; only the status says what happened.
  }
  if (res.status === 429) throw new Error('rate-limited');
  if (!res.ok) throw new Error(data?.error ?? String(res.status));
  return data;
}

const part = encodeURIComponent;

/** The signed-in user: `{ user }`. */
export const me = () => call('GET', 'api/me');
export const logIn = (username, password) => call('POST', 'api/login', { username, password });
export const signUp = ({ code, username, name, password }) => call('POST', 'api/signup', { code, username, name, password });
export const logOut = () => call('POST', 'api/logout');

export const admin = {
  users: () => call('GET', 'api/admin/users'),
  invites: () => call('GET', 'api/admin/invites'),
  createInvite: (uses) => call('POST', 'api/admin/invites', { uses }),
  revokeInvite: (code) => call('DELETE', `api/admin/invites/${part(code)}`),
  decks: () => call('GET', 'api/admin/decks'),
  assign: (deckId, userIds) => call('POST', `api/admin/decks/${part(deckId)}/assign`, { userIds }),
  unassign: (deckId, userIds) => call('POST', `api/admin/decks/${part(deckId)}/unassign`, { userIds }),
  setUrdu: (deckId, userId, on) => call('POST', `api/admin/decks/${part(deckId)}/urdu`, { userId, on }),
  resetPassword: (userId, password) => call('POST', `api/admin/users/${part(userId)}/password`, { password }),
  sort: (deckId) => call('POST', `api/admin/decks/${part(deckId)}/sort`),
  sortStatus: (deckId) => call('GET', `api/admin/decks/${part(deckId)}/sort`),
  propose: (deckId) => call('POST', `api/admin/decks/${part(deckId)}/propose`),
  proposal: (deckId) => call('GET', `api/admin/decks/${part(deckId)}/proposal`),
  approve: (deckId, body) => call('POST', `api/admin/decks/${part(deckId)}/proposal/approve`, body),
  progress: () => call('GET', 'api/admin/progress'),
  personProgress: (userId) => call('GET', `api/admin/progress/${part(userId)}`),
};
