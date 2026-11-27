import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { frameSamples, siteId, siteLabel, viewport } from './e2e-manual-browser-fixture.mjs'

const repo = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '')
const phases = Object.freeze({ ready: 'handoff-ready.png', returned: 'handoff-returned.png' })
const header = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const limit = 4 * 1024 * 1024

export class HandoffCaptureError extends Error {}
function check(ok, code) { if (!ok) throw new HandoffCaptureError(code) }

function privateOrigin(value) {
  const port = Number(/^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(value)?.[1])
  return port > 0 && port < 65536 && value === `http://127.0.0.1:${port}`
}

function screenshotPng(encoded, width, height) {
  check(typeof encoded === 'string' && encoded.length >= 1024 && encoded.length < limit,
    'CAPTURE_PNG_SIZE')
  const bytes = Buffer.from(encoded, 'base64')
  check(bytes.subarray(0, header.length).equals(header) && bytes.length >= 45 &&
    bytes.readUInt32BE(16) === width && bytes.readUInt32BE(20) === height, 'CAPTURE_PNG_GEOMETRY')
  return bytes
}

function captureGeometry(browser, origin, target) {
  return browser.execute(`
    const [origin, target, siteId, siteLabel, source] = arguments;
    const panel = name => '[data-testid="workbench-browser-' + name + '"]';
    const dialogs = document.querySelectorAll('dialog[open]');
    if (location.href !== origin + '/' || !document.hasFocus() || document.visibilityState !== 'visible' ||
        window !== window.top || innerWidth !== 1280 || innerHeight < 800 || innerHeight > 1000 ||
        devicePixelRatio !== 1 || (visualViewport && visualViewport.scale !== 1) || dialogs.length !== 1 ||
        !document.querySelector('[data-testid="workbench-chat"]') || document.querySelector('.wb-auth') ||
        [...document.querySelectorAll('input,textarea,[contenteditable]')].some(el =>
          el.matches('input,textarea') ? el.value !== '' : el.textContent.trim() !== '')) return null;
    const dialog = dialogs[0];
    if (!dialog.matches(panel('dialog')) || dialog.querySelector('iframe,object,embed,video,canvas')) return null;
    const status = dialog.querySelector(panel('status'));
    const site = dialog.querySelector(panel('site'));
    const field = dialog.querySelector(panel('text'));
    const img = dialog.querySelector(panel('frame'));
    if (status?.dataset.status !== 'controlling' || status.querySelector('.bc-site')?.textContent !== target ||
        dialog.querySelector(panel('tab') + ' .bc-tab__title')?.textContent !== siteLabel ||
        !(site instanceof HTMLSelectElement) || site.value !== siteId || site.options.length !== 2 ||
        site.selectedOptions[0]?.textContent !== siteLabel + ' — ' + target ||
        !(field instanceof HTMLInputElement) || field.type !== 'password' || field.disabled || field.value !== '' ||
        dialog.querySelector(panel('complete'))?.disabled !== false ||
        !(img instanceof HTMLImageElement) || !img.complete || !img.currentSrc.startsWith('blob:' + origin + '/') ||
        img.naturalWidth !== source.width || img.naturalHeight !== source.height) return null;
    const d = dialog.getBoundingClientRect(), f = img.getBoundingClientRect(), t = field.getBoundingClientRect();
    const top = Math.ceil(d.top), bottom = Math.floor(d.bottom), left = Math.ceil(d.left), right = Math.floor(d.right);
    const cutTop = Math.floor(f.top), cutBottom = Math.ceil(f.top + 40 * f.height / source.height) + 2;
    const atMiddle = (r, el) => el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
    if (left < 0 || top < 0 || right > innerWidth || bottom > innerHeight || right - left < 750 ||
        f.width < 500 || Math.abs(f.width / f.height - source.width / source.height) > 0.01 ||
        f.left < left || f.right > right || cutTop <= top || cutBottom >= f.bottom || f.bottom > t.top ||
        t.bottom > bottom || t.left < left || t.right > right || !atMiddle(f,img) || !atMiddle(t,field) ||
        !atMiddle(status.getBoundingClientRect(),status)) return null;
    return { width:innerWidth, height:innerHeight, left, right, top, bottom, cutTop, cutBottom,
      frame:{ x:f.left, y:f.top, width:f.width, height:f.height } };
  `, origin, target, siteId, siteLabel, viewport)
}

