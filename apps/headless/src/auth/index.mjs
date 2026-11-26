import crypto, { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { decodeFixed, openAuthState, SALT_BYTES, VERIFIER_BYTES } from './state.mjs';

export { AuthStateError } from './state.mjs';

const TOKEN_BYTES = 32;
const CLAIM_TTL_MS = 10 * 60_000;
const SESSION_TTL_MS = 12 * 60 * 60_000;
const MAX_SESSIONS = 5;
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 60_000;
const MIN_PASSWORD_CHARS = 12;
const MAX_PASSWORD_BYTES = 1024;
const SCRYPT_OPTIONS = Object.freeze({ N: 2 ** 17, r: 8, p: 1, maxmem: 160 * 1024 * 1024 });

function derive(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, VERIFIER_BYTES, SCRYPT_OPTIONS, (error, verifier) => {
      if (error) reject(error);
      else resolve(verifier);
    });
  });
}

export class AuthError extends Error {
  constructor() {
    super('Authentication failed');
    this.name = 'AuthError';
    this.code = 'AUTH_FAILED';
  }
}

function reject() {
  throw new AuthError();
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest();
}

function tokenKey(value) {
  const bytes = decodeFixed(value, TOKEN_BYTES);
  return bytes === null ? null : hash(bytes).toString('base64url');
}

function passwordBuffer(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_CHARS ||
      password.length > MAX_PASSWORD_BYTES || !password.isWellFormed() ||
      [...password].length < MIN_PASSWORD_CHARS || Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    return null;
  }
  return Buffer.from(password, 'utf8');
}

function expiration(ttlMs) {
  return { deadline: performance.now() + ttlMs, expiresAt: Date.now() + ttlMs };
}

function failureBudget() {
  let failures = [];
  function trim(now) {
    while (failures.length > 0 && now - failures[0] >= FAILURE_WINDOW_MS) failures.shift();
  }
  return {
    check() {
      trim(performance.now());
      if (failures.length >= MAX_FAILURES) reject();
    },
    fail() {
      const now = performance.now();
      trim(now);
      if (failures.length < MAX_FAILURES) failures.push(now);
      reject();
    },
    reset() {
      failures = [];
    },
  };
}

