'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// A session asking several agents at once.
//
// The behaviour — who gets asked, one question and three answers, what happens
// when one of them cannot be reached — is proved against real machinery in
// test/sessions.test.js. What is here is the two pure layers either side of it:
// main's decision about who is in the counsel and what to say about who is not,
// and the window's single source for how a counsel is named in the four places
// that have to name it. Both are plain functions, so both can be read rather
// than inferred from a screenshot.

const SRC = path.join(__dirname, '..', 'src', 'renderer');
const {
  resolveCounsel,
  missedNotice,
  unreachableNotice,
  relayPrompt,
} = require('../src/main/sessions/counsel.js');
const { composeContext } = require('../src/main/sessions/prompt.js');

// ------------------------------------------------------------------ who is asked

const roster = [
  { id: 'agent:1', name: 'Tessie', ready: true, reason: null },
  { id: 'agent:2', name: 'Hermes', ready: false, reason: 'off' },
  { id: 'remote-agent:p1:agent:9', name: 'Fable', ready: true, reason: null, remote: true },
];

test('a session with a list asks that list, in the order it is written', () => {
  const { targets, missed } = resolveCounsel(
    { agentIds: ['remote-agent:p1:agent:9', 'agent:1'], allAgents: false },
    { askable: roster }
  );
  assert.deepEqual(
    targets.map((t) => t.name),
    ['Fable', 'Tessie'],
    'the order is the order they were chosen in — in relay mode it is who speaks first'
  );
  assert.deepEqual(missed, []);
  assert.equal(targets[0].remote, true, 'and whether each is ours or somebody else travels with it');
});

test('a session set to ask everybody asks whoever is on the roster at the time', () => {
  const { targets, missed } = resolveCounsel({ agentIds: [], allAgents: true }, { askable: roster });
  assert.deepEqual(
    targets.map((t) => t.name),
    ['Tessie', 'Fable'],
    'everybody who can take a question'
  );
  assert.deepEqual(missed, [{ agentId: 'agent:2', name: 'Hermes', reason: 'off' }], 'and the one who cannot');

  // The whole point of the standing choice: nothing was written down, so an
  // agent that appears later is in the counsel without anybody re-choosing.
  const later = resolveCounsel(
    { agentIds: [], allAgents: true },
    { askable: [...roster, { id: 'agent:4', name: 'Ada', ready: true }] }
  );
  assert.equal(later.targets.length, 3, 'an agent added later joins on its own');
});

test('an agent that is not on the roster at all has gone, and is said to have gone', () => {
  const { targets, missed } = resolveCounsel(
    { agentIds: ['agent:1', 'agent:removed'], allAgents: false },
    { askable: roster }
  );
  assert.deepEqual(
    targets.map((t) => t.name),
    ['Tessie']
  );
  assert.deepEqual(missed, [{ agentId: 'agent:removed', name: null, reason: 'gone' }]);
});

// ------------------------------------------------------------------ what is said

test('the ones who were not asked are named, and so is the reason', () => {
  assert.equal(missedNotice([]), null, 'nothing to say when everybody was asked');
  assert.equal(missedNotice([{ name: 'Hermes', reason: 'off' }]), 'Hermes was not asked — switched off.');
  assert.equal(
    missedNotice([
      { name: 'Hermes', reason: 'off' },
      { name: 'Fable', reason: 'held' },
      { name: 'Ada', reason: 'busy' },
    ]),
    '3 agents were not asked: Hermes is switched off, Fable is still reading an earlier question and Ada is already working on something else.'
  );
});

test('a counsel nobody can answer explains itself rather than saying nothing', () => {
  assert.match(
    unreachableNotice({ allAgents: false }, [{ name: 'Hermes', reason: 'off' }]),
    /^Nobody in this session's counsel can be asked right now: Hermes is switched off\.$/
  );
  assert.match(
    unreachableNotice({ allAgents: true }, []),
    /^There are no agents to ask yet\./,
    'a standing choice with nobody standing is a different sentence from an empty list'
  );
  assert.match(unreachableNotice({ allAgents: false }, []), /^Choose an agent for this session/);
});

