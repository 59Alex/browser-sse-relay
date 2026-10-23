import { SseRelayClient, LocalStorageCheckpointStore } from '/lib/index.js';

const config = await fetch('/api/config').then(response => response.json());
const storage = new LocalStorageCheckpointStore(localStorage, 'browser-sse-relay:failure-demo:');
let session, generation = 0, value = 0, handled = 0, duplicates = 0, failCheckpoint = false, lastResult;
const seen = new Set(), lines = [], connections = [];
const element = id => document.getElementById(id);
function log(message) { lines.push(message); if (lines.length > 100) lines.shift(); element('log').textContent = lines.join('\n'); }
function render() {
  element('value').textContent = String(value);
  element('effects').textContent = `${handled} / ${duplicates}`;
  element('cursor').textContent = session?.committedCursor ?? 'none';
}
const checkpoint = {
  load: (...args) => storage.load(...args), clear: (...args) => storage.clear(...args),
  async save(...args) {
    if (failCheckpoint) { failCheckpoint = false; log('CHECKPOINT failure injected after handler effect'); throw new Error('Injected checkpoint failure'); }
    await storage.save(...args);
    setTimeout(render, 0);
  },
};
async function stop() { if (session) { session.stop(); await session.start(); } }
async function start(initialCursor) {
  await stop();
  const current = ++generation;
  session = new SseRelayClient({
    scope: config.scope, checkpoint,
    ...(initialCursor === undefined ? {} : { initialCursor }),
    url: ({ attempt }) => {
      const replica = (attempt - 1) % 2;
      connections.push(replica === 0 ? 'a' : 'b');
      log(`CONNECT relay ${replica === 0 ? 'A' : 'B'} attempt ${attempt}`);
      return config.relayUrls[replica];
    },
    headers: () => ({ Authorization: `Bearer ${config.token}` }),
    retry: { maxAttempts: 8, minDelayMs: 300, maxDelayMs: 1500, jitter: 0.1 },
    onState(state) { if (current === generation) { element('state').textContent = state; log(`STATE ${state}`); render(); } },
    async onEvent(event, context) {
      if (!context.isCurrent() || current !== generation) return;
      const payload = JSON.parse(event.data);
      if (seen.has(event.id)) duplicates++;
      seen.add(event.id); if (seen.size > 100) seen.delete(seen.values().next().value);
      handled++; value = payload.value;
      log(`EVENT ${event.id} value=${value}`); render();
    },
  });
  const active = session;
  void active.start().then(result => {
    if (current !== generation) return;
    lastResult = result;
    log(`RESULT ${result.state}: ${result.reason}`); render();
  });
}
async function publish(count = 1) {
  const response = await fetch(`/api/publish?count=${count}`, { method: 'POST' });
  if (!response.ok) throw new Error(`Publish failed: ${response.status}`);
  return response.json();
}
async function snapshotAndResume() {
  await stop();
  const snapshot = await fetch('/api/snapshot').then(response => response.json());
  // State is installed before the matching cursor is provided to a fresh session.
  value = snapshot.value; seen.clear(); log(`SNAPSHOT value=${value} cursor=${snapshot.cursor}`); render();
  await start(snapshot.cursor);
}
async function expireHistory() { await stop(); await publish(20); await start(); }
async function logout() {
  if (session) await session.logout();
  generation++; value = 0; handled = 0; duplicates = 0; seen.clear();
  element('state').textContent = 'closed'; render(); log('LOGOUT cursor cleared; no automatic restart');
}
const actions = {
  start: () => start(), publish: () => publish(),
  drop: async () => { await fetch('/api/drop', { method: 'POST' }); await publish(3); },
  checkpoint: async () => { failCheckpoint = true; await publish(); },
  expire: expireHistory, snapshot: snapshotAndResume, logout,
};
for (const [id, action] of Object.entries(actions)) {
  element(id).addEventListener('click', () => { void action().catch(error => log(`ERROR ${error.message}`)); });
}
window.demo = { metrics: () => ({ value, handled, duplicates, state: session?.state ?? 'idle', cursor: session?.committedCursor ?? null,
  lastResult, connections: [...connections], scope: config.scope }), snapshotAndResume, expireHistory, logout };
log('Ready. Start the session, then inject a failure.');
