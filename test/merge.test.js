import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, localReport } from '../src/merge.js';
import { readJson, atomicJson, acquireLock } from '../src/storage.js';
import { validateInput, validateState, planMerge, conflictsFor, requestFor, hash, iso } from '../src/model.js';
import { loadConnection, loadEnvironment } from '../src/config.js';
import { makeClient } from '../src/client.js';
import { mockApi, CONFIG, ROOM_CODE, OTHER, ASKER, id } from '../src/mock.js';

const example = await readJson(new URL('../examples/merge.json', import.meta.url), 16384);
const inputFor = (base, ours, theirs) => ({ mergeId: 'fixture', title: 'Example preferences', base, ours, theirs });
const twoConflicts = () => inputFor({ a: 'base', b: 'base' }, { a: 'ours', b: 'ours' }, { a: 'theirs', b: 'theirs' });
async function setup(t, input = structuredClone(example)) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-merge-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = { value: '2026-01-01T09:00:00.000Z' }, now = () => clock.value;
  const api = mockApi(now);
  const options = { client: api.client, directory, input, config: structuredClone(CONFIG), token: 'offline-fixture-token', room: ROOM_CODE, now };
  return { directory, clock, api, options, run: (extra = {}) => step({ ...options, ...extra }), saved: () => readJson(join(directory, 'state.json')) };
}
const sends = (api) => api.calls.filter((call) => call.method === 'POST').length;

test('independent edits, equal additions and deletion merge without asking about them', async (t) => {
  const s = await setup(t); const before = structuredClone(s.options.input);
  let result = await s.run(); assert.equal(result.status, 'pending'); assert.equal(result.proposal, null);
  assert.equal(sends(s.api), 1); assert.equal(s.api.questions.get(id(1)).data.field, 'theme');
  s.api.answer(id(1), 'theirs'); result = await s.run();
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.proposal.record, { font_size: 16, line_numbers: false, show_tips: false, theme: 'system' });
  assert.deepEqual(s.options.input, before); assert.equal(result.proposal.hash, hash(result.proposal.record));
  assert.equal(result.snapshotHashes.base, hash(before.base));
  const evidence = result.fields.find((f) => f.field === 'theme').provenance;
  assert.equal(evidence.questionId, id(1)); assert.equal(evidence.askerId, ASKER); assert.equal(evidence.resolverId, CONFIG.participant.id);
  const calls = s.api.calls.length; assert.equal((await s.run()).status, 'complete'); assert.equal(s.api.calls.length, calls);
});

test('equal edits and untouched values finish with no creation POST, including three empty records', async (t) => {
  for (const input of [inputFor({ mode: 'day', size: 2 }, { mode: 'night', size: 2 }, { mode: 'night', size: 2 }), inputFor({}, {}, {})]) {
    const s = await setup(t, input); const result = await s.run();
    assert.equal(result.status, 'complete'); assert.deepEqual(result.proposal.record, input.ours); assert.equal(sends(s.api), 0);
  }
});

test('null, missing, empty strings, false and zero stay distinct through merge planning', () => {
  const cases = [
    [inputFor({}, { x: null }, {}), 'ours', { present: true, value: null }],
    [inputFor({ x: null }, {}, { x: null }), 'ours', { present: false }],
    [inputFor({ x: '' }, { x: '' }, { x: false }), 'theirs', { present: true, value: false }],
    [inputFor({ x: 1 }, {}, {}), 'ours', { present: false }],
    [inputFor({}, { x: false }, { x: 0 }), null, null],
    [inputFor({ x: null }, {}, { x: '' }), null, null],
  ];
  for (const [input, selected, value] of cases) {
    const field = planMerge(input)[0]; assert.equal(field.selected, selected);
    if (selected !== null) assert.deepEqual(field[selected], value); else assert.equal(field.kind, 'conflict');
  }
});

test('edit-versus-delete conflict can select deletion, edited value, or original base explicitly', async (t) => {
  for (const [choice, expected] of [['ours', {}], ['theirs', { theme: 'dark' }], ['base', { theme: 'light' }]]) {
    const s = await setup(t, inputFor({ theme: 'light' }, {}, { theme: 'dark' })); await s.run();
    const q = s.api.questions.get(id(1)); assert.match(q.prompt, /Ours: MISSING \(no property\)/);
    s.api.answer(id(1), choice); assert.deepEqual((await s.run()).proposal.record, expected);
  }
});

