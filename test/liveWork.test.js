'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// What the Task Bar leads with: everything an agent on this machine is doing.
//
// The panel would be a liar if it listed only its own tasks — an agent is asked
// from four places, and three of them are elsewhere in the window. So the
// selector reads all four, and what is pinned here is that each of them is
// found, that none of them is found twice, and that a person typing is never
// mistaken for work.
//
// Loaded with the `export` keywords stripped, the way sidebarSections.test.js
// loads its module.

const SRC = path.join(__dirname, '..', 'src', 'renderer');
const { liveWork } = new Function(
  `${fs.readFileSync(path.join(SRC, 'lib', 'liveWork.js'), 'utf8').replace(/^export\s+/gm, '')}
   return { liveWork };`
)();

const TESSIE = { id: 'agent:tessie', name: 'Tessie' };
const BRACKET = { id: 'agent:bracket', name: 'Bracket' };
const ADA = { id: 'peer:ada', name: 'Ada' };

test('nothing running is an empty list, not an empty-looking one', () => {
  assert.deepEqual(liveWork(), []);
  assert.deepEqual(liveWork({ tasks: [{ id: 'task:a', status: 'idle' }] }), []);
  assert.deepEqual(liveWork({ typing: { 'peer:ada': false } }), []);
});

test('a running task is listed, with who it is waiting on', () => {
  const work = liveWork({
    tasks: [
      { id: 'task:a', title: 'Nightly build', agentId: TESSIE.id, status: 'working', lastRunAt: 5 },
      { id: 'task:b', title: 'Done one', agentId: TESSIE.id, status: 'done', lastRunAt: 1 },
    ],
    agents: [TESSIE],
  });
  assert.deepEqual(work, [
    { kind: 'task', id: 'task:a', title: 'Nightly build', who: 'Tessie', startedAt: 5 },
  ]);
});

test('a session names the agents it is still waiting on, not the ones that answered', () => {
  const work = liveWork({
    sessions: [
      { id: 'session:1', title: 'Quakes' },
      { id: 'session:2', title: 'Tides' },
    ],
    rounds: {
      'session:1': {
        open: true,
        // Three asked, one answered: the two still out are the two named.
        asked: [
          { agentId: TESSIE.id, name: 'Tessie' },
          { agentId: BRACKET.id, name: 'Bracket' },
          { agentId: 'agent:gone', name: 'Cass' },
        ],
        running: [TESSIE.id, BRACKET.id],
      },
      // Open with nobody running is a relay between agents, and a closed round
      // is not work at all.
      'session:2': { open: true, asked: [], running: [] },
    },
    agents: [TESSIE, BRACKET],
  });
  assert.equal(work.length, 1);
  assert.equal(work[0].kind, 'session');
  assert.equal(work[0].title, 'Quakes');
  assert.equal(work[0].who, 'Tessie, Bracket');
});

test('an agent answering in its own conversation counts, and a person typing does not', () => {
  const work = liveWork({
    typing: {
      [TESSIE.id]: true,
      [ADA.id]: true, // a human at a keyboard
      'peer:someone-else': false,
    },
    peers: [ADA, { ...TESSIE, kind: 'agent' }],
    agents: [TESSIE],
  });
  assert.deepEqual(work, [{ kind: 'agent', id: TESSIE.id, title: 'Tessie', who: 'Tessie', startedAt: 0 }]);
});

test("a peer's question to one of our agents is work, and says whose", () => {
  const work = liveWork({
    typing: { [`${TESSIE.id}#${ADA.id}`]: true },
    peers: [ADA, { ...TESSIE, kind: 'agent' }],
    agents: [TESSIE],
  });
  assert.deepEqual(work, [
    {
      kind: 'peer',
      id: `${TESSIE.id}#${ADA.id}`,
      title: 'Tessie',
      who: 'asked by Ada',
      startedAt: 0,
    },
  ]);

  // A peer we cannot name is still a peer. What matters is that the row says
  // this was not started by you.
  const unnamed = liveWork({
    typing: { [`${TESSIE.id}#peer:stranger`]: true },
    agents: [TESSIE],
  });
  assert.equal(unnamed[0].who, 'asked by a peer');

  // A delegate thread for an agent we do not have is not ours to list.
  assert.deepEqual(liveWork({ typing: { 'agent:someone-elses#peer:ada': true }, agents: [] }), []);
});

test('the same run is listed once, under the name that says most about it', () => {
  // Both of these are also threads that are typing: deliver() brackets every
  // run, whatever asked for it. Listing them twice would double the count and
  // show the same work under two names.
  const work = liveWork({
    tasks: [{ id: 'task:a', title: 'Nightly build', agentId: TESSIE.id, status: 'working', lastRunAt: 5 }],
    sessions: [{ id: 'session:1', title: 'Quakes' }],
    rounds: {
      'session:1': { open: true, asked: [{ agentId: TESSIE.id, name: 'Tessie' }], running: [TESSIE.id] },
    },
    typing: { 'task:a': true, 'session:1': true, [TESSIE.id]: true },
    agents: [TESSIE],
    peers: [{ ...TESSIE, kind: 'agent' }],
  });

  assert.equal(work.length, 3, 'three runs, not five');
  assert.deepEqual(
    work.map((w) => w.id),
    ['task:a', 'session:1', TESSIE.id]
  );
  // And the task and the session kept their own titles rather than being
  // relabelled with the agent's name by the typing pass.
  assert.equal(work[0].title, 'Nightly build');
  assert.equal(work[1].title, 'Quakes');
});

test('the order is your work first, and somebody else’s last', () => {
  const work = liveWork({
    typing: { [`${TESSIE.id}#${ADA.id}`]: true, [BRACKET.id]: true },
    tasks: [{ id: 'task:a', title: 'T', agentId: TESSIE.id, status: 'working', lastRunAt: 9 }],
    sessions: [{ id: 'session:1', title: 'S' }],
    rounds: { 'session:1': { open: true, asked: [], running: [TESSIE.id] } },
    agents: [TESSIE, BRACKET],
    peers: [ADA],
  });
  assert.deepEqual(
    work.map((w) => w.kind),
    ['task', 'session', 'agent', 'peer']
  );
});

test('the one that has been going longest is the one at the top of its kind', () => {
  const work = liveWork({
    tasks: [
      { id: 'task:new', title: 'Newer', agentId: TESSIE.id, status: 'working', lastRunAt: 900 },
      { id: 'task:old', title: 'Older', agentId: TESSIE.id, status: 'working', lastRunAt: 100 },
    ],
    agents: [TESSIE],
  });
  assert.deepEqual(
    work.map((w) => w.title),
    ['Older', 'Newer']
  );
});

test('an agent that has gone is still named as something, rather than as nothing', () => {
  // A task can outlive the agent it named — removing one unbinds the task, but
  // a run that was in flight still has to be described.
  const work = liveWork({
    tasks: [{ id: 'task:a', title: 'Orphan', agentId: 'agent:vanished', status: 'working', lastRunAt: 1 }],
    agents: [],
  });
  assert.equal(work[0].who, 'an agent');
});
