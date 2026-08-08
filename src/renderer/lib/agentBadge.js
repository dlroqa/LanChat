// The small label under an agent's name in settings.
//
// Which profile a shared agent runs under is a sharing decision, not a detail:
// a profile selects the model, the credentials and the toolsets that everyone
// with reach to that agent can direct questions at. It should not take a click
// to find out.
//
// It folds into the transport tag rather than becoming a fourth badge beside
// `off` and `network`. Three is already the row's limit, and a bare `lanchat`
// sitting next to `ACP` would read as another transport name — where `ACP ·
// lanchat` states the actual relationship: this connection, via that profile.
//
// The profile half is rendered by its own span because `.tag` uppercases its
// contents, and a Hermes profile name is lowercase by rule — `LANCHAT` is a
// string that cannot exist. Showing an identifier in a form it cannot take is a
// small lie, and the kind of thing that sends someone looking for a profile
// they do not have.
//
// Extracted from the component so it can be asserted at all: the test runner
// has no JSX transform, and the section fetches its rows in an effect that
// never runs under server rendering.

import { isHermesCommand } from './agentCommand.js';

// Hermes permits 64 characters. The row is not wide, so a long one is cut with
// the whole value kept on the title — truncated visibly, never silently.
export const PROFILE_MAX_CHARS = 24;

export function agentTag(agent) {
  const kind = String(agent?.kind || '');
  const profile = String(agent?.config?.profile || '').trim();
  // A stored profile is not the same as a profile in effect. Over ACP the name
  // only becomes `--profile` when the command is Hermes, so on any other
  // command — including a wrapper script from `hermes profile alias`, which
  // picks its own — the badge would be naming something that never reached the
  // launch. Showing the transport alone is the honest version of that row.
  const inEffect = kind !== 'acp' || isHermesCommand(agent?.config?.command);
  if (!profile || !inEffect) return { kind, profile: null, title: kind.toUpperCase() };
  return {
    kind,
    profile,
    truncated: profile.length > PROFILE_MAX_CHARS,
    // Read aloud and on hover. The tag itself is two fragments of styled text,
    // which on its own says nothing about what the second one means.
    title: `${kind.toUpperCase()} agent · Hermes profile: ${profile}`,
  };
}