test('concurrent different additions can choose missing base without confusing it with literal text', async (t) => {
  const s = await setup(t, inputFor({}, { name: 'MISSING (no property)' }, { name: null })); await s.run();
  const q = s.api.questions.get(id(1)); assert.match(q.prompt, /Base: MISSING \(no property\)/);
  assert.match(q.prompt, /Ours: "MISSING \(no property\)"/); assert.match(q.prompt, /Theirs: null/);
  s.api.answer(id(1), 'base'); assert.deepEqual((await s.run()).proposal.record, {});
});

test('conflicts use stable field order and each invocation creates or reads only one question', async (t) => {
  const s = await setup(t, twoConflicts());
  assert.equal((await s.run()).status, 'pending'); assert.equal((await s.run()).status, 'pending'); assert.equal(sends(s.api), 1);
  s.api.answer(id(1), 'ours'); assert.equal((await s.run()).status, 'ready'); assert.equal(sends(s.api), 1);
  await s.run(); assert.equal(sends(s.api), 2); assert.equal(s.api.questions.get(id(2)).data.field, 'b');
  s.api.answer(id(2), 'theirs'); assert.deepEqual((await s.run()).proposal.record, { a: 'ours', b: 'theirs' });
  await s.run(); assert.equal(sends(s.api), 2);
});

test('Leave unresolved is attributed and terminal; later conflicts can resolve but no candidate is emitted', async (t) => {
  const s = await setup(t, twoConflicts()); await s.run(); s.api.answer(id(1), 'unresolved');
  let result = await s.run(); assert.equal(result.status, 'ready'); assert.equal(result.proposal, null);
  await s.run(); s.api.answer(id(2), 'ours'); result = await s.run();
  assert.equal(result.status, 'incomplete'); assert.equal(result.proposal, null);
  assert.deepEqual(result.unresolvedFields, [{ field: 'a', status: 'answered', choice: 'unresolved' }]);
  await s.run(); assert.equal(sends(s.api), 2);
});

test('expiry and cancellation remain unresolved and never cause another question for that field', async (t) => {
  for (const terminal of ['expired', 'cancelled']) {
    const s = await setup(t); await s.run();
    if (terminal === 'expired') s.clock.value = '2026-01-01T09:16:00.000Z';
    s.api.terminal(id(1), terminal); const result = await s.run();
    assert.equal(result.status, 'incomplete'); assert.equal(result.proposal, null);
    assert.equal(result.unresolvedFields[0].status, terminal); assert.equal(result.unresolvedFields[0].choice, null);
    await s.run(); assert.equal(sends(s.api), 1);
  }
});

test('lost response blocks later fields; exact-ID recovery reads the original request without resend', async (t) => {
  const s = await setup(t, twoConflicts()); s.api.controls.loseNext = true;
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal((await s.run()).status, 'create_unknown');
  assert.deepEqual((await s.run({ command: 'find' })).candidates, [{ id: id(1), state: 'pending' }]);
  s.api.answer(id(1), 'ours'); assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'ready');
  assert.equal(sends(s.api), 1);
});

test('malformed create response and empty search never authorize a new POST', async (t) => {
  const s = await setup(t); s.api.controls.malformedNext = true; await assert.rejects(s.run());
  assert.equal((await s.saved()).attempts[0].status, 'creating'); s.api.questions.clear();
  assert.deepEqual((await s.run({ command: 'find' })).candidates, []);
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal(sends(s.api), 1);
});

test('recovery validates exact target, room, request, options, data and non-handoff provenance', async (t) => {
  for (const mutate of [
    (q) => { q.target_user_id = OTHER; }, (q) => { q.room.code = 'WRONG1234567'; }, (q) => { q.prompt = 'Other prompt'; },
    (q) => { q.options[0].primary = true; }, (q) => { q.options[0].destructive = true; }, (q) => { q.options.reverse(); },
    (q) => { q.data.field = 'other'; }, (q) => { q.data.input_hash = 'changed'; }, (q) => { delete q.is_handoff; },
    (q) => { q.is_handoff = true; }, (q) => { q.asker.type = 'user'; }, (q) => { q.resolution_policy = 'all'; },
  ]) {
    const s = await setup(t); s.api.controls.loseNext = true; await s.run(); mutate(s.api.questions.get(id(1)));
    await assert.rejects(s.run({ command: 'recover', attachId: id(1) })); assert.equal((await s.saved()).attempts[0].status, 'creating');
    assert.equal(sends(s.api), 1);
  }
});

