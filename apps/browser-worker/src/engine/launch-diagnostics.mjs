const RULES = [
  ['missing-library', /error while loading shared libraries|cannot open shared object file/iu],
  ['sandbox-denied', /no usable sandbox|failed to (?:move to new|unshare) namespace|setuid sandbox helper binary|chrome-sandbox.{0,80}not configured/iu],
  ['debug-pipe', /remote debugging pipe file descriptors are not open|devtools.{0,30}pipe.{0,70}(?:bad file descriptor|broken pipe)/iu],
  ['profile-lock', /failed to create (?:a )?processsingleton|profile (?:appears to be|is already) in use/iu],
  ['snap-wrapper', /requires the chromium snap|cannot (?:communicate with server|find installed snap)|snap-confine.{0,80}(?:permission denied|operation not permitted)/iu],
  ['startup-fatal', /\bFATAL:|crashpad_handler: --database is required/iu],
];

// Drain startup stderr, classify only a bounded prefix, and emit no message text.
// A short carry handles split writes; it is discarded before any site is navigated.
export function classifyStartupStderr(stream) {
  let remaining = 32 * 1024;
  let tail = '';
  let hint = 'silent';
  let priority = RULES.length;
  const onData = (data) => {
    if (remaining <= 0) return;
    const bytes = data.subarray(0, remaining);
    remaining -= bytes.length;
    if (hint === 'silent' && bytes.length) hint = 'unclassified';
    const window = tail + bytes.toString('utf8');
    for (let index = 0; index < priority; index++) {
      const [label, pattern] = RULES[index];
      if (pattern.test(window)) { hint = label; priority = index; break; }
    }
    tail = remaining > 0 && priority !== 0 ? window.slice(-256) : '';
  };
  stream?.on('error', () => {});
  stream?.on('data', onData);
  return {
    hint: () => hint,
    finish() {
      remaining = 0;
      tail = '';
      stream?.off('data', onData);
      stream?.resume();
    },
  };
}
