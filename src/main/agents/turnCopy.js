'use strict';

// What an agent says on its own behalf: the turn queue, and the greeting that is
// not an answer to anything.
//
// Two machines write these lines now — the agent's owner, which knows the queue,
// and the asker's own copy, which refuses a second attempt before it ever
// reaches the wire. Same sentence from two places is how the two start drifting
// apart, so they are written once here and required from both.

// The first question asked out of turn. It is kept and read when the turn lands,
// so the line has to say so — otherwise it reads as a refusal and the asker
// retypes something that was never lost.
function heldLine(name, position) {
  return (
    `${name} is busy with someone else. You are #${position} in line — ` +
    `I have kept your question and will read it the moment your turn comes.`
  );
}

// The same thing, reached by spending a whole turn rather than by waiting for
// one. Named for what happened rather than what it says, because the difference
// matters to the reader: they did get their turn, and it just ended.
function rotatedLine(quota, position) {
  return (
    `That is ${quota} queries — passing to the next person waiting. ` +
    `You are #${position} in line; I have kept this question and will read it when your turn comes round.`
  );
}

// Asking again while the first question is still held. Nothing is kept this
// time: there is already a question waiting to be read, and a queue that has not
// moved does not move for being asked twice.
function busyLine(name, position) {
  return `${name} is busy with someone else. You are #${position} in line — ask again when it is your turn.`;
}

// A bare `@name` used to be answered with a greeting here. It no longer is: a
// summon opens the agent's thread and writes nothing, on either machine, so
// there is no line to write. The thread it opens is for the questions and the
// answers, and "Hello — X here" was neither.
//
// What made the greeting worth having was that it proved the channel worked, and
// that job has moved rather than gone: the asking side only offers a name its
// owner is currently advertising, so reaching one at all is the proof, and the
// agent's row says so by pulsing until it is opened.
//
// The sentence survives here, unused by anything that writes, because a peer on
// an older build still sends it and this machine has to be able to recognise one
// arriving. Kept as the exact string rather than a pattern so the recognition is
// an equality against the agent's own name — see receive() in remote.js — which
// is what makes it impossible to mistake a real answer for one. It goes when no
// build old enough to send it is left.
function legacyGreeting(name) {
  return `Hello — ${name} here. Ask me anything.`;
}

module.exports = { heldLine, rotatedLine, busyLine, legacyGreeting };
