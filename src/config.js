// The ONLY place repo coordinates appear. Engineering rule: one source of truth,
// no hardcoded URLs scattered through the code.

export const CONFIG = {
  api: 'https://api.github.com',
  owner: 'Hamza-ai-eng',       // repo owner; the app lets you override it in Setup
  repo: 'daytracker-data',     // PRIVATE repo. Never the app repo.
  path: 'days.enc.json',
  branch: 'main',
  commitName: 'daytracker',
  commitEmail: 'daytracker@localhost',
};

// Storage keys. Namespaced so nothing else on the origin can collide.
export const KEYS = {
  token: 'dt.github_token',
  passphrase: 'dt.passphrase',
  lastSync: 'dt.last_sync',
  lastSha: 'dt.last_sha',
  lastStreams: 'dt.last_streams',
  syncError: 'dt.sync_error',
  owner: 'dt.owner',
};