// Work on a detached canvas, with no DOM/style changes. Decode the actual W3C
// screenshot and prove its composited pixels, then keep only dialog scanlines
// outside the fixture's challenge strip. The uncropped image stays in memory.
function cropScreenshot(browser, encoded, shape, samples) {
  return browser.executeAsync(`
    const [encoded, g, source, samples, done] = arguments;
    const img = new Image();
    img.onerror = () => done(null);
    img.onload = () => {
      try {
        if (img.naturalWidth !== g.width || img.naturalHeight !== g.height) return done(null);
        const canvas = document.createElement('canvas');
        canvas.width = g.right - g.left; canvas.height = g.bottom - g.top - (g.cutBottom - g.cutTop);
        const ctx = canvas.getContext('2d', {alpha:false, willReadFrequently:true});
        ctx.imageSmoothingEnabled = false;
        for (const [x,y,rgb] of samples) {
          const sx = Math.floor(g.frame.x + x * g.frame.width / source.width);
          const sy = Math.floor(g.frame.y + y * g.frame.height / source.height);
          if (sy < g.cutTop || sy >= g.cutBottom) return done(null);
          ctx.drawImage(img,sx,sy,1,1,0,0,1,1);
          const pixel = ctx.getImageData(0,0,1,1).data;
          if (!rgb.every((channel, i) => Math.abs(pixel[i]-channel) <= 4)) return done(null);
        }
        const topHeight = g.cutTop - g.top, bottomHeight = g.bottom - g.cutBottom;
        ctx.drawImage(img,g.left,g.top,canvas.width,topHeight,0,0,canvas.width,topHeight);
        ctx.drawImage(img,g.left,g.cutBottom,canvas.width,bottomHeight,0,topHeight,canvas.width,bottomHeight);
        done(canvas.toDataURL('image/png').slice('data:image/png;base64,'.length));
      } catch { done(null); }
    };
    img.src = 'data:image/png;base64,' + encoded;
  `, encoded, shape, viewport, samples)
}

const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino
const fdPath = handle => `/proc/self/fd/${handle.fd}`

async function openOutputDir(path, expected, privateDir, handles) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  handles.push(handle)
  await verifyOutputDir(handle, expected, privateDir)
  return handle
}

async function verifyOutputDir(handle, expected, privateDir) {
  const info = await handle.stat()
  check(info.isDirectory() && info.uid === process.geteuid() && (info.mode & 0o7022) === 0 &&
    (!privateDir || (info.mode & 0o7777) === 0o700) && await realpath(fdPath(handle)) === expected,
  'CAPTURE_OUTPUT_DIRECTORY')
}

async function publish(images, signal) {
  const directories = [], created = []
  try {
    check(images.size === Object.keys(phases).length, 'CAPTURE_PAIR_INCOMPLETE')
    let expected = repo
    let parent = await openOutputDir(repo, expected, false, directories)
    for (const part of ['test-results', 'manual-browser']) {
      signal.throwIfAborted()
      const child = join(fdPath(parent), part)
      await mkdir(child, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
      expected = join(expected, part)
      parent = await openOutputDir(child, expected, part === 'manual-browser', directories)
    }
    // Anchor opens/deletes to the checked directory descriptor. O_EXCL rejects
    // existing files and links; rollback touches only inodes created by this run.
    for (const [phase, filename] of Object.entries(phases)) {
      signal.throwIfAborted()
      await verifyOutputDir(parent, expected, true)
      const path = join(fdPath(parent), filename)
      const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try {
        created.push({ path, identity: await handle.stat() })
        await handle.chmod(0o600)
        await handle.writeFile(images.get(phase), { signal })
      } finally { await handle.close() }
    }
    await verifyOutputDir(parent, expected, true)
    signal.throwIfAborted()
  } catch (error) {
    let clean = true
    for (const { path, identity } of created) {
      try {
        const current = await lstat(path)
        check(current.isFile() && current.uid === process.geteuid() && current.nlink === 1 && sameFile(current, identity),
          'CAPTURE_OUTPUT_CHANGED')
        await unlink(path)
      } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') clean = false }
    }
    check(clean, 'CAPTURE_OUTPUT_CLEANUP_FAILED')
    if (error.code === 'EEXIST') throw new HandoffCaptureError('CAPTURE_OUTPUT_ALREADY_EXISTS')
    throw error
  } finally {
    await Promise.allSettled(directories.reverse().map(handle => handle.close()))
  }
}

/** Synthetic form only; the caller retains the real W3C interaction and lease checks. */
export function createHandoffCapture(signal) {
  if (process.env.DEVA_QA_HANDOFF_CAPTURE !== '1') return null
  const images = new Map()
  return {
    async take({ browser, origin, fixture, nonce, verifyTab }, phase) {
      check(Object.hasOwn(phases, phase) && !images.has(phase) && (phase === 'ready' || images.has('ready')) &&
        privateOrigin(origin) && privateOrigin(fixture.origin) && origin !== fixture.origin &&
        typeof nonce === 'string' && /^[a-f0-9]{24}$/.test(nonce), 'CAPTURE_FIXTURE_SCOPE')
      const verified = async () => {
        signal.throwIfAborted()
        const documents = fixture.documents
        check(!fixture.failure && documents.length === 1 && documents[0] === nonce &&
          fixture.confirmed(nonce) === (phase === 'returned') && await verifyTab() === true, 'CAPTURE_TARGET_NOT_VERIFIED')
        const geometry = await captureGeometry(browser, origin, fixture.origin)
        check(geometry, 'CAPTURE_UI_NOT_SAFE')
        return geometry
      }
      const shape = await verified()
      const encoded = await browser.fixtureScreenshot()
      const after = await verified()
      check(JSON.stringify(after) === JSON.stringify(shape), 'CAPTURE_UI_CHANGED')
      screenshotPng(encoded, shape.width, shape.height)
      const crop = await cropScreenshot(browser, encoded, shape, frameSamples(nonce, phase === 'ready' ? 'ready' : 'done'))
      check(crop, 'CAPTURE_SCREEN_PIXELS_NOT_VERIFIED')
      images.set(phase, screenshotPng(crop, shape.right - shape.left, shape.bottom - shape.top - (shape.cutBottom - shape.cutTop)))
    },
    publish: () => publish(images, signal),
  }
}