// ------------------------------------------------------------------ asked in turn

test('an agent asked after the others is shown what they said, and the question last', () => {
  const answers = [
    { name: 'Tessie', text: 'Counsel mode.' },
    { name: 'Hermes', text: 'A round table.' },
  ];
  const prompt = relayPrompt('what should we call it?', answers);
  assert.match(
    prompt,
    /^\[Answers already given to this question by other agents\]\n<<<\nTessie:\nCounsel mode\.\n\nHermes:\nA round table\.\n>>>\n\nwhat should we call it\?$/
  );
  assert.equal(relayPrompt('why?', []), 'why?', 'the first one asked is asked the question as typed');

  // The same fence a fork's quoted excerpt uses. An agent reading a LanChat
  // prompt should meet one convention, not two.
  const forked = composeContext({ text: 'the turn moved', speaker: 'Hermes', ts: null }, 'why?');
  assert.ok(forked.includes('<<<') && forked.includes('>>>'));
  assert.ok(prompt.includes('<<<') && prompt.includes('>>>'));
});

test('an answer too long to carry is truncated rather than dropped', () => {
  const prompt = relayPrompt('and?', [{ name: 'Tessie', text: 'x'.repeat(9000) }]);
  assert.ok(prompt.includes('[Truncated]'));
  assert.ok(prompt.length < 9000 + 500);
  assert.ok(prompt.endsWith('\n\nand?'), 'and the question is still the last thing it reads');
});

// ------------------------------------------------------ how a counsel is named
//
// ESM for the renderer, evaluated rather than imported — the same trick
// test/sessions.test.js uses for the commit arithmetic.
const copy = new Function(
  `${fs.readFileSync(path.join(SRC, 'lib', 'counselCopy.js'), 'utf8').replace(/^export\s+/gm, '')}
   return { counselNames, chipLabel, sessionSubLine, askPlaceholder, thinkingLine, roundSummary,
            sessionCounsel };`
)();

test('a list of agents is read out the way a person would say it', () => {
  assert.equal(copy.counselNames([]), '');
  assert.equal(copy.counselNames(['Tessie']), 'Tessie');
  assert.equal(copy.counselNames(['Tessie', 'Hermes']), 'Tessie and Hermes');
  assert.equal(copy.counselNames(['Tessie', 'Hermes', 'Fable']), 'Tessie, Hermes and Fable');
  assert.equal(
    copy.counselNames(['Tessie', 'Hermes', 'Fable', 'Ada', 'Bo']),
    'Tessie, Hermes, Fable and 2 others',
    'past three the number is the useful part, not the wall of names'
  );
});

test('the header, the sidebar and the composer say the same thing about the same counsel', () => {
  const none = { allAgents: false, names: [] };
  assert.equal(copy.chipLabel(none), 'choose agents…');
  assert.equal(copy.sessionSubLine(none), 'Session · no agent yet');
  assert.equal(copy.askPlaceholder(none), 'Choose agents above to ask something');

  const one = { allAgents: false, names: ['Tessie'] };
  assert.equal(copy.chipLabel(one), 'Tessie');
  assert.equal(copy.sessionSubLine(one), 'Session · Tessie');
  assert.match(copy.askPlaceholder(one), /^Ask Tessie…/);

  const two = { allAgents: false, names: ['Tessie', 'Hermes'] };
  assert.equal(copy.chipLabel(two), '2 agents');
  assert.equal(copy.sessionSubLine(two), 'Session · Tessie and Hermes');
  assert.match(copy.askPlaceholder(two), /^Ask Tessie and Hermes…/, 'two are named rather than counted');
  assert.match(
    copy.askPlaceholder({ ...two, mode: 'relay' }),
    /^Ask Tessie, then Hermes…/,
    'and in turn, the order is the sentence'
  );

  const many = { allAgents: false, names: ['Tessie', 'Hermes', 'Fable', 'Ada'] };
  assert.equal(copy.chipLabel(many), '4 agents');
  assert.equal(copy.sessionSubLine(many), 'Session · 4 agents');
  assert.match(copy.askPlaceholder(many), /^Ask all 4 agents…/);

  const all = { allAgents: true, names: ['Tessie', 'Hermes'] };
  assert.equal(copy.chipLabel(all), 'All agents', 'a standing choice is not today’s list of names');
  assert.equal(copy.sessionSubLine({ ...all, available: 2 }), 'Session · all agents (2)');
  assert.equal(
    copy.sessionSubLine({ allAgents: true, names: [], available: 0 }),
    'Session · all agents (none here yet)'
  );
  assert.match(copy.askPlaceholder(all), /^Ask all agents…/);
});

