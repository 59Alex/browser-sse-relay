import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
run('npm', ['run', 'build']);
await mkdir('output', { recursive: true });
const [packed] = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', 'output']));
assert.equal(packed.name, '@59alex/browser-sse-relay');
assert.ok(packed.files.some(file => file.path === 'dist/index.d.ts'));
assert.ok(packed.files.some(file => file.path === 'dist/server/index.d.ts'));
for (const doc of ['README.md', 'ROADMAP.md', 'docs/index.md', 'docs/v0.1.0/guide.en.md', 'docs/v0.1.0/guide.ru.md']) {
  assert.ok(packed.files.some(file => file.path === doc), `Missing packaged documentation: ${doc}`);
}
assert.ok(!packed.files.some(file => /(^|\/)(node_modules|test|demo|output|\.git)(\/|$)/u.test(file.path)));
const consumer = await mkdtemp(join(tmpdir(), 'browser-sse-relay-consumer-'));
try {
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'relay-clean-consumer', private: true, type: 'module' }));
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', resolve('output', packed.filename), '@types/node@24.19.2'], consumer);
  await writeFile(join(consumer, 'consumer.ts'), `
import { SseRelayClient, MemoryCheckpointStore, type StreamScope, type RelayOptions } from '@59alex/browser-sse-relay';
import { MemoryEventStore, createNodeRelay } from '@59alex/browser-sse-relay/server';
const scope: StreamScope = { accountId: 'consumer', streamId: 'events' };
const options: RelayOptions = { scope, url: 'http://localhost/events', checkpoint: new MemoryCheckpointStore(), onEvent: async event => { event.id.toUpperCase(); } };
new SseRelayClient(options);
const store = new MemoryEventStore();
createNodeRelay({ store, authenticate: () => 'consumer', stream: () => 'events' });
`);
  run(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--lib', 'ES2022,DOM', 'consumer.ts'], consumer);
  await writeFile(join(consumer, 'consumer.mjs'), `
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { SseRelayClient, MemoryCheckpointStore } from '@59alex/browser-sse-relay';
import { MemoryEventStore, createNodeRelay } from '@59alex/browser-sse-relay/server';
const scope = { accountId: 'consumer', streamId: 'events' };
const store = new MemoryEventStore();
const record = store.append(scope, 'hello from packed package');
const relay = createNodeRelay({ store, authenticate: () => 'consumer', stream: () => 'events' });
const server = createServer((req, res) => { void relay(req, res); });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const seen = [];
const client = new SseRelayClient({ scope, url: 'http://127.0.0.1:' + server.address().port,
  checkpoint: new MemoryCheckpointStore(), onEvent: async event => { seen.push(event.data); },
  onState: state => { if (state === 'live') client.stop(); } });
try {
  const result = await client.start();
  assert.equal(result.state, 'closed'); assert.equal(result.cursor, record.id);
  assert.deepEqual(seen, ['hello from packed package']);
  console.log('Clean consumer imports, declarations, relay and checkpoint: PASS');
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
`);
  // Type-check the real versioned guide snippets against the installed artifact.
  const guide = await readFile('docs/v0.1.0/guide.en.md', 'utf8');
  const translated = await readFile('docs/v0.1.0/guide.ru.md', 'utf8');
  const blocks = text => [...text.matchAll(/```ts\n([\s\S]*?)\n```/gu)].map(match => match[1]);
  const snippets = blocks(guide);
  assert.deepEqual(blocks(translated), snippets, 'EN/RU guide examples must match');
  assert.equal(snippets.length, 6);
  await writeFile(join(consumer, 'guide-browser.ts'), [snippets[0], snippets[1], snippets[2], snippets[3], snippets[5]].join('\n'));
  await writeFile(join(consumer, 'guide-server.ts'), snippets[4]);
  run(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--lib', 'ES2022,DOM', 'guide-browser.ts', 'guide-server.ts'], consumer);
  const readmeSnippets = blocks(await readFile('README.md', 'utf8'));
  assert.equal(readmeSnippets.length, 2);
  assert.equal(readmeSnippets[0], readmeSnippets[1], 'README EN/RU examples must match');
  await writeFile(join(consumer, 'readme.ts'), readmeSnippets[0]);
  run(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--lib', 'ES2022,DOM', 'readme.ts'], consumer);
  const result = run(process.execPath, ['consumer.mjs'], consumer);
  await writeFile('output/package-smoke.json', JSON.stringify({ package: packed.filename, bytes: packed.size, unpackedBytes: packed.unpackedSize, files: packed.files.map(file => file.path), result: result.trim() }, null, 2) + '\n');
  console.log(JSON.stringify({ package: packed.filename, bytes: packed.size, unpackedBytes: packed.unpackedSize, result: result.trim() }, null, 2));
} finally {
  // This directory is created by mkdtemp above and contains only this smoke test's consumer.
  await rm(consumer, { recursive: true, force: true });
}
