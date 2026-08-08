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
  // Blank is not "the default profile" over ACP, and saying so was wrong on
  // every machine where `hermes profile use` had ever been run: that writes a
  // sticky choice which a bare `hermes acp` follows. Blank means *whatever
  // Hermes is currently set to*, which is why the form reports that name rather
  // than describing it. Picking `default` is the way to pin the root profile
  // for this agent regardless of the sticky choice.
  acp: {
    defaultOption: 'Whatever Hermes is set to',
    placeholder: 'Leave blank to follow Hermes’ own setting',
    unasked: 'Hermes can hold several profiles. Leave blank to follow its current one.',
    found:
      'Read from the Hermes install on this machine. A name it does not know will stop the agent starting.',
    none: 'None found here — type a name, or leave blank to follow Hermes’ current one.',
    // Shown in place of the above when the command is not Hermes at all.
    notHermes:
      '--profile is Hermes’ own flag, so it is not sent to this command. A wrapper made by “hermes profile alias” already selects its own profile.',
  },
};

// What leaving the field blank will actually run, once main has read Hermes'
// sticky setting. A name rather than a description, because "the default" is
// the exact word that made this confusing in the first place.
export function stickyNote(active) {
  const name = String(active || '').trim();
  if (!name) return null;
  if (name === 'default') return 'Blank runs Hermes’ default profile.';
  return `Blank runs “${name}” — Hermes’ current profile on this machine.`;
}

export function profileCopy(kind) {
  return PROFILE_COPY[kind] || PROFILE_COPY.http;
}

export function argumentHint(kind) {
  return ARGUMENT_HINTS[kind] || ARGUMENT_HINTS.command;
}

export function argumentPlaceholder(kind) {
  return ARGUMENT_PLACEHOLDERS[kind] || ARGUMENT_PLACEHOLDERS.command;
}