test('the thinking line names who is thinking, and who is still to be asked', () => {
  const asked = [
    { agentId: 'a1', name: 'Tessie' },
    { agentId: 'a2', name: 'Hermes' },
    { agentId: 'a3', name: 'Fable' },
  ];
  assert.equal(copy.thinkingLine(null, 'pondering', 'Tessie'), 'Tessie is pondering');
  assert.equal(
    copy.thinkingLine({ open: true, asked, running: ['a1'], next: [] }, 'pondering'),
    'Tessie is pondering'
  );
  assert.equal(
    copy.thinkingLine({ open: true, asked, running: ['a1', 'a2'], next: [] }, 'pondering'),
    'Tessie and Hermes are pondering',
    'the verb stays singular for any number of them — one verb, several names'
  );
  assert.equal(
    copy.thinkingLine({ open: true, asked, running: ['a1'], next: [asked[1], asked[2]] }, 'pondering'),
    'Tessie is pondering · Hermes and Fable to follow',
    'asked in turn, a counsel that is not stalled has to look like one that is not stalled'
  );
});

test('a finished round says what came of it', () => {
  assert.equal(copy.roundSummary({ open: true }), '', 'nothing to summarise while it is still going');
  assert.equal(
    copy.roundSummary({ open: false, answered: ['a1', 'a2'], empty: ['a3'], failed: [] }),
    '2 answered · 1 had nothing to say'
  );
  assert.equal(copy.roundSummary({ open: false, answered: [], empty: [], failed: ['a1'] }), '1 failed');
});

test('the composer says what typing will do while a discussion is running', () => {
  // A box that looks like it starts something new, and instead joins a
  // conversation already in progress, is the kind of thing somebody only finds
  // out by losing a sentence to it.
  const counsel = { names: ['Hermes', 'Tessie'], mode: 'dialogue' };
  assert.match(copy.askPlaceholder(counsel), /Give Hermes and Tessie something to discuss/);
  assert.match(copy.askPlaceholder({ ...counsel, discussing: true }), /Say something into the discussion/);
  assert.match(
    copy.askPlaceholder({ ...counsel, discussing: true, held: true }),
    /picks up from there/,
    'and that saying it is what starts a held one again'
  );
});

// ------------------------------------------------------------------ the picker

