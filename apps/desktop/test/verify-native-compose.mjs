// Run from a clean Git checkout. Only a successful real run prints an acceptance receipt on stdout.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { commandEnv, localDockerEndpoint, prepareSource, requireNativeHost } from './compose-acceptance-host.mjs'
import { checkUnused, publishedLogin, teardown } from './compose-acceptance-lifecycle.mjs'
import { checkContinuity, checkEngine, checkPlan, checkSourceCreationControl, checkStage, sourceCreationControl } from './compose-acceptance-evidence.mjs'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const approved = '17abef945c4669dcd7d6162cd1dd65084490d4249b1b6c6b9b8bf477ba0879f5'
const sidPattern = /^web_[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/u
const chatProbe = 'headless-compose-probe.mjs', docsProbe = 'headless-compose-docs-probe.mjs'
const sequence = [['base', 'responses'], ['granted', 'anthropic'], ['revoked', 'openai']]
const interrupted = new AbortController()
const stop = () => interrupted.abort()
let phase = 'arguments', cleanupProblem, failedProject
const need = (condition, reason) => { if (!condition) throw Error(reason) }
const reason = e => /^[a-z][a-z0-9_.-]{1,70}$/u.test(e?.message ?? '') ? e.message : 'verification_failed'

// Do not forward command output/errors: even a private Docker config or a failed inspect can include credentials.
function dockerClient(endpoint, baseEnv) {
  return (args, { env = {}, cwd, input, quiet = false, cleanup = false, timeout = 30_000 } = {}) => new Promise((resolve, reject) => {
    if (!cleanup && interrupted.signal.aborted) return reject(Error('interrupted'))
    const child = spawn('docker', ['--host', endpoint, ...args], { cwd, detached: true,
      env: { ...baseEnv, DOCKER_HOST: endpoint, ...env }, stdio: ['pipe', quiet ? 'ignore' : 'pipe', 'pipe'] })
    const chunks = []; let size = 0, problem, hint, finished = false
    child.stderr.on('data', chunk => {
      const message = chunk.toString('utf8')
      if (/permission denied while trying to connect|connect: permission denied/iu.test(message)) hint = 'engine_permission_denied'
      else if (/cannot connect to the docker daemon|error during connect/iu.test(message)) hint ??= 'engine_connection_failed'
      else if (/port is already allocated|address already in use/iu.test(message)) hint ??= 'port_unavailable'
      else if (/container .*unhealthy/iu.test(message)) hint ??= 'container_unhealthy'
    })
    function cancel(why) {
      problem ??= why
      if (child.pid && !finished) { try { process.kill(-child.pid, 'SIGKILL') } catch (e) { if (e.code !== 'ESRCH') problem = 'docker_client_stop_failed' } }
    }
    // Compose/Buildx are child CLI plugins. Stop our entire private client group before cleanup starts.
    const abort = () => cancel('interrupted'), timer = setTimeout(() => cancel('docker_command_timeout'), timeout).unref()
    if (!cleanup) { interrupted.signal.addEventListener('abort', abort, { once: true }); if (interrupted.signal.aborted) abort() }
    child.on('error', error => { problem ??= error.code === 'ENOENT' ? 'docker_cli_missing' : 'docker_command_failed' })
    child.stdin.on('error', () => { if (input) problem ??= 'probe_input_failed' }); child.stdin.end(input)
    child.stdout?.on('data', chunk => {
      size += chunk.length
      if (size <= 4 * 1024 * 1024) chunks.push(chunk)
      else cancel('docker_output_limit')
    })
    child.once('close', code => {
      finished = true; clearTimeout(timer); interrupted.signal.removeEventListener('abort', abort)
      if (problem || code !== 0) reject(Object.assign(Error(problem ?? hint ?? 'docker_command_failed'), { dockerExit: code }))
      else resolve(Buffer.concat(chunks).toString('utf8').trim())
    })
  })
}

async function freePort() {
  const socket = createServer()
  await new Promise((yes, no) => { socket.once('error', no); socket.listen(0, '127.0.0.1', yes) })
  const { port } = socket.address(); await new Promise((yes, no) => socket.close(e => e ? no(e) : yes()))
  return port === 18795 ? freePort() : port // The provider uses this port *inside* the container.
}

async function acceptance(docker, source, project) {
  const port = await freePort(), token = randomBytes(32).toString('hex'), origin = `http://127.0.0.1:${port}`
  const env = { DEVA_WEB_TOKEN: token, DEVA_MODEL_API_KEY: '', DEVA_BIND: '127.0.0.1', DEVA_PORT: String(port), DEVA_ORIGIN: origin,
    DEVA_MODEL: 'deva-compose-fixture', DEVA_MODEL_BASE_URL: 'http://127.0.0.1:18795/v1', DEVA_MODEL_PROTOCOL: 'responses' }
  const compose = (grant, args, opt = {}) => docker(['compose', '--env-file', '/dev/null', '--project-directory', source.work, '-p', project,
    '-f', join(source.work, 'compose.yaml'), ...(grant ? ['-f', opt.input ? '-' : join(source.work, 'compose.project-docs.yaml')] : []), ...args],
  { ...opt, cwd: source.work, env: { ...env, ...(grant && { DEVA_PROJECT_DOCS_FILE: source.snapshotFile, DEVA_PROJECT_DOCS_SHA256: approved }) } })
  const probe = (file, id, vars) => docker(['exec', '-i', ...Object.entries(vars).flatMap(([k, v]) => ['-e', `${k}=${v}`]), id,
    'node', '--input-type=module'], { input: readFileSync(join(source.work, 'apps/desktop/test', file)), timeout: 45_000 })
  const protocolFor = protocol => { if (protocol === 'openai') delete env.DEVA_MODEL_PROTOCOL; else env.DEVA_MODEL_PROTOCOL = protocol }
  const stages = []; let id, sid, oldDoc, cookie, volumeCreated, mutation = false, originalFailure
  try {
    phase = 'rendered_plan'
    for (const [label, protocol] of sequence) {
      const grant = label === 'granted'; protocolFor(protocol)
      const rendered = JSON.parse(await compose(grant, ['config', '--format', 'json']))
      checkPlan(rendered, { project, port, work: source.work, snapshotFile: source.snapshotFile, granted: grant })
      if (grant) {
        const input = sourceCreationControl(readFileSync(join(source.work, 'compose.project-docs.yaml'), 'utf8'))
        const control = JSON.parse(await compose(true, ['config', '--format', 'json'], { input })) // Render only; never start this variant.
        checkSourceCreationControl(rendered, control)
      }
      const { DEVA_BIND: _publishOnly, ...settings } = env
      const expected = { ...settings, DEVA_HOST: '0.0.0.0', DEVA_MODEL_PROTOCOL: protocol, ...(grant && { DEVA_PROJECT_DOCS_SHA256: approved }) }
      const actual = rendered.services.deva.environment
      need(Object.keys(actual).length === Object.keys(expected).length && Object.entries(expected).every(([k, v]) => actual[k] === v), 'unexpected_service_environment')
      need([`${project}-deva`, `${project}-deva:latest`].includes(await compose(grant, ['config', '--images'])), 'unexpected_image_tag')
    }
    phase = 'isolation'; await checkUnused(docker, project)
    for (const [i, [label, protocol]] of sequence.entries()) {
      const grant = label === 'granted'; phase = `${label}_start`; protocolFor(protocol)
      console.error(`deva-compose: ${phase}`); mutation = true
      await compose(grant, ['up', i ? '--no-build' : '--build', ...(i ? ['--force-recreate'] : []), '-d', '--wait', '--wait-timeout', '100'],
        { quiet: true, timeout: i ? 150_000 : 600_000 })
      phase = `${label}_identity`
      id = await compose(grant, ['ps', '-q', 'deva']); need(/^[a-f0-9]{12,64}$/u.test(id), 'missing_test_container')
      const [container] = JSON.parse(await docker(['container', 'inspect', id]))
      need(container?.Config?.Labels?.['com.docker.compose.project'] === project && container.Config.Labels['com.docker.compose.project.working_dir'] === source.work, 'unexpected_container')
      const [Os, Architecture, Id] = (await docker(['image', 'inspect', '--format', '{{.Os}} {{.Architecture}} {{.Id}}', container.Image])).split(' ')
      const node = JSON.parse(await docker(['exec', id, 'node', '-p', 'JSON.stringify({os:process.platform,arch:process.arch,uid:process.getuid(),version:process.version})']))
      const stage = checkStage({ container, image: { Os, Architecture, Id }, node, project, port, snapshotFile: source.snapshotFile, granted: grant })
      const [vol] = JSON.parse(await docker(['volume', 'inspect', stage.volumeName]))
      need(vol.Driver === 'local' && !Object.keys(vol.Options ?? {}).length && vol.Labels?.['com.docker.compose.project'] === project &&
        vol.Labels?.['com.docker.compose.volume'] === 'deva-data' && !!vol.CreatedAt && (!volumeCreated || vol.CreatedAt === volumeCreated), 'volume_identity_failed')
      volumeCreated = vol.CreatedAt; stages.push(stage)
      phase = `${label}_published_http`; cookie = await publishedLogin(origin, token, cookie, grant, interrupted.signal)
      phase = `${label}_workflow`
      if (grant) {
        oldDoc = await probe(docsProbe, id, { DEVA_SMOKE_SESSION: sid })
        need(/^[a-f0-9]{32}\/[a-f0-9]{32}$/u.test(oldDoc), 'published_document_probe_failed')
      } else if (i === 2) {
        need(await probe(docsProbe, id, { DEVA_SMOKE_SESSION: sid, DEVA_REVOKED_DOC: oldDoc }) === '', 'revocation_probe_failed')
      }
      const result = await probe(chatProbe, id, { DEVA_SMOKE_EXPECT_PROTOCOL: protocol, ...(sid && { DEVA_SMOKE_SESSION: sid }),
        ...(i === 2 && { DEVA_SMOKE_AFTER_REVOKE: '1' }) })
      need(sidPattern.test(result) && (!sid || result === sid), 'conversation_probe_failed'); sid = result
      if (grant) {
        await compose(true, ['stop', '--timeout', '15', 'deva'], { quiet: true })
        need(await docker(['container', 'inspect', '--format', '{{.State.Running}}', id]) === 'false', 'old_reader_still_running')
      }
    }
    checkContinuity(stages)
    return { image: stages[0].imageId, node: stages[0].nodeVersion, containers: stages.map(s => s.containerId),
      checks: ['published_loopback_health_and_login', 'complete_response', 'stop_closed_provider_socket', 'partial_preserved_across_recreation',
        'anthropic_continuation_with_attachment', 'read_only_snapshot', 'old_login_and_document_revoked', 'default_openai_turn_after_revocation', 'same_named_volume'] }
  } catch (error) { originalFailure = error; throw error } finally {
    if (mutation) {
      try { await teardown(docker, compose, project, source.work, stages[0]?.imageId) }
      catch (error) {
        cleanupProblem = reason(error); failedProject = project
        if (!originalFailure) { phase = 'cleanup'; throw Error('cleanup_unconfirmed') }
      }
    }
  }
}

async function main(args) {
  if (args.length === 1 && ['-h', '--help'].includes(args[0])) {
    console.log('Usage: node apps/desktop/test/verify-native-compose.mjs [--preflight]\nRequires native Linux x86-64, Node 22+, Git, Docker Engine and Compose.\n--preflight checks the local environment only. A full run builds, recreates and removes a private synthetic project, printing JSON only after cleanup.'); return
  }
  need(!args.length || (args.length === 1 && args[0] === '--preflight'), 'invalid_arguments')
  phase = 'native_host'; requireNativeHost(); need(Number(process.versions.node.split('.')[0]) >= 22, 'node_22_required')
  phase = 'local_engine'; const docker = dockerClient(localDockerEndpoint(), { ...commandEnv(), BUILDX_BUILDER: 'default' })
  const [OSType, Architecture, ServerVersion] = (await docker(['info', '--format', '{{.OSType}} {{.Architecture}} {{.ServerVersion}}'])).split(' ')
  const engine = checkEngine({ OSType, Architecture, ServerVersion }), compose = await docker(['compose', 'version', '--short'])
  need(/^v?[2-9]\d*\.\d+\.\d+(?:[-+][\w.-]+)?$/u.test(compose), 'invalid_compose_version')
  if (args.length) { console.log(JSON.stringify({ kind: 'preflight', platform: 'linux/amd64', engine, compose, containersRun: false })); return }
  phase = 'source'; const project = `deva-accept-${randomBytes(12).toString('hex')}`, source = prepareSource(root)
  let result, originalFailure
  try { result = await acceptance(docker, source, project) }
  catch (error) { originalFailure = error; throw error } finally {
    try { source.dispose() } catch {
      cleanupProblem ??= 'staging_cleanup_failed'
      if (!originalFailure) { phase = 'cleanup'; throw Error('cleanup_unconfirmed') }
    }
  }
  phase = 'finished'; need(!interrupted.signal.aborted, 'interrupted')
  console.log(JSON.stringify({ kind: 'deva-native-compose-v1', status: 'passed', commit: source.sha, platform: 'linux/amd64', engine, compose,
    ...result, cleanup: 'verified', completedAt: new Date().toISOString() }))
}
process.once('SIGINT', stop); process.once('SIGTERM', stop)
try { await main(process.argv.slice(2)) }
catch (error) {
  console.error(JSON.stringify({ status: 'failed', phase, reason: reason(error), ...(Number.isInteger(error?.dockerExit) && { dockerExit: error.dockerExit }),
    ...(cleanupProblem && { cleanup: cleanupProblem, project: failedProject }) }))
  process.exitCode = phase === 'arguments' ? 2 : 1
} finally { process.off('SIGINT', stop); process.off('SIGTERM', stop) }