test('wrong, missing, typed or unknown answers never resolve a merge conflict', async (t) => {
  for (const mutate of [
    (q) => { q.answer.responder.id = OTHER; }, (q) => { q.answer.responder = null; },
    (q) => { q.answer.text = 'ours'; }, (q) => { q.answer.value = 'unknown'; }, (q) => { q.answer.label = 'Wrong'; },
  ]) {
    const s = await setup(t); await s.run(); s.api.answer(id(1), 'ours'); mutate(s.api.questions.get(id(1)));
    const result = await s.run(); assert.equal(result.observedStatus, 'invalid_answer'); assert.equal(result.proposal, null);
    await s.run(); assert.equal(sends(s.api), 1);
  }
});

test('original asker, lifetime and intent remain bound across reads and across conflicts', async (t) => {
  for (const mutate of [
    (q) => { q.asker.id = OTHER; },
    (q) => { q.created_at = '2026-01-01T09:00:01.000Z'; q.expires_at = '2026-01-01T09:15:01.000Z'; },
  ]) {
    const s = await setup(t); await s.run(); mutate(s.api.questions.get(id(1))); await assert.rejects(s.run(), /identity or lifetime/);
  }
  const s = await setup(t, twoConflicts()); await s.run(); s.api.answer(id(1), 'ours'); await s.run();
  s.api.controls.loseNext = true; await s.run(); s.api.questions.get(id(2)).asker.id = OTHER;
  await assert.rejects(s.run({ command: 'recover', attachId: id(2) }), /different asking registrations/);
  const other = await setup(t); other.api.controls.loseNext = true; await other.run();
  const q = other.api.questions.get(id(1)); q.created_at = '2026-01-01T08:58:59.000Z'; q.expires_at = '2026-01-01T09:13:59.000Z';
  await assert.rejects(other.run({ command: 'recover', attachId: id(1) }), /predates/);
});

test('expiry accepts delayed processing but rejects premature and implausibly future resolution on replay', async (t) => {
  const s = await setup(t); await s.run(); s.clock.value = '2026-01-01T09:16:00.000Z';
  s.api.terminal(id(1), 'expired'); s.api.questions.get(id(1)).resolved_at = '2026-01-01T09:15:30.000Z';
  assert.equal((await s.run()).status, 'incomplete'); assert.equal((await localReport(s.directory, s.options.input)).proposal, null);
  const original = await s.saved();
  for (const timestamp of ['2026-01-01T09:14:59.999Z', '2026-01-01T09:17:00.001Z']) {
    const saved = structuredClone(original); saved.attempts[0].observation.resolvedAt = timestamp;
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run(), /resolution time/); assert.equal(s.api.calls.length, calls);
    const live = await setup(t); await live.run(); live.clock.value = s.clock.value; live.api.terminal(id(1), 'expired');
    live.api.questions.get(id(1)).resolved_at = timestamp; await assert.rejects(live.run(), /resolution time/);
  }
});

test('answer and resolution times must agree and answer/cancellation cannot occur after expiry', async (t) => {
  const s = await setup(t); await s.run(); s.api.answer(id(1), 'ours');
  s.api.questions.get(id(1)).answer.answered_at = '2026-01-01T09:00:01.000Z';
  assert.equal((await s.run()).observedStatus, 'invalid_answer');
  for (const terminal of ['answered', 'cancelled']) {
    const other = await setup(t); await other.run(); other.clock.value = '2026-01-01T09:16:00.000Z';
    if (terminal === 'answered') other.api.answer(id(1), 'ours'); else other.api.terminal(id(1), terminal);
    await assert.rejects(other.run(), /resolution time/);
  }
});

test('checked time follows response; future creation, wrong TTL and answer on pending fail', async (t) => {
  const s = await setup(t); await s.run(); const get = s.api.client.questions.get.bind(s.api.client.questions);
  s.api.client.questions.get = async (...args) => { s.clock.value = '2026-01-01T09:02:00.000Z'; s.api.answer(id(1), 'ours'); return get(...args); };
  await s.run(); assert.equal((await s.saved()).attempts[0].observation.checkedAt, s.clock.value);
  for (const mutate of [
    (q) => { q.created_at = '2027-01-01T09:00:00.000Z'; q.expires_at = '2027-01-01T09:15:00.000Z'; },
    (q) => { q.expires_at = '2026-01-01T10:00:00.000Z'; }, (q) => { q.answer = {}; },
  ]) { const other = await setup(t); await other.run(); mutate(other.api.questions.get(id(1))); await assert.rejects(other.run()); }
  assert.equal(iso('2026-01-01T09:00:00+00:00'), '2026-01-01T09:00:00.000Z'); assert.throws(() => iso('2026-02-30T09:00:00Z'));
});

