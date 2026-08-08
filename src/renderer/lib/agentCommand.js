// Is the command an ACP agent is configured with actually Hermes?
//
// The form needs this answer for the same reason main does, and cannot ask
// main for it: `--profile` is Hermes' own flag, so the profile field only means
// something when the command is Hermes — and a field that means nothing should
// say so rather than accept a value and drop it. Deciding that in the renderer
// is what keeps the answer immediate, while the command is still being typed.
//
// This is the second home of a rule that lives in src/main/agents/profiles.js,
// which the renderer cannot import: that module is CommonJS and reads the
// filesystem. Two copies of a rule drift, so the suite runs one table of inputs
// through both and asserts they agree — the copy is duplicated, the behaviour
// is not allowed to be.
//
// The basename is taken on both separators rather than with node's path,
// which splits on a backslash only when it is itself running on Windows. An
// agent record is portable — it can be edited on one machine and read on
// another — so `C:\tools\hermes.exe` has to resolve the same way everywhere.
export function isHermesCommand(command) {
  const base = String(command || '')
    .trim()
    .split(/[\\/]/)
    .pop()
    .toLowerCase();
  return base === 'hermes' || base === 'hermes.exe';
}