test('mounted in a browser: ticking a counsel together, and nothing lost on the way', async () => {
  const { runCounselHarness } = require('../scripts/counsel-harness.js');
  const result = await runCounselHarness();
  if (result.skipped) {
    // Chromium is not always present. Say so rather than reporting a pass that
    // never happened.
    console.log(`# skipped browser checks: ${result.skipped}`);
    return;
  }

  const s = result.steps;
  const named = (step, name) => step.rows.find((r) => r.name === name);

  // ---- shut, over a conversation two agents have already answered ----------
  assert.equal(s.typing.open, false, 'the menu is not in the way until it is asked for');
  assert.equal(s.typing.chip, 'Tessie');
  assert.deepEqual(
    s.typing.speakers,
    ['Tessie', 'Hermes'],
    'two agents answering in one conversation each say which of them it was'
  );
  assert.deepEqual(
    s.typing.grouped,
    [false, false, false],
    'and their answers are never merged into one block, however close together they land'
  );

  // ---- open ---------------------------------------------------------------
  assert.equal(s.opened.open, true);
  assert.equal(s.opened.role, 'menu', 'a multi-select is a menu of checkboxes, not a listbox of options');
  assert.equal(s.opened.chipExpanded, 'true');
  // Present is not the same as visible. The chip lives in the header's subtitle,
  // which clips to one line so that a peer's platform or a queue position cannot
  // push the header out of shape — and a menu opening downwards out of that line
  // is precisely what such a rule clips. It was in the DOM, correct in every
  // respect, and painted nowhere.
  const box = s.opened.menuBox;
  assert.ok(box.h > 0 && box.w > 0, 'the menu should have a size');
  assert.equal(
    box.clip.shownPx,
    box.clip.ofPx,
    `the menu is clipped by .${box.clip.by} — ${box.clip.shownPx}px of ${box.clip.ofPx}px is showing`
  );
  for (const row of s.opened.rows) {
    assert.equal(
      row.role,
      'menuitemcheckbox',
      `${row.name} should announce itself as something that can be ticked`
    );
  }
  assert.deepEqual(
    s.opened.modes.map((m) => `${m.name}=${m.checked}`),
    ['All at once=true', 'In turn=false', 'Between themselves=false'],
    'the three modes are one choice, so they are radios'
  );
  // ---- the turn budget ----------------------------------------------------
  //
  // The one control here that guards against spending money. It appears with the
  // mode that spends it, it is a spinbutton rather than a text box, and both ends
  // of its range stop rather than letting somebody type past them.
  assert.equal(s.opened.turns, null, 'no budget until the mode that has one is chosen');
  assert.equal(s.relay.turns, null, 'and not for a relay either — one lap has no turns to cap');
  assert.ok(s.dialogue.turns, 'choosing a discussion brings out the budget it will run to');
  assert.equal(s.dialogue.turns.count, '6');
  // The only children a menu announces are menuitems, groups and separators, so
  // the control that visually reads as a number box is built out of the two
  // things it really is. A spinbutton here would be correct semantics in a
  // container that will not announce it, which is a control nobody can find.
  assert.equal(s.dialogue.turns.role, 'group', 'a group is something a menu will announce');
  assert.deepEqual(s.dialogue.turns.stepRoles, ['menuitem', 'menuitem'], 'and its buttons are menuitems');
  assert.equal(
    s.dialogue.turns.label,
    'Turns: 6, between 2 and 12',
    'the value and the range are on it, not just enforced behind it'
  );
  assert.equal(s.dialogue.turns.live, 'polite', 'and pressing a step says what it became');
  // Six presses to take 6 down to 2, and two of those presses have nothing left
  // to do. It stops at the floor rather than going under it.
  assert.equal(s.turnsFloor.turns.count, '2', 'pressing past the bottom does not go under it');
  assert.equal(s.turnsFloor.turns.downOff, true, 'and the button says so rather than silently failing');
  assert.equal(s.turnsFloor.turns.upOff, false);
  assert.equal(s.turnsKeyed.turns.count, '3', 'the arrow keys work it too, not only the mouse');

  assert.equal(named(s.opened, 'Fable').note, 'switched off — will be skipped');
  assert.equal(named(s.opened, 'Fable').disabled, false, 'an agent that is off can still be chosen');
  // An agent somebody else is hosting is on the list and says whose it is. The
  // list comes from main rather than from the roster precisely so this one
  // appears at all: an agent shared without direct chat can be asked and is
  // deliberately not a contact, so a picker built by filtering the roster would
  // leave it out of a counsel that main would then go ahead and ask.
  assert.equal(named(s.opened, 'Hermes').note, 'shared by Server');

  // ---- ticking stays open -------------------------------------------------
  assert.equal(s.twoTicked.open, true, 'a menu that shut on every tick would be three trips to choose three');
  assert.equal(s.twoTicked.chip, '2 agents');
  assert.equal(named(s.twoTicked, 'Hermes').checked, 'true');
  assert.equal(s.offTicked.chip, '3 agents', 'including the one that is switched off');

  // ---- all agents, and narrowing it back to a list ------------------------
  assert.equal(s.allAgents.chip, 'All agents');
  for (const row of s.allAgents.rows) {
    assert.equal(row.checked, 'true', `${row.name} should read as chosen while the session asks everybody`);
  }
  assert.equal(s.narrowed.chip, '2 agents');
  assert.equal(
    named(s.narrowed, 'All agents').checked,
    'false',
    'narrowing a standing choice stops it standing'
  );
  assert.equal(named(s.narrowed, 'Tessie').checked, 'false');
  assert.deepEqual(
    result.patches[3],
    { allAgents: false, agentIds: ['remote-agent:p1:agent:9', 'agent:3'] },
    'and what is written down is everybody who was there, less the one just un-ticked'
  );

  // ---- the mode, and the composer that has to agree with it ---------------
  assert.match(s.relay.placeholder, /^Ask Hermes, then Fable…/);
  assert.deepEqual(result.patches[4], { mode: 'relay' });

  // ---- putting it away ----------------------------------------------------
  assert.equal(s.escaped.open, false, 'Escape shuts it');
  assert.equal(s.clickedAway.open, false, 'and so does clicking anywhere else');

  // ---- and the thing a popup over a composer must never do ----------------
  for (const [name, step] of Object.entries(s)) {
    assert.equal(step.draft, 'half a question', `the half-written question survived ${name}`);
  }
});

