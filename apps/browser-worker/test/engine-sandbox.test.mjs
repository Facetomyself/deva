import assert from 'node:assert/strict';
import test from 'node:test';
import { EngineError } from '../src/engine/chromium.mjs';
import { classifyRendererCmdline, verifyRendererSandbox } from '../src/engine/sandbox.mjs';

const profile = '/tmp/deva-browser-example';
const uid = 997;
const user = `Uid:\t${uid}\t${uid}\t${uid}\t${uid}`;
const rendererStatus = `${user}\nNSpid:\t104\t2\nNoNewPrivs:\t1\nSeccomp:\t2\nSeccomp_filters:\t2\n`;
function stat(pid, parent, group, start = pid * 10) {
  return `${pid} (name with (parentheses)) S ${parent} ${group} ${Array(16).fill('0').join(' ')} ${start} 0`;
}

function fixture({ renderer = rendererStatus, rendererParent = 103, rendererMap = '997 997 1', inventory,
  argv = 'chrome\0--type=renderer\0', trustedBrowserInventory = false, recycledRenderer = false } = {}) {
  const files = new Map(Object.entries({
    '/proc/101/stat': stat(101, 100, 101),
    '/proc/102/stat': stat(102, 101, 102),
    '/proc/103/stat': stat(103, 102, 103),
    '/proc/104/stat': stat(104, rendererParent, 104),
    '/proc/102/status': `${user}\nNSpid:\t102\nNoNewPrivs:\t0\nSeccomp:\t2\nSeccomp_filters:\t1\n`,
    '/proc/104/status': renderer,
    '/proc/102/cmdline': `chrome\0--user-data-dir=${profile}\0--remote-debugging-pipe\0`,
    '/proc/104/cmdline': argv,
    '/proc/102/uid_map': '0 0 4294967295',
    '/proc/104/uid_map': rendererMap,
  }));
  const reads = [];
  const owned = new Set();
  let rendererStatRead = false;
  return {
    reads, owned, files,
    verify: () => verifyRendererSandbox({ pid: 101, uid, profile, signal: new AbortController().signal, timeoutMs: 0,
      trustedBrowserInventory,
      getProcessInfo: async () => ({ processInfo: inventory ?? [{ type: 'browser', id: 102 }, { type: 'renderer', id: 104 }] }),
      observeOwned: (rows) => { for (const row of rows) owned.add(row.pid); },
      proc: { async readlink() { throw new Error('no ptrace'); }, async readFile(path) {
        reads.push(path);
        if (path === '/proc/104/stat') {
          if (rendererStatRead && recycledRenderer) return stat(104, rendererParent, 104, 1041);
          rendererStatRead = true;
        }
        if (!files.has(path) || files.get(path) === null) throw new Error('not present');
        return files.get(path);
      } },
    }),
  };
}

