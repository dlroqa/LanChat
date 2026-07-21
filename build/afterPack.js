'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');

// Ad-hoc sign the macOS app bundle.
//
// Repackaging Electron invalidates the signature it ships with, and Apple Silicon
// refuses to execute a binary with no signature at all — macOS then reports the
// app as "damaged", which is really "unsigned". An ad-hoc signature ("-") costs
// nothing, needs no Apple account, and downgrades that hard failure to the normal
// "unidentified developer" prompt users can bypass with right-click -> Open.
//
// This is NOT a substitute for a Developer ID + notarization, which is what
// removes the prompt entirely.
module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);

  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
    console.log(`  • ad-hoc signed  ${appName}`);
    // Fail loudly here rather than shipping a bundle that won't launch.
    execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
    console.log(`  • signature verified  ${appName}`);
  } catch (err) {
    throw new Error(`ad-hoc codesign failed for ${appPath}: ${err.message}`);
  }
};
