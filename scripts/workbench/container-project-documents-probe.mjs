// Fixed, source-independent inspection in the exact production image (never a host mount).
export const claimProgram = `
const { requestControl } = await import('/opt/deva/apps/headless/src/control/socket.mjs');
const { credential } = await requestControl({ runDir: '/run/deva', op: 'claim' });
console.log(JSON.stringify({ credential }));`

async function observe() {
  const { createHash } = await import('node:crypto')
  const { lstat, readFile, readdir, realpath } = await import('node:fs/promises')
  const [mode, owner] = process.argv.slice(1)
  const check = condition => { if (!condition) throw Error('native project proof failed') }
  const uid = 1000n, gid = 1000n
  check(['default', 'edit', 'create'].includes(mode) && process.platform === 'linux' && process.arch === 'x64' &&
    process.getuid() === Number(uid) && process.getgid() === Number(gid) && /^[1-9][0-9]{0,9}$/u.test(owner) && Number(owner) < 2 ** 32 - 1)
  const fixtureUid = BigInt(owner)
  for (const who of ['self', '1']) {
    const status = await readFile(`/proc/${who}/status`, 'utf8')
    check(/^Uid:\s+1000\s+1000\s+1000\s+1000$/mu.test(status) && /^NoNewPrivs:\s+1$/mu.test(status) &&
      ['Eff', 'Prm', 'Bnd', 'Amb'].every(key => new RegExp(`^Cap${key}:\\s+0+$`, 'mu').test(status)))
  }
  const mounts = (await readFile('/proc/1/mountinfo', 'utf8')).split('\n').map(line => line.split(' '))
  const mounted = (name, mode) => mounts.filter(row => row[4] === name).length === 1 && mounts.some(row => row[4] === name && row[5].split(',').includes(mode))
  check(mounted('/', 'ro') && mounted('/data', 'rw') && mounted('/keys', 'ro'))
  async function privatePath(path, type, permissions) {
    const info = await lstat(path, { bigint: true })
    check(info[type]() && info.uid === uid && info.gid === gid && (info.mode & 0o7777n) === BigInt(permissions) && await realpath(path) === path)
    if (type === 'isFile') check(info.nlink === 1n)
    return info
  }
  const key = await privatePath('/keys/master.key', 'isFile', 0o600)
  check(key.size === 32n)
  if (mode === 'default') {
    check(!mounts.some(row => row[4] === '/workspaces') && await lstat('/workspaces').then(() => false, err => err.code === 'ENOENT'))
    console.log(JSON.stringify({ withoutWorkspace: true }))
    return
  }
  check(mounted('/workspaces', 'rw'))
  const root = '/workspaces/Alpha/Notes'
  const { access, constants } = await import('node:fs/promises')
  for (const path of ['/workspaces', '/workspaces/Alpha', root]) {
    const info = await lstat(path, { bigint: true })
    // The host independently verifies the precise ACL: mode 0770 is its mask, not owning-group access.
    check(info.isDirectory() && info.uid === fixtureUid && (info.mode & 0o7777n) === (fixtureUid === uid ? 0o700n : 0o770n) &&
      await realpath(path) === path)
    await access(path, constants.R_OK | constants.W_OK | constants.X_OK)
  }
  await privatePath(`${root}/original.txt`, 'isFile', 0o600)
  const ordinary = await readFile(`${root}/original.txt`, 'utf8'), entries = (await readdir(root)).sort()
  const result = { entries, ordinary }
  if (mode === 'create') {
    const leaf = '项目笔记.md', path = `${root}/${leaf}`, relative = `Notes/${leaf}`
    const info = await privatePath(path, 'isFile', 0o600), bytes = await readFile(path)
    const after = await privatePath(path, 'isFile', 0o600)
    const identity = state => [state.dev, state.ino, state.birthtimeNs, state.size, state.ctimeNs, state.mtimeNs].map(String)
    check(JSON.stringify(identity(info)) === JSON.stringify(identity(after)) && BigInt(bytes.length) === info.size)
    result.identity = identity(info)
    result.content = bytes.toString('utf8')
    check(Buffer.from(result.content).equals(bytes))
    result.revision = 'r_' + createHash('sha256').update(JSON.stringify([relative, ...result.identity])).update(bytes).digest('hex')
  }
  console.log(JSON.stringify(result))
}

export const proofProgram = `await (${observe})();`

export const seedProgram = `
const { writeFile, lstat, readdir } = await import('node:fs/promises');
const check = ok => { if (!ok) throw Error('fixture seed failed') };
const parent = '/workspaces/Alpha/Notes', path = parent + '/original.txt';
check(process.getuid() === 1000 && process.getgid() === 1000 && (await readdir(parent)).length === 0);
await writeFile(path, process.argv[1], { mode: 0o600, flag: 'wx' });
const s = await lstat(path);
check(s.isFile() && s.uid === 1000 && s.gid === 1000 && (s.mode & 0o7777) === 0o600 && s.nlink === 1);
console.log('Seeded one private fixture');`

// The host filesystem holds only access ACLs on three runner-owned directory FDs.
// Linux's group-class mode bits show the ACL mask; the owning group itself has zero access.
export const fixtureAclProgram = `
import errno, json, os, stat, struct, sys
root, operation, target, expected = sys.argv[1:]
target, expected = int(target), json.loads(expected)
owner = os.geteuid()
assert 0 < owner < 0xffffffff and 0 < target < 0xffffffff and operation in ('grant', 'verify')
assert os.path.isabs(root) and os.path.realpath(root) == root and len(expected) == 4
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
access, default = 'system.posix_acl_access', 'system.posix_acl_default'

def attr(fd, name):
    try:
        return os.getxattr(fd, name)
    except OSError as err:
        if err.errno != errno.ENODATA:
            raise
        return None

def verify(fd, index, mode):
    s = os.fstat(fd)
    assert stat.S_ISDIR(s.st_mode) and stat.S_IMODE(s.st_mode) == mode and s.st_uid == owner
    assert [str(s.st_dev), str(s.st_ino)] == expected[index]
    assert attr(fd, default) is None

fd = os.open(root, flags)
try:
    verify(fd, 0, 0o700)
    assert attr(fd, access) is None
    undefined = 0xffffffff
    entries = [(1, 7, undefined), (2, 7, target), (4, 0, undefined), (16, 7, undefined), (32, 0, undefined)]
    acl = struct.pack('<I', 2) + b''.join(struct.pack('<HHI', *entry) for entry in entries)
    for index, part in enumerate(('approved-projects', 'Alpha', 'Notes'), 1):
        next_fd = os.open(part, flags, dir_fd=fd)
        os.close(fd)
        fd = next_fd
        if operation == 'grant':
            verify(fd, index, 0o700)
            assert attr(fd, access) is None
            if target != owner:
                os.setxattr(fd, access, acl, os.XATTR_CREATE)
        verify(fd, index, 0o700 if target == owner else 0o770)
        assert attr(fd, access) == (None if target == owner else acl)
finally:
    os.close(fd)
print('Verified private directory ACLs')
`
