// Fixed probe evaluated by `docker exec` as the image user; neither read nor served from a host mount.
async function probe() {
  let stage = 'probe-input'
  function check(ok) { if (!ok) throw Error('verification failed') }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  try {
    const { createHash, randomBytes } = await import('node:crypto')
    const { lstat, mkdir, readFile, readdir, realpath, writeFile } = await import('node:fs/promises')
    const { setTimeout: delay } = await import('node:timers/promises')
    const { requestControl } = await import('/opt/deva/apps/headless/src/control/socket.mjs')
    const [phase] = process.argv.slice(1)
    const first = phase === 'first'
    check(first || phase === 'second')
    const chunks = []; let size = 0
    for await (const bytes of process.stdin) { size += bytes.length; check(size <= 8192); chunks.push(bytes) }
    const input = JSON.parse(Buffer.concat(chunks).toString())
    const digest = bytes => createHash('sha256').update(bytes).digest('hex')
    const revision = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
    const origin = 'http://127.0.0.1:8787', web = '/opt/deva/web'
    const id = 'proofreading', description = 'Demo document for the installed skill library.'
    const instructions = 'Demo text: check punctuation in the selected sentence.'
    const document = '/data/skills/proofreading/SKILL.md', config = '/data/config.json', persona = '/data/personas/general.md'
    const fixture = `---\nname: ${id}\ndescription: ${description}\n---\n\n${instructions}\n`
    const numeric = '"nativeQaMarker":-1.2300e+04'
    const privateFile = async path => {
      const info = await lstat(path)
      check(await realpath(path) === path && info.isFile() && info.uid === 1000 && info.nlink === 1 && (info.mode & 0o077) === 0)
      return readFile(path)
    }
    const http = (path, options) => fetch(origin + path, { redirect: 'error', signal: AbortSignal.timeout(5000), ...options })
    let cookie, csrf
    async function api(path, { method = 'GET', body, expected = 200, session = cookie } = {}) {
      const res = await http('/api/v1/' + path, { method,
        headers: { ...(session ? { cookie: session } : {}), ...(body === undefined ? {} : {
          origin, 'content-type': 'application/json', ...(csrf ? { 'x-deva-csrf': csrf } : {}) }) },
        body: body === undefined ? undefined : JSON.stringify(body) })
      check(res.status === expected && res.headers.get('content-type') === 'application/json; charset=utf-8')
      return { payload: await res.json(), cookie: res.headers.get('set-cookie')?.split(';', 1)[0] }
    }

    stage = 'ready-and-isolation'
    let ready = false
    const readyBy = performance.now() + 12_000
    while (!ready && performance.now() < readyBy) {
      try { const r = await http('/readyz', { signal: AbortSignal.timeout(750) }); ready = r.status === 200 && (await r.json()).status === 'ready' }
      catch { /* The default CLI may still be opening the volumes and compiled bundle. */ }
      if (!ready) await delay(125)
    }
    check(ready && process.platform === 'linux' && process.arch === 'x64' && process.getuid() === 1000)
    check((await readFile('/proc/1/cmdline', 'utf8')) === 'node\0/opt/deva/apps/headless/src/cli.mjs\0serve\0')
    const status = await readFile('/proc/1/status', 'utf8')
    check(/^Uid:\s+1000\s+1000\s+1000\s+1000$/m.test(status) && /^NoNewPrivs:\s+1$/m.test(status) &&
      ['Eff', 'Prm', 'Bnd', 'Amb'].every(key => new RegExp(`^Cap${key}:\\s+0+$`, 'm').test(status)))
    const mounts = (await readFile('/proc/1/mountinfo', 'utf8')).split('\n').map(line => line.split(' '))
    check([['/', 'ro'], ['/data', 'rw'], ['/keys', 'ro']].every(([mount, mode]) =>
      mounts.some(v => v[4] === mount && v[5].split(',').includes(mode))) && same(await readdir('/sys/class/net'), ['lo']))
    const key = await lstat('/keys/master.key')
    check(key.isFile() && key.uid === 1000 && key.size === 32 && (key.mode & 0o777) === 0o600)

    let initialConfig
    if (first) {
      stage = 'native-fixture'
      initialConfig = JSON.parse(await privateFile(config))
      check(!Object.hasOwn(initialConfig, 'skills') && !Object.hasOwn(initialConfig, 'nativeQaMarker'))
      initialConfig.skills = { enabled: { [id]: false }, roles: {} }
      await mkdir('/data/skills', { mode: 0o700 })
      await mkdir('/data/skills/proofreading', { mode: 0o700 })
      await writeFile(document, fixture, { mode: 0o600, flag: 'wx' })
      await writeFile(config, JSON.stringify(initialConfig).slice(0, -1) + ',' + numeric + '}\n')
      initialConfig.nativeQaMarker = -12300
    }

    stage = 'http-owner-session'
    const password = first ? randomBytes(24).toString('base64url') : input.password
    check(typeof password === 'string' && /^[A-Za-z0-9_-]{32}$/u.test(password))
    const state = await api('auth/state')
    check(state.payload.claimed === !first)
    if (!first) check(/^deva-workbench-local=[A-Za-z0-9_-]{43}$/u.test(input.cookie))
    const stale = await api('skills', { session: first ? undefined : input.cookie, expected: 401 })
    check(stale.payload.error === 'auth')
    const auth = first
      ? await api('auth/claim', { method: 'POST', body: { password, credential: (await requestControl({ runDir: '/run/deva', op: 'claim' })).credential } })
      : await api('auth/login', { method: 'POST', body: { password } })
    cookie = auth.cookie; csrf = auth.payload.csrf
    check(/^deva-workbench-local=[A-Za-z0-9_-]{43}$/u.test(cookie) && cookie !== input.cookie && typeof csrf === 'string' && csrf.length > 0)

    stage = 'catalog-role-and-detail'
    const noInstructions = payload => {
      const wire = JSON.stringify(payload)
      check(!wire.includes(instructions) && !wire.includes('"instructions"') && !wire.includes('/data/') && !wire.includes('nativeQaMarker'))
    }
    const boot = (await api('bootstrap')).payload
    check(boot.capabilities.skillLibrary === true && boot.capabilities.terminalViewer === false &&
      boot.capabilities.browserPanel === false && boot.capabilities.workspaceFiles === false && !Object.hasOwn(boot, 'skills'))
    noInstructions(boot)
    const roster = (await api('skills/-/roles')).payload
    check(same(roster, { roles: [{ id: 'general', name: 'General', enabled: true }] }))
    const role = (await api('personas/general')).payload.role
    check(role.id === 'general' && role.name === 'General' && role.enabled === true && role.protected === true &&
      role.workspaceId === '' && !Object.hasOwn(role, 'skills') && !Object.hasOwn(role, 'allowedTools') && !JSON.stringify(role).includes(id))
    const list = async () => {
      const body = (await api('skills')).payload
      check(body.execution === 'inactive' && revision(body.revision) && body.skills.every(v => revision(v.revision)))
      check(body.skills.filter(v => v.source === 'custom').length === 1 && body.skills.some(v => v.source === 'builtin' && !v.canConfigure))
      noInstructions(body)
      return body
    }
    const selected = async (catalog, enabled, roles) => {
      const row = catalog.skills.find(v => v.id === id)
      check(row?.name === id && row.description === description && row.source === 'custom' && row.canConfigure === true &&
        row.enabled === enabled && same(row.roles, roles))
      const detail = (await api('skills/' + id)).payload
      check(detail.execution === 'inactive' && detail.skill.detail === 'document' && detail.skill.instructions === instructions &&
        same(detail.skill.allowedTools, []) && !JSON.stringify(detail).includes('/data/') &&
        Object.entries(row).every(([key, value]) => same(detail.skill[key], value)))
      return detail
    }
    const initial = await list()
    const detail = await selected(initial, !first, first ? null : ['general'])

    let writeRevision
    if (first) {
      stage = 'confirmed-preference-patches'
      const patch = async (before, edit, scope) => {
        const result = (await api('skills/' + id + '/preferences', { method: 'PATCH', body: { revision: before.revision, ...edit } })).payload
        check(result.execution === 'inactive' && result.skill.enabled === true && same(result.skill.roles, scope) &&
          revision(result.skill.revision) && result.skill.revision !== before.revision)
        noInstructions(result)
        return result.skill
      }
      const enabled = await patch(detail.skill, { enabled: true }, null)
      writeRevision = (await patch(enabled, { roles: ['general'] }, ['general'])).revision
      initialConfig.skills = { enabled: { [id]: true }, roles: { [id]: ['general'] } }
    }

    stage = 'native-bytes-and-fresh-revision'
    const catalog = await list()
    const confirmed = await selected(catalog, true, ['general'])
    if (first) check(catalog.revision !== initial.revision && confirmed.skill.revision === writeRevision)
    const bytes = await privateFile(config), persisted = JSON.parse(bytes)
    check(bytes.includes(numeric) && same(persisted.skills, { enabled: { [id]: true }, roles: { [id]: ['general'] } }) &&
      (!first || same(persisted, initialConfig)))
    const source = digest(await privateFile(document)), nativeRole = digest(await privateFile(persona))
    check(source === digest(fixture) && same(await readdir('/data/skills'), [id]) && same(await readdir('/data/skills/proofreading'), ['SKILL.md']))
    const stable = row => { const { revision: _, ...rest } = row; return rest }
    const evidence = { config: digest(bytes), source, nativeRole, skills: catalog.skills.map(stable), detail: stable(confirmed.skill), roster }
    if (!first) {
      check(same(evidence, input.evidence))
      const cursor = (await api('skills/-/changes', { method: 'POST', body: { after: catalog.revision, waitMs: 0 } })).payload
      check(cursor.changed === false && cursor.revision === catalog.revision)
    }

    if (first) {
      stage = 'packaged-web-entry-assets'
      async function asset(path, type) {
        const res = await http('/' + path)
        check(res.status === 200 && res.headers.get('content-type') === `${type}; charset=utf-8` && res.headers.get('x-content-type-options') === 'nosniff')
        const served = Buffer.from(await res.arrayBuffer())
        check(served.length > 0 && served.equals(await readFile(web + '/' + (path || 'index.html'))))
        return { text: served.toString(), csp: res.headers.get('content-security-policy') }
      }
      const page = await asset('', 'text/html')
      const policy = page.csp?.split('; ')
      check(/<div\s+id="root"/.test(page.text) && ["default-src 'none'", "script-src 'self'", "connect-src 'self'", "frame-ancestors 'none'"].every(v => policy?.includes(v)))
      const manifest = JSON.parse(await readFile(web + '/manifest.json', 'utf8'))
      const scripts = [...page.text.matchAll(/<script\b[^>]*\bsrc="\.\/(assets\/[\w-]+-[\w-]{6,}\.js)"[^>]*><\/script>/gu)].map(m => m[1])
      check(scripts.length > 0 && scripts.length <= 6 && scripts.length === (page.text.match(/<script\b/gu) ?? []).length &&
        scripts.every(file => Object.values(manifest).some(row => row.file === file)) && scripts.some(file => /^assets\/index-/u.test(file)))
      for (const file of scripts) await asset(file, 'text/javascript')
      const skill = manifest['skill-library.tsx']
      check(manifest['desktop-settings.tsx']?.dynamicImports?.includes('skill-library.tsx') && skill?.isDynamicEntry === true &&
        /^assets\/[\w-]+-[\w-]{6,}\.js$/u.test(skill.file) && skill.css?.length > 0 && skill.css.length <= 6)
      await asset(skill.file, 'text/javascript')
      let css = ''
      for (const file of skill.css) {
        check(/^assets\/[\w-]+-[\w-]{6,}\.css$/u.test(file))
        css += (await asset(file, 'text/css')).text
      }
      check(css.includes('.wb-skill'))
    }
    stage = 'idle-runtime'
    check((await readFile('/proc/1/task/1/children', 'utf8')).trim() === '')
    // The parent consumes this only from a private pipe and passes it to the second probe via stdin.
    process.stdout.write(JSON.stringify(first ? { password, cookie, evidence } : { verified: true }))
  } catch {
    process.stderr.write(`skill-library probe: ${stage}\n`)
    process.exitCode = 1
  }
}

export const probeProgram = `await (${probe.toString()})();`