test('changed snapshot, session, participant or credential cannot reuse saved decisions', async (t) => {
  const s = await setup(t); await s.run();
  await assert.rejects(s.run({ input: { ...s.options.input, mergeId: 'other' } }), /changed merge snapshots/);
  const changed = structuredClone(s.options.input); changed.base.theme = 'something';
  await assert.rejects(s.run({ input: changed }), /changed merge snapshots/);
  await assert.rejects(s.run({ config: { participant: { id: OTHER, label: 'Other' } } }), /another connection/);
  await assert.rejects(s.run({ token: 'other' }), /another connection/); assert.equal(sends(s.api), 1);
});

test('strict flat schema rejects unsafe keys, nested values, floats, controls, excessive fields and numeric IDs', () => {
  for (const mutate of [
    (p) => { p.mergeId = 1; }, (p) => { p.ours = []; }, (p) => { p.ours.theme = {}; }, (p) => { p.ours.theme = 1.5; },
    (p) => { p.ours.theme = Number.MAX_SAFE_INTEGER + 1; }, (p) => { p.ours.theme = 'x'.repeat(41); },
    (p) => { p.ours.theme = 'line\nbreak'; }, (p) => { p.ours.constructor = 1; }, (p) => { p.ours.prototype = null; },
    (p) => { p.ours = JSON.parse('{"__proto__":42}'); }, (p) => { p.ours = Object.create({ hidden: 1 }); },
    (p) => { p.ours = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`field_${i}`, i])); }, (p) => { p.script = 'anything'; },
  ]) { const input = structuredClone(example); mutate(input); assert.throws(() => validateInput(input)); }
});

test('room preflight refuses public/unsupported rooms and missing resolver before a POST', async (t) => {
  for (const mutate of [(rooms) => { rooms[0].is_public = true; }, (rooms) => { rooms[0].type = 'dm'; }, (rooms) => { rooms[0].members = [{ user_id: OTHER }]; }]) {
    const s = await setup(t); mutate(s.api.rooms); await assert.rejects(s.run()); assert.equal(sends(s.api), 0);
  }
});

test('reservation write failure sends nothing; answer save failure resumes the original question', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 2) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal(sends(s.api), 0); await s.run(); s.api.answer(id(1), 'ours');
  await assert.rejects(s.run({ write: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal((await s.saved()).attempts[0].status, 'pending'); assert.equal((await s.run()).status, 'complete'); assert.equal(sends(s.api), 1);
});

test('post-create save failure leaves uncertain intent for verified recovery without another POST', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 3) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal((await s.run()).status, 'create_unknown');
  assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'pending'); assert.equal(sends(s.api), 1);
});

test('failed reads preserve evidence and corrupted request/provenance fail before network', async (t) => {
  const s = await setup(t); await s.run(); const before = await readFile(join(s.directory, 'state.json'), 'utf8');
  s.api.controls.readError = true; await assert.rejects(s.run()); assert.equal(await readFile(join(s.directory, 'state.json'), 'utf8'), before);
  s.api.controls.readError = false; s.api.answer(id(1), 'ours'); await s.run(); const original = await s.saved();
  for (const mutate of [
    (saved) => { saved.attempts[0].request.ttl = 60; }, (saved) => { saved.attempts.push(saved.attempts[0]); },
    (saved) => { saved.attempts[0].field = 'font_size'; }, (saved) => { saved.attempts[0].observation.answer.responderId = OTHER; },
  ]) {
    const saved = structuredClone(original); mutate(saved); assert.throws(() => validateState(saved, s.options.input));
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run()); assert.equal(s.api.calls.length, calls);
  }
});

test('maximum twelve conflicts with escaped strings fit prompt, state and report bounds', async (t) => {
  const fields = Array.from({ length: 12 }, (_, i) => `f${i}${'x'.repeat(37)}`);
  const snapshot = (character) => Object.fromEntries(fields.map((field) => [field, character.repeat(40)]));
  const input = { mergeId: 'm'.repeat(40), title: 't'.repeat(60), base: snapshot('"'), ours: snapshot('\\'), theirs: snapshot('x') };
  const s = await setup(t, input);
  for (let i = 0; i < 12; i++) { await s.run(); assert.ok(s.api.questions.get(id(i + 1)).prompt.length <= 500); s.api.answer(id(i + 1), 'theirs'); await s.run(); }
  const saved = await s.saved(); validateState(saved, input);
  assert.ok(Buffer.byteLength(JSON.stringify(saved, null, 2)) + 4096 < 1024 * 1024);
  const result = await localReport(s.directory, input, { save: true }); assert.equal(result.status, 'complete');
  assert.deepEqual(result.proposal.record, input.theirs); assert.ok((await stat(join(s.directory, 'report.json'))).size < 1024 * 1024);
  await s.run(); assert.equal(sends(s.api), 12);
});

