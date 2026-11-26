import { readFrame } from './engine/policy.mjs';
import {
  controlFault, createWorkerTransport, exactKeys, validOpaqueId, validSiteId, workerStates,
} from './worker-control.mjs';

export { WorkerControlError } from './worker-control.mjs';

/** @typedef {{sid: string, tabId: string}} Tab */
/** @typedef {Tab & {controlId: string}} Control */
/** @typedef {{type:'click', x:number, y:number} | {type:'scroll', x:number, y:number, deltaX:number, deltaY:number} | {type:'key', key:'Backspace'|'Tab'|'Enter'|'Escape'|'End'|'Home'|'ArrowLeft'|'ArrowUp'|'ArrowRight'|'ArrowDown'|'Delete'} | {type:'text', text:string}} HumanAction */

function checked(value, keys, validate) {
  if (!exactKeys(value, keys) || !validate(value)) throw controlFault();
  return value;
}

function validSite(site) {
  if (!exactKeys(site, ['id', 'label', 'origin']) || !validSiteId(site.id) || typeof site.label !== 'string' ||
      !site.label.trim() || site.label.length > 256 || /[\u0000-\u001f\u007f-\u009f]/u.test(site.label) ||
      typeof site.origin !== 'string' || site.origin.length > 4096) return false;
  try {
    const url = new URL(site.origin);
    return ['https:', 'http:'].includes(url.protocol) && url.origin === site.origin;
  } catch { return false; }
}

/**
 * Creates a private, fixed-operation client. The first endpoint inode binds its lifetime.
 * The workbench checks its own human lease before dispatch and again before delivering a
 * result. On finish, logout, disconnect or timeout, explicitly call endPrivacy, release
 * or closeTab as appropriate and drop stale results. A half-closed request disconnect is
 * not a revocation signal, and revocation cannot undo input already delivered to Chromium.
 */
export function openWorkerClient({ runDir } = {}) {
  const request = createWorkerTransport(runDir);
  return Object.freeze({
    async status() {
      return checked(await request('status', {}), ['state'], ({ state }) => workerStates.includes(state));
    },
    async sites() {
      const sites = await request('sites', {});
      if (!Array.isArray(sites) || sites.length > 128 || !sites.every(validSite) ||
          new Set(sites.map(({ id }) => id)).size !== sites.length) throw controlFault();
      return sites;
    },
    /** @param {{sid: string, siteId: string}} args */
    async open(args) {
      return checked(await request('open', args), ['tabId', 'siteId'],
        ({ tabId, siteId }) => validOpaqueId(tabId) && siteId === args.siteId);
    },
    /** @param {Tab} args */
    async release(args) {
      return checked(await request('release', args), ['released'], ({ released }) => released === true);
    },
    /** @param {Tab} args */
    async closeTab(args) {
      return checked(await request('closeTab', args), ['closed'], ({ closed }) => closed === true);
    },
    /** @param {Tab} args */
    async startPrivacy(args) {
      return checked(await request('startPrivacy', args), ['controlId'], ({ controlId }) => validOpaqueId(controlId));
    },
    /** @param {Control} args */
    async endPrivacy(args) {
      return checked(await request('endPrivacy', args), ['released'], ({ released }) => released === true);
    },
    /** @param {Control} args */
    async frame(args) {
      const result = checked(await request('frame', args), ['image'], ({ image }) => typeof image === 'string');
      try { return readFrame(result.image); } catch { throw controlFault(); }
    },
    /** @param {Control & {action:HumanAction}} args */
    async input(args) {
      return checked(await request('input', args), ['accepted'], ({ accepted }) => accepted === true);
    },
  });
}
