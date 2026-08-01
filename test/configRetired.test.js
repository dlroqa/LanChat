'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Config, DEFAULTS, RETIRED_KEYS } = require('../src/main/config.js');

// Settings a previous version wrote, and getting rid of them.
//
// load() is `{ ...DEFAULTS, ...JSON.parse(raw) }`, so a key removed from
// DEFAULTS outlives its own deletion: it survives in `data` and every save
// writes it back. Left alone it would be inert — publicConfig() copies only
// PUBLIC_KEYS, so it never reaches the renderer — but it would also be
// permanent, and the stored value beats DEFAULTS, so reusing one of these names
// later would hand an upgraded machine the old value while a fresh install got
// the new default.
//
// So the prune has to be checked against the file, not against the object: an
// assertion on `config.data` alone would pass even if save() put the key back.

const dirs = [];
function tmp(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanchat-retired-'));
  dirs.push(dir);
  if (contents) {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(contents, null, 2));
  }
  return dir;
}

const onDisk = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));

test.after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

test('the FluidAudio CLI settings are deleted from an existing config file', () => {
  const dir = tmp({
    id: 'kept-id',
    displayName: 'MacMini',
    dictationEnabled: true,
    dictationCliPath: '/opt/homebrew/bin/fluidaudiocli',
    dictationModelReady: true,
  });

  const config = new Config(dir);

  assert.equal(config.get('dictationCliPath'), undefined, 'gone from the loaded settings');
  assert.equal(config.get('dictationModelReady'), undefined);

  // The point of the exercise: gone from the file, not just from memory.
  const saved = onDisk(dir);
  assert.ok(!('dictationCliPath' in saved), 'gone from config.json');
  assert.ok(!('dictationModelReady' in saved), 'gone from config.json');

  // And nothing else went with them.
  assert.equal(saved.id, 'kept-id');
  assert.equal(saved.displayName, 'MacMini');
  assert.equal(saved.dictationEnabled, true);
  assert.equal(saved.dictationPort, 47733, 'the replacement default is written in');
});

test('a config without them is not rewritten just for the sake of it', () => {
  const dir = tmp({ id: 'stable', displayName: 'MacMini' });
  const before = fs.statSync(path.join(dir, 'config.json')).mtimeMs;

  new Config(dir);

  // `id` is present, so nothing else marks the file dirty. A prune that saved
  // unconditionally would rewrite every config file on every launch.
  assert.equal(fs.statSync(path.join(dir, 'config.json')).mtimeMs, before);
});

test('the prune survives a second launch', () => {
  const dir = tmp({ id: 'x', displayName: 'y', dictationCliPath: '/somewhere' });
  new Config(dir);
  const second = new Config(dir);

  assert.equal(second.get('dictationCliPath'), undefined);
  assert.ok(!('dictationCliPath' in onDisk(dir)));
});

test('a retired key is never also a live default', () => {
  // The two lists contradicting each other would mean a setting that is deleted
  // on every launch and then recreated by the defaults — a file that never
  // settles, and a preference that silently will not stick.
  for (const key of RETIRED_KEYS) {
    assert.ok(!(key in DEFAULTS), `${key} is retired but still has a default`);
  }
});