test('bounded file reads reject malformed, oversized, invalid UTF-8 and symlink data without revealing contents', async (t) => {
  const s = await setup(t), path = join(s.directory, 'bad.json');
  await writeFile(path, '{"secret":"PRIVATE_TOKEN",bad');
  await assert.rejects(readJson(path), (error) => !error.message.includes('PRIVATE_TOKEN') && error.message.includes('malformed'));
  await writeFile(path, Buffer.from([0xff])); await assert.rejects(readJson(path), /UTF-8/);
  await writeFile(path, 'x'.repeat(100)); await assert.rejects(readJson(path, 50), /size limit/);
  await symlink(path, join(s.directory, 'linked')); await assert.rejects(readJson(join(s.directory, 'linked')));
});

test('private lock excludes other commands; report is offline and private', async (t) => {
  const s = await setup(t); await s.run(); const release = await acquireLock(s.directory);
  await assert.rejects(s.run(), /lock exists/); await assert.rejects(localReport(s.directory, s.options.input), /lock exists/);
  await release(); const before = s.api.calls.length;
  assert.equal((await localReport(s.directory, s.options.input, { save: true })).proposal, null); assert.equal(s.api.calls.length, before);
  assert.equal((await stat(join(s.directory, 'report.json'))).mode & 0o777, 0o600);
});

test('partial or blank environment overrides never combine with saved credentials', async (t) => {
  const s = await setup(t); await atomicJson(s.directory, 'credentials.json', { token: 'saved', room: ROOM_CODE });
  await assert.rejects(loadConnection(s.directory, { PINGROOM_TOKEN: '' })); await assert.rejects(loadConnection(s.directory, { PINGROOM_ROOM: ROOM_CODE }));
  assert.equal((await loadConnection(s.directory, { PINGROOM_TOKEN: 'explicit', PINGROOM_ROOM: ROOM_CODE.toLowerCase() })).token, 'explicit');
});

test('transport rejects unrelated writes, redirects and oversized responses', async () => {
  let count = 0; const client = makeClient({ token: 'fixture', fetchImpl: async () => { count++; return new Response(null, { status: 302 }); } });
  await assert.rejects(client.questions.get(id(1))); assert.equal(count, 1); await assert.rejects(client.questions.cancel(id(1))); assert.equal(count, 1);
  const large = makeClient({ token: 'fixture', fetchImpl: async () => new Response('x'.repeat(512 * 1024 + 1)) }); await assert.rejects(large.questions.get(id(1)));
});

test('transport deadlines bound stalled fetch/body and allow abort through infinite ready empty chunks', async () => {
  const stalled = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: () => new Promise(() => {}) }); await assert.rejects(stalled.questions.get(id(1)));
  const body = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })) }); await assert.rejects(body.questions.get(id(1)));
  const controller = new AbortController();
  const empty = makeClient({ token: 'fixture', signal: controller.signal, fetchImpl: async () => new Response(new ReadableStream({ pull: (out) => out.enqueue(new Uint8Array()) })) });
  const timer = setTimeout(() => controller.abort(), 20); try { await assert.rejects(empty.questions.get(id(1))); } finally { clearTimeout(timer); }
});

test('abort before reservation sends nothing; after reservation it preserves unresolved intent', async (t) => {
  const s = await setup(t), stopped = new AbortController(); stopped.abort(); await assert.rejects(s.run({ signal: stopped.signal })); assert.equal(sends(s.api), 0);
  const controller = new AbortController(); let writes = 0;
  await assert.rejects(s.run({ signal: controller.signal, write: async (...args) => { await atomicJson(...args); if (++writes === 2) controller.abort(); } }));
  assert.equal(sends(s.api), 0); assert.equal((await s.run()).status, 'create_unknown');
});


test('partial external credentials cannot borrow the room from dotenv', async (t) => {
  const s = await setup(t), path = join(s.directory, '.env');
  await writeFile(path, 'PINGROOM_TOKEN=file-token\nPINGROOM_ROOM=DEMO12345678\n');
  const partial = { PINGROOM_TOKEN: 'shell-token' }; await loadEnvironment(partial, path);
  assert.equal(partial.PINGROOM_ROOM, undefined); await assert.rejects(loadConnection(s.directory, partial));
  const env = {}; await loadEnvironment(env, path); assert.deepEqual(await loadConnection(s.directory, env), { token: 'file-token', room: ROOM_CODE });
});
