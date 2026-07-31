'use strict';

// The quoted context a fork carries.
//
// No agent transport carries anything but `{ text }` (see documents/index.js),
// so context reaches an agent the same way a document does: as words in the
// prompt, fenced and labelled. Same delimiters as composePrompt uses, on
// purpose — an agent reading a LanChat prompt should meet one convention, not
// two.
//
// Context first, question last. The question is what the agent must act on and
// it should be the most recent thing it read; the excerpt is what the question
// is *about*, which is exactly the order a person would say it in.

// Long enough to carry an answer worth forking from, short enough that quoting
// it cannot crowd out the documents attached to the same message.
const MAX_CONTEXT_CHARS = 8000;

function composeContext(context, prompt) {
  if (!context || !context.text) return prompt;
  const body =
    context.text.length > MAX_CONTEXT_CHARS
      ? `${context.text.slice(0, MAX_CONTEXT_CHARS)}\n[Truncated]`
      : context.text;
  const who = context.speaker ? ` — ${context.speaker}` : '';
  const when = context.ts ? `, ${new Date(context.ts).toLocaleString()}` : '';
  const block = [`[Context from an earlier conversation${who}${when}]`, '<<<', body, '>>>'].join('\n');
  return prompt ? `${block}\n\n${prompt}` : block;
}

// What is stored on the message, as opposed to what is sent. The window renders
// this as a quote above the question; it is deliberately the excerpt itself and
// not the composed prompt, for the same reason a message stores what was typed
// rather than the documents folded into it.
function contextRecord(context) {
  if (!context || !context.text) return null;
  const text = String(context.text);
  return {
    text: text.length > MAX_CONTEXT_CHARS ? `${text.slice(0, MAX_CONTEXT_CHARS)}…` : text,
    speaker: context.speaker || null,
    ts: context.ts || null,
  };
}

module.exports = { composeContext, contextRecord, MAX_CONTEXT_CHARS };
