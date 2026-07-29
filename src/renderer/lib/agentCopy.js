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

// The profile picker serves both transports that can choose one, and the two
// differ in a way the copy must not blur. Over HTTP an unrecognised name is
// quietly served as the server's default, so the form promises a fallback. Over
// ACP the name is a launch flag and a wrong one stops the agent starting, so
// the same promise would be a lie.
export const PROFILE_COPY = {
  http: {
    defaultOption: 'Server default',
    placeholder: 'Leave blank for the server default',
    unasked: 'One server can host several profiles. Leave blank for its default.',
    found: 'Found on this machine. A name the server does not know falls back to its default.',
    none: 'None found here — type a name, or leave blank for the default.',
  },
  acp: {
    defaultOption: 'Default profile',
    placeholder: 'Leave blank for the default profile',
    unasked: 'Hermes can hold several profiles. Leave blank to use its default.',
    found: 'Read from the Hermes install on this machine. A name it does not know will stop the agent starting.',
    none: 'None found here — type a name, or leave blank for the default.',
  },
};

export function profileCopy(kind) {
  return PROFILE_COPY[kind] || PROFILE_COPY.http;
}

export function argumentHint(kind) {
  return ARGUMENT_HINTS[kind] || ARGUMENT_HINTS.command;
}

export function argumentPlaceholder(kind) {
  return ARGUMENT_PLACEHOLDERS[kind] || ARGUMENT_PLACEHOLDERS.command;
}
