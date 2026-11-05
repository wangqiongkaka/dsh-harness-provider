import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as board from '../dist/agent-board.js';

const row = (updatedAt, completedAt) => ({ displayTitle: '会话', blank: false, running: false, updatedAt,
  projectionValues: { harnessTaskCompletedAt: completedAt } });
const idle = { running: false, pendingInteraction: undefined, completionUnread: false };

test('completed sessions share one order by the latest task end, independently of unread state and metadata updates', () => {
  const list = { ids: ['unread', 'read', 'never'], byId: { unread: row(900, 10), read: row(1, 20), never: row(999, null) } };
  const statuses = new Map([['unread', { ...idle, completionUnread: true }], ['read', idle]]);
  assert.deepEqual(board.completedRows(list, statuses).map(row => [row.id, row.updatedAt]), [['read', 20], ['unread', 10]]);
  statuses.set('unread', idle);
  list.byId.read.updatedAt = 1000;
  assert.deepEqual(board.completedRows(list, statuses).map(row => row.id), ['read', 'unread']);
  list.byId.unread.projectionValues.harnessTaskCompletedAt = 30;
  assert.deepEqual(board.completedRows(list, statuses).map(row => row.id), ['unread', 'read']);
});

test('completion order excludes active, pending, blank, child and unknown-timestamp sessions', () => {
  const ids = ['running', 'pending', 'blank', 'child', 'unknown'];
  const byId = Object.fromEntries(ids.map(id => [id, row(99, 10)]));
  byId.blank.blank = true; byId.child.origin = 'subagent'; delete byId.unknown.projectionValues;
  const statuses = new Map([['running', { ...idle, running: true }], ['pending', { ...idle, pendingInteraction: { kind: 'question' } }]]);
  assert.deepEqual(board.completedRows({ ids, byId }, statuses), []);
});

test('the completion projection replays real task-end times and ignores metadata and fork-inherited turns', async () => {
  const { completionProjection: projection } = await import('../dist/completion-projection.js');
  let state = projection.init({}, 3);
  state = projection.apply(state, { type: 'turn/end', seq: 2, time: 999 });
  assert.equal(projection.wire.view(state), null);
  state = projection.apply(state, { type: 'turn/end', seq: 3, time: 10 });
  const completed = state;
  for (const type of ['session/title', 'user/message', 'turn/start']) state = projection.apply(state, { type, seq: 4, time: 1000 });
  assert.equal(state, completed);
  assert.equal(projection.wire.view(state), 10);
  state = projection.apply(state, { type: 'turn/end', seq: 5, time: 20 });
  assert.equal(projection.wire.view(state), 20);
});
