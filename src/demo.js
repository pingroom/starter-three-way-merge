import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson } from './storage.js';
import { step, localReport } from './merge.js';
import { mockApi, CONFIG, ROOM_CODE } from './mock.js';

const directory = await mkdtemp(join(tmpdir(), 'pingroom-merge-demo-'));
const input = await readJson(new URL('../examples/merge.json', import.meta.url), 16384);
const now = () => '2026-01-01T09:00:00.000Z';
const api = mockApi(now);
const options = { client: api.client, directory, input, config: CONFIG, token: 'offline-fixture-token', room: ROOM_CODE, now };
try {
  const pending = await step(options);
  const conflict = pending.fields.find((field) => field.status === 'pending');
  api.answer(conflict.provenance.questionId, 'theirs');
  await step(options);
  const result = await localReport(directory, input, { save: true });
  console.log(JSON.stringify({ demo: 'One conflict resolved; independent additions, deletion, and edits preserved. All transport is mocked.',
    status: result.status, snapshotHashes: result.snapshotHashes, proposal: result.proposal,
    fields: result.fields.map(({ field, kind, selected, reason }) => ({ field, kind, selected, reason })) }, null, 2));
  const sends = api.calls.filter((call) => call.method === 'POST').length;
  await step(options);
  if (api.calls.filter((call) => call.method === 'POST').length !== sends) throw new Error('Replay sent another question.');
} finally { await rm(directory, { recursive: true, force: true }); }