test('who a session asks is resolved in one place, from the roster', () => {
  const roster = [
    { id: 'a1', name: 'Tessie' },
    { id: 'a2', name: 'Hermes' },
  ];

  // The record keeps ids; the roster is what has names.
  assert.deepEqual(
    copy.sessionCounsel({ agentIds: ['a2', 'a1'] }, roster).map((a) => a.name),
    ['Hermes', 'Tessie']
  );

  // An id whose agent has gone resolves to nothing, which is the same state as
  // never having chosen one — either way there is nobody there to ask.
  assert.deepEqual(
    copy.sessionCounsel({ agentIds: ['a1', 'gone'] }, roster).map((a) => a.name),
    ['Tessie']
  );
  assert.deepEqual(copy.sessionCounsel({ agentIds: [] }, roster), []);

  // A session set to ask whoever is available asks whoever is available.
  assert.deepEqual(copy.sessionCounsel({ allAgents: true }, roster), roster);

  // The single-agent record every build before counsels wrote still reads.
  assert.deepEqual(
    copy.sessionCounsel({ agentId: 'a1' }, roster).map((a) => a.name),
    ['Tessie']
  );

  assert.deepEqual(copy.sessionCounsel(null, roster), []);
  assert.deepEqual(copy.sessionCounsel({ agentIds: ['a1'] }, undefined), []);
});

test('the sidebar row and the search result say the same thing about a session', () => {
  // Two surfaces, one sentence. counselCopy exists because four of them each
  // phrasing it their own way is how somebody comes to believe they are asking a
  // different set of agents than they are — and the results panel is a fifth.
  const sidebar = fs.readFileSync(path.join(SRC, 'components', 'Sidebar.jsx'), 'utf8');
  const results = fs.readFileSync(path.join(SRC, 'components', 'SearchResults.jsx'), 'utf8');
  for (const [name, src] of [
    ['Sidebar', sidebar],
    ['SearchResults', results],
  ]) {
    assert.match(src, /sessionSubLine\(/, `${name} should say it with counselCopy's sentence`);
    assert.match(src, /sessionCounsel\(/, `${name} should resolve the counsel through counselCopy`);
  }
  assert.doesNotMatch(results, /\?\s*'Session'\s*:/, 'the results panel should not have its own word for it');
});
