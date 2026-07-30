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

// A bare `@name` with nothing after it. The agent is not being asked anything —
// it is being asked to be here — so this is what it says when it arrives.
//
// Written by the owner's machine and never by the asker's. A greeting is the
// agent's to give, and one invented locally would be claiming it spoke when it
// may be switched off, unreachable, or not shared with whoever typed the name.
//
// It also says what to do next, because the moment somebody summons an agent is
// the moment they are trying to find out whether the channel works at all. The
// old answer to that question was the word `(no output)`.
function greetingLine(name) {
  return `Hello — ${name} here. Ask me anything.`;
}

module.exports = { heldLine, rotatedLine, busyLine, greetingLine };
