// Copy for the agent form's Arguments field, which means two different things
// depending on the transport underneath it.
//
// A local command is invoked once per message, so the message has to be placed
// into the command line — `{prompt}` marks where. An ACP agent is a long-lived
// process that is spoken to over JSON-RPC, so the message travels in a
// `session/prompt` call and never appears in argv at all. Both fields used to
// share the `{prompt}` sentence, which told ACP users to do something that does
// not work: the literal text `{prompt}` would simply be handed to their agent
// as an argument.
//
// Extracted from the component because it is the only way to assert it — the
// test runner has no JSX transform, and the section fetches its rows in an
// effect that never runs under server rendering.

// Only the `command` and `acp` transports share this field. SSH has an
// Arguments box too, but its hint is about known_hosts rather than about where
// the message goes, so it stays written out at its own call site.
const SHELL_NOTE = 'Arguments are passed separately — never through a shell.';

export const ARGUMENT_HINTS = {
  command: `{prompt} marks where the message goes. ${SHELL_NOTE}`,
  acp: `Passed to the agent as it starts. The message itself travels over ACP, not in the arguments. ${SHELL_NOTE}`,
};

export const ARGUMENT_PLACEHOLDERS = {
  command: '-z {prompt}',
  acp: 'acp',
};

export function argumentHint(kind) {
  return ARGUMENT_HINTS[kind] || ARGUMENT_HINTS.command;
}

export function argumentPlaceholder(kind) {
  return ARGUMENT_PLACEHOLDERS[kind] || ARGUMENT_PLACEHOLDERS.command;
}