test('attests a real renderer identity across distinct kernel process groups using only owned ancestry', async () => {
  const { verify, reads, owned } = fixture();
  await verify();
  assert.deepEqual([...owned].sort(), [101, 102, 103, 104]);
  assert.ok(reads.every((path) => /^\/proc\/(101|102|103|104)\//u.test(path)));
});

test('strict local renderer discovery recognizes only exact role arguments', () => {
  for (const argv of ['chrome\0--type=renderer\0', '/opt/google/chrome/chrome --type=renderer --lang=en-US']) {
    assert.deepEqual(classifyRendererCmdline(argv), { readable: true, explicitRenderer: true, contradictory: false });
  }
  for (const argv of [
    'chrome\0https://example.invalid/--type=renderer\0', 'chrome --url=https://example.invalid/#--type=renderer',
    'chrome --note="fake --type=renderer token"', 'chrome --note=fake --type=renderer',
    'chrome\0--url=note --type=renderer\0', 'chrome --type=renderer2',
    'unrelated --type=renderer', 'chrome\0--type=renderer\0--type=gpu-process\0',
  ]) {
    assert.equal(classifyRendererCmdline(argv).explicitRenderer, false);
  }
  assert.equal(classifyRendererCmdline('chrome --type=gpu-process --lang=en-US').contradictory, true);
  assert.equal(classifyRendererCmdline('chrome --type=renderer --note="test --type=gpu-process"').contradictory, false);
});

test('the private Browser report can identify hidden argv, but enforces stable lineage and rejects conflicting roles', async () => {
  for (const argv of [null, '', 'chrome\0']) {
    await fixture({ argv, trustedBrowserInventory: true }).verify();
    await assert.rejects(fixture({ argv }).verify(), { code: 'BROWSER_SANDBOX_REQUIRED' });
  }
  for (const argv of ['chrome\0--type=gpu-process\0', 'chrome --type=utility --lang=en-US']) {
    await assert.rejects(fixture({ argv, trustedBrowserInventory: true }).verify(), (error) => {
      assert.equal(error.diagnostic.sandbox.rendererArgvContradiction, true);
      assert.equal(error.diagnostic.sandbox.rendererIdentity, false);
      return true;
    });
  }
  await assert.rejects(fixture({ argv: '', trustedBrowserInventory: true, recycledRenderer: true }).verify(), (error) => {
    assert.equal(error.diagnostic.sandbox.rendererStable, false);
    assert.equal(error.diagnostic.sandbox.rendererIdentity, false);
    return true;
  });
  await assert.rejects(fixture({ argv: '', trustedBrowserInventory: true,
    renderer: rendererStatus.replace('NoNewPrivs:\t1', 'NoNewPrivs:\t0') }).verify(), { code: 'BROWSER_SANDBOX_REQUIRED' });
  await assert.rejects(fixture({ argv: '', trustedBrowserInventory: true,
    inventory: [{ type: 'browser', id: 102 }, { type: 'renderer', id: 104 }, { type: 'GPU', id: 104 }] }).verify(), (error) => {
    assert.equal(error.diagnostic.sandbox.inventoryConsistent, false);
    return true;
  });
});

test('renderer status flags are independent, strictly required, and exposed only as evidence labels', async () => {
  for (const [settings, field, expected] of [
    [{ renderer: rendererStatus.replace('NSpid:\t104\t2', 'NSpid:\t104') }, 'pidNamespace', false],
    [{ renderer: rendererStatus.replace('NoNewPrivs:\t1', 'NoNewPrivs:\t0') }, 'nnp', false],
    [{ renderer: rendererStatus.replace('NoNewPrivs:\t1\n', '') }, 'nnpReadable', false],
    [{ renderer: rendererStatus.replace('Seccomp:\t2', 'Seccomp:\t0') }, 'seccomp', false],
    [{ renderer: rendererStatus.replace('Seccomp_filters:\t2', 'Seccomp_filters:\t1') }, 'filterDelta', false],
    [{ renderer: rendererStatus.replace(`${user}\n`, '') }, 'rendererUidReadable', false],
    [{ rendererMap: '0 0 4294967295' }, 'userNamespace', false],
    [{ rendererMap: '' }, 'userNamespaceReadable', false],
    [{ rendererParent: 100 }, 'renderersOwned', 0],
  ]) {
    await assert.rejects(fixture(settings).verify(), (error) => {
      assert.equal(error.code, 'BROWSER_SANDBOX_REQUIRED');
      assert.equal(error.diagnostic.sandbox[field], expected);
      assert.equal(error.diagnostic.sandbox.renderersListed, 1);
      assert.equal(error.diagnostic.sandbox.renderersAttested, 0);
      assert.ok(!JSON.stringify(error.diagnostic).includes(profile));
      return true;
    });
  }
  const hostile = new EngineError('BROWSER_SANDBOX_REQUIRED', { sandbox: {
    childIdentity: true, renderersListed: 1, renderersOwned: 10000, url: 'http://secret.local', rendererUid: profile,
  } });
  assert.deepEqual(hostile.diagnostic.sandbox, { childIdentity: true, renderersListed: 1 });
});