/** One service per running HTTP workbench. Only the deployment control plane calls issueClaim. */
export async function createAuthService({ dataDir }) {
  const state = await openAuthState(dataDir);
  let owner = state.owner;
  let pendingClaim = null;
  let derivationBusy = false;
  let claimStateError = null;
  const claimBudget = failureBudget();
  const loginBudget = failureBudget();
  const sessions = new Map();
  // Process-local opaque identities for internal resource ownership. These are never cookie
  // verifiers, never persisted, and never included in HTTP bootstrap or public session data.
  const ownerId = randomBytes(24).toString('base64url');
  const revoked = new Set();

  function clearClaim() {
    pendingClaim?.verifier.fill(0);
    pendingClaim = null;
  }

  function removeSession(key) {
    const active = sessions.get(key);
    if (!active) return;
    active.csrf.fill(0);
    sessions.delete(key);
    for (const listener of revoked) {
      try { listener(active.loginSessionId); } catch { /* Revocation must succeed even if a consumer closes badly. */ }
    }
  }

  function openSession() {
    const now = performance.now();
    for (const [key, session] of sessions) {
      if (now >= session.deadline) removeSession(key);
    }
    while (sessions.size >= MAX_SESSIONS) removeSession(sessions.keys().next().value);
    let token;
    let key;
    do {
      token = randomBytes(TOKEN_BYTES);
      key = hash(token).toString('base64url');
    } while (sessions.has(key));
    const csrf = randomBytes(TOKEN_BYTES);
    const { deadline, expiresAt } = expiration(SESSION_TTL_MS);
    sessions.set(key, { csrf, deadline, expiresAt, loginSessionId: randomBytes(24).toString('base64url') });
    return { session: token.toString('base64url'), csrf: csrf.toString('base64url'), expiresAt };
  }

  function getSession(session) {
    const key = tokenKey(session);
    const active = sessions.get(key);
    if (!active) reject();
    if (performance.now() >= active.deadline) {
      removeSession(key);
      reject();
    }
    return active;
  }

  return Object.freeze({
    isClaimed() {
      return owner !== null;
    },

    async issueClaim() {
      if (claimStateError) throw claimStateError;
      if (owner || derivationBusy) reject();
      const latestOwner = await state.loadOwner();
      owner ??= latestOwner;
      if (owner || derivationBusy || claimStateError) reject();
      clearClaim();
      claimBudget.reset();
      const token = randomBytes(TOKEN_BYTES);
      const { deadline, expiresAt } = expiration(CLAIM_TTL_MS);
      pendingClaim = { verifier: hash(token), deadline };
      return { credential: token.toString('base64url'), expiresAt, ttlMs: CLAIM_TTL_MS };
    },

    async claim(credential, password) {
      if (owner || derivationBusy || claimStateError) reject();
      claimBudget.check();
      if (pendingClaim && performance.now() >= pendingClaim.deadline) clearClaim();
      const issued = pendingClaim;
      const token = decodeFixed(credential, TOKEN_BYTES);
      if (!issued || !token || !timingSafeEqual(issued.verifier, hash(token))) claimBudget.fail();
      const bytes = passwordBuffer(password);
      if (!bytes) claimBudget.fail();
      derivationBusy = true;
      let verifier;
      try {
        const salt = randomBytes(SALT_BYTES);
        verifier = await derive(bytes, salt);
        const eligible = () => pendingClaim === issued && performance.now() < issued.deadline;
        // Check again after async derivation and immediately before the atomic commit.
        if (!eligible()) claimBudget.fail();
        let result;
        try {
          result = await state.commitOwner({ salt, verifier }, eligible);
        } catch (error) {
          claimStateError = error;
          clearClaim();
          throw error;
        }
        owner = result.owner;
        if (!result.committed) {
          if (owner) clearClaim();
          claimBudget.fail();
        }
        clearClaim();
        claimBudget.reset();
        return openSession();
      } finally {
        bytes.fill(0);
        if (owner?.verifier !== verifier) verifier?.fill(0);
        derivationBusy = false;
      }
    },

    async login(password) {
      if (derivationBusy) reject();
      loginBudget.check();
      if (!owner) loginBudget.fail();
      const bytes = passwordBuffer(password);
      if (!bytes) loginBudget.fail();
      derivationBusy = true;
      let supplied;
      try {
        supplied = await derive(bytes, owner.salt);
        if (!timingSafeEqual(owner.verifier, supplied)) loginBudget.fail();
        loginBudget.reset();
        return openSession();
      } finally {
        bytes.fill(0);
        supplied?.fill(0);
        derivationBusy = false;
      }
    },

    authenticate(session, csrf) {
      const active = getSession(session);
      if (arguments.length > 1) {
        const provided = decodeFixed(csrf, TOKEN_BYTES);
        if (!provided || !timingSafeEqual(active.csrf, provided)) reject();
      }
      return { expiresAt: active.expiresAt };
    },

    identify(session, csrf) {
      const active = getSession(session);
      if (arguments.length > 1) {
        const supplied = decodeFixed(csrf, TOKEN_BYTES);
        if (!supplied || !timingSafeEqual(active.csrf, supplied)) reject();
      }
      return Object.freeze({ role: 'owner', ownerId, loginSessionId: active.loginSessionId });
    },

    isLoginActive(identity) {
      if (identity?.role !== 'owner' || identity.ownerId !== ownerId) return false;
      for (const [key, current] of sessions) {
        if (current.loginSessionId !== identity.loginSessionId) continue;
        if (performance.now() < current.deadline) return true;
        removeSession(key);
        return false;
      }
      return false;
    },

    onSessionRevoked(listener) {
      if (typeof listener !== 'function') throw TypeError('Expected a revocation listener');
      revoked.add(listener);
      return () => revoked.delete(listener);
    },

    describe(session) {
      const active = getSession(session);
      return { csrf: active.csrf.toString('base64url'), expiresAt: active.expiresAt };
    },

    logout(session) {
      removeSession(tokenKey(session));
    },
  });
}
