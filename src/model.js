import { createHash } from 'node:crypto';

export const TTL = 900;
export const CLOCK_SKEW_MS = 60000;
export const ROOM = /^[A-Z0-9]{12}$/;
export const isId = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => record(value) && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
const word = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(value);
const line = (value, max) => typeof value === 'string' && value.length <= max && /^[\x20-\x7e]+$/.test(value) && value.trim() === value;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function iso(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(raw)) throw new Error('Expected a UTC timestamp.');
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== raw.slice(0, 19)) throw new Error('Invalid UTC timestamp.');
  return new Date(time).toISOString();
}

export function validateInput(input) {
  if (!keys(input, ['mergeId', 'title', 'base', 'ours', 'theirs']) || !word(input.mergeId) || !line(input.title, 60)) throw new Error('Provide a merge ID, title, and base/ours/theirs records.');
  const names = new Set();
  for (const side of ['base', 'ours', 'theirs']) {
    const value = input[side];
    if (!record(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Snapshots must be flat JSON records.');
    for (const [field, scalar] of Object.entries(value)) {
      if (!word(field) || ['constructor', 'prototype', '__proto__'].includes(field)) throw new Error('Invalid or reserved field name.');
      if (!(scalar === null || typeof scalar === 'boolean' || Number.isSafeInteger(scalar)
        || typeof scalar === 'string' && scalar.length <= 40 && /^[\x20-\x7e]*$/.test(scalar))) throw new Error('Values must be null, booleans, safe integers, or up to 40 printable ASCII characters.');
      names.add(field);
    }
  }
  if (names.size > 12) throw new Error('A merge supports at most 12 distinct fields across all snapshots.');
  return structuredClone(input);
}

export function validateConfig(config) {
  if (!keys(config, ['participant']) || !keys(config.participant, ['id', 'label']) || !isId(config.participant.id)
    || !line(config.participant.label, 60)) throw new Error('Config requires an exact resolver UUID and label.');
  return structuredClone(config);
}

const at = (snapshot, field) => Object.hasOwn(snapshot, field) ? { present: true, value: snapshot[field] } : { present: false };
const same = (a, b) => hash(a) === hash(b);

/** Absence is a deletion, distinct from a present JSON null or empty string. */
export function planMerge(rawInput) {
  const input = validateInput(rawInput);
  const fields = [...new Set(['base', 'ours', 'theirs'].flatMap((side) => Object.keys(input[side])))].sort(compare);
  return fields.map((field) => {
    const base = at(input.base, field), ours = at(input.ours, field), theirs = at(input.theirs, field);
    let selected = null, reason = 'divergent_edits';
    if (same(ours, theirs)) { selected = 'ours'; reason = same(base, ours) ? 'unchanged' : 'same_edit'; }
    else if (same(base, ours)) { selected = 'theirs'; reason = 'only_theirs_changed'; }
    else if (same(base, theirs)) { selected = 'ours'; reason = 'only_ours_changed'; }
    return { field, base, ours, theirs, kind: selected === null ? 'conflict' : 'automatic', selected, reason };
  });
}

export const conflictsFor = (input) => planMerge(input).filter((item) => item.kind === 'conflict');
const display = (value) => value.present ? JSON.stringify(value.value) : 'MISSING (no property)';

export function requestFor(input, config, field, attemptId) {
  const conflict = conflictsFor(input).find((item) => item.field === field);
  if (!conflict || !isId(attemptId)) throw new Error('Invalid conflict or attempt.');
  const key = `merge-${attemptId}`;
  const prompt = `${input.title}\nResolve field ${JSON.stringify(field)}.\nBase: ${display(conflict.base)}\nOurs: ${display(conflict.ours)}\nTheirs: ${display(conflict.theirs)}`;
  if (prompt.length > 500) throw new Error('Conflict prompt exceeds 500 characters.');
  return { prompt, context: `Merge ${hash({ input, field }).slice(0, 20)}`,
    options: [['ours', 'Use ours'], ['theirs', 'Use theirs'], ['base', 'Use base'], ['unresolved', 'Leave unresolved']]
      .map(([value, label]) => ({ value, label, style: 'default' })),
    responder_scope: 'direct', target_user_id: config.participant.id, ttl: TTL, correlation_id: key,
    data: { input_hash: hash(input), field, attempt_id: attemptId }, idempotencyKey: key };
}

export function validateState(state, input) {
  validateInput(input);
  const conflicts = conflictsFor(input);
  if (!keys(state, ['version', 'inputHash', 'config', 'room', 'credentialHash', 'startedAt', 'attempts']) || state.version !== 1
    || state.inputHash !== hash(input) || typeof state.room !== 'string' || !ROOM.test(state.room)
    || typeof state.credentialHash !== 'string' || !/^[0-9a-f]{64}$/.test(state.credentialHash)
    || !Array.isArray(state.attempts) || state.attempts.length > conflicts.length || iso(state.startedAt) !== state.startedAt) throw new Error('Invalid state or changed merge snapshots. Restore the original input and configuration.');
  validateConfig(state.config);
  const ids = new Set(), questionIds = new Set(); let previous = state.startedAt, askerId;
  for (const [index, attempt] of state.attempts.entries()) {
    if (!keys(attempt, ['id', 'field', 'createdAt', 'request', 'questionId', 'status', 'observation']) || !isId(attempt.id) || ids.has(attempt.id)
      || attempt.field !== conflicts[index].field || iso(attempt.createdAt) !== attempt.createdAt || attempt.createdAt < previous
      || hash(attempt.request) !== hash(requestFor(input, state.config, attempt.field, attempt.id))
      || !['creating', 'pending', 'answered', 'expired', 'cancelled', 'invalid_answer'].includes(attempt.status)) throw new Error('Invalid saved conflict.');
    ids.add(attempt.id); previous = attempt.createdAt;
    if (attempt.status === 'creating') {
      if (attempt.questionId !== null || attempt.observation !== null) throw new Error('Invalid uncertain creation state.');
    } else {
      if (!isId(attempt.questionId) || questionIds.has(attempt.questionId)) throw new Error('Invalid or repeated Question ID.');
      questionIds.add(attempt.questionId); validateObservation(attempt.observation, attempt.status, attempt.request);
      if (Date.parse(attempt.observation.createdAt) < Date.parse(attempt.createdAt) - CLOCK_SKEW_MS) throw new Error('Question predates its saved creation intent.');
      if (askerId !== undefined && attempt.observation.askerId !== askerId) throw new Error('Questions belong to different asking registrations.');
      askerId = attempt.observation.askerId;
    }
    if (['creating', 'pending'].includes(attempt.status) && index !== state.attempts.length - 1) throw new Error('Only the last conflict may be active.');
  }
  return state;
}

export function report(state, input) {
  validateState(state, input);
  const fields = planMerge(input).map((item) => {
    if (item.kind === 'automatic') return { ...item, status: 'automatic', result: item[item.selected], provenance: null };
    const attempt = state.attempts.find((entry) => entry.field === item.field);
    const answer = attempt?.observation?.answer;
    const selected = ['ours', 'theirs', 'base'].includes(answer?.value) ? answer.value : null;
    return { ...item, selected, status: attempt?.status === 'creating' ? 'create_unknown' : attempt?.status ?? 'unasked',
      result: selected === null ? null : item[selected],
      provenance: attempt ? { attemptId: attempt.id, questionId: attempt.questionId, choice: answer?.value ?? null,
        resolverId: answer?.responderId ?? null, answeredAt: answer?.answeredAt ?? null,
        askerId: attempt.observation?.askerId ?? null, observedAt: attempt.observation?.checkedAt ?? null } : null };
  });
  const unresolvedFields = fields.filter((field) => field.selected === null).map((field) => ({ field: field.field, status: field.status, choice: field.provenance?.choice ?? null }));
  const active = fields.find((field) => ['create_unknown', 'pending'].includes(field.status));
  const status = active?.status ?? (fields.some((field) => field.status === 'unasked') ? 'ready' : unresolvedFields.length ? 'incomplete' : 'complete');
  const merged = unresolvedFields.length ? null : Object.fromEntries(fields.filter((field) => field.result.present).map((field) => [field.field, field.result.value]));
  return { mergeId: input.mergeId, title: input.title, status, inputHash: hash(input),
    snapshotHashes: Object.fromEntries(['base', 'ours', 'theirs'].map((side) => [side, hash(input[side])])),
    resolver: state.config.participant, fields, unresolvedFields, proposal: merged === null ? null : { record: merged, hash: hash(merged) } };
}


function validateObservation(observation, status, request) {
  if (!keys(observation, ['createdAt', 'expiresAt', 'checkedAt', 'askerId', 'resolvedAt', 'answer']) || !isId(observation.askerId)) throw new Error('Invalid saved observation.');
  for (const key of ['createdAt', 'expiresAt', 'checkedAt']) if (iso(observation[key]) !== observation[key]) throw new Error('Invalid saved timestamp.');
  const duration = Date.parse(observation.expiresAt) - Date.parse(observation.createdAt);
  if (duration < TTL * 1000 - 1000 || duration > TTL * 1000 + 1000) throw new Error('Question lifetime differs from the saved request.');
  const latest = Date.parse(observation.checkedAt) + CLOCK_SKEW_MS;
  if (Date.parse(observation.createdAt) > latest) throw new Error('Question creation is implausibly in the future. Check the local clock.');
  if (status === 'pending') {
    if (observation.resolvedAt !== null) throw new Error('Pending Question has a resolution timestamp.');
  } else if (iso(observation.resolvedAt) !== observation.resolvedAt || observation.resolvedAt < observation.createdAt
    || Date.parse(observation.resolvedAt) > latest
    || (status === 'expired' ? observation.resolvedAt < observation.expiresAt : observation.resolvedAt > observation.expiresAt)) throw new Error('Invalid Question resolution time.');
  if (status === 'answered') {
    const answer = observation.answer;
    if (!keys(answer, ['value', 'label', 'responderId', 'answeredAt']) || answer.responderId !== request.target_user_id
      || !request.options.some((option) => option.value === answer.value && option.label === answer.label)
      || iso(answer.answeredAt) !== answer.answeredAt || answer.answeredAt !== observation.resolvedAt
      || answer.answeredAt < observation.createdAt || answer.answeredAt > observation.expiresAt) throw new Error('Invalid saved merge evidence.');
  } else if (observation.answer !== null) throw new Error('Unanswered conflicts must not contain merge evidence.');
}

export function observeQuestion(q, request, questionId, room, checkedAt) {
  if (!isId(questionId) || q?.id !== questionId || q.kind !== 'question' || q.is_handoff !== false
    || q.asker?.type !== 'agent' || !isId(q.asker?.id) || q.prompt !== request.prompt || q.context !== request.context
    || q.responder_scope !== 'direct' || q.target_user_id !== request.target_user_id || q.resolution_policy !== 'first'
    || q.results !== null || q.text_input !== null || q.correlation_id !== request.correlation_id || q.reply_to !== null || hash(q.data) !== hash(request.data)
    || (q.room_code ?? q.room?.code) !== room || q.room_code !== undefined && q.room_code !== room
    || q.room !== undefined && q.room?.code !== room || !['pending', 'answered', 'expired', 'cancelled'].includes(q.state)
    || !Array.isArray(q.options) || q.options.length !== request.options.length
    || q.options.some((option, index) => option?.value !== request.options[index].value || option?.label !== request.options[index].label
      || option?.primary !== false || option?.destructive !== false)) throw new Error('Question does not match the saved conflict, room, or participant.');
  const observation = { createdAt: iso(q.created_at), expiresAt: iso(q.expires_at), checkedAt: iso(checkedAt), askerId: q.asker.id,
    resolvedAt: q.resolved_at === null ? null : iso(q.resolved_at), answer: null };
  let status = q.state === 'answered' ? 'invalid_answer' : q.state;
  if (q.state !== 'answered' && q.answer !== null) throw new Error('Unresolved Question includes an unexpected answer.');
  if (q.state === 'answered') {
    const answer = q.answer;
    try {
      if (!answer || answer.text !== null || answer.responder?.id !== request.target_user_id
        || !request.options.some((option) => option.value === answer.value && option.label === answer.label)) throw new Error('Invalid answer.');
      observation.answer = { value: answer.value, label: answer.label, responderId: answer.responder.id, answeredAt: iso(answer.answered_at) };
      validateObservation(observation, 'answered', request); status = 'answered';
    } catch { observation.answer = null; }
  }
  validateObservation(observation, status, request);
  return { status, observation };
}


export function assertParticipantRoom(rooms, room, participantId) {
  if (!Array.isArray(rooms) || rooms.length > 1000) throw new Error('Invalid room inventory.');
  const matches = rooms.filter((item) => item?.invite_code === room), selected = matches[0];
  if (matches.length !== 1 || selected.type !== 'standard' || selected.is_public !== false || !Array.isArray(selected.members)
    || selected.members.length > 1000 || !selected.members.some((member) => member?.user_id === participantId)) throw new Error('Use a granted standard private room containing the named participant.');
}
