import assert from 'node:assert/strict'
import test from 'node:test'
import { checkContinuity, checkEngine, checkPlan, checkSourceCreationControl, checkStage, sourceCreationControl } from './compose-acceptance-evidence.mjs'

const project = `deva-accept-${'a'.repeat(24)}`, port = 18787, tcp = `${port}/tcp`
const volumeName = `${project}_deva-data`, imageId = `sha256:${'d'.repeat(64)}`
const snapshotFile = '/private-fixture/synthetic-snapshot.json', nodeVersion = 'v22.21.1'
const engine = { OSType: 'linux', Architecture: 'x86_64', ServerVersion: '27.5.1' }
const work = '/private-fixture/checkout', networkName = `${project}_default`

function planFixture(granted = false) {
  const environment = { DEVA_HOST: '0.0.0.0', DEVA_PORT: String(port), DEVA_ORIGIN: `http://127.0.0.1:${port}`,
    DEVA_WEB_TOKEN: 'synthetic', DEVA_MODEL_PROTOCOL: 'openai', DEVA_MODEL_BASE_URL: 'http://192.0.2.1:1234/v1',
    DEVA_MODEL: 'fixture', DEVA_MODEL_API_KEY: '' }
  const volumes = [{ type: 'volume', source: 'deva-data', target: '/data', volume: {} }]
  if (granted) {
    environment.DEVA_PROJECT_DOCS_SHA256 = 'b'.repeat(64)
    volumes.push({ type: 'bind', source: snapshotFile, target: '/run/deva-project-docs/snapshot.json', read_only: true,
      bind: { propagation: 'rprivate', create_host_path: false } })
  }
  return { name: project, networks: { default: { name: networkName, ipam: {} } },
    volumes: { 'deva-data': { name: volumeName } }, services: { deva: {
      build: { context: work, dockerfile: 'Dockerfile' }, command: null, entrypoint: null, environment,
      networks: { default: null }, ports: [{ host_ip: '127.0.0.1', target: port, published: String(port),
        mode: 'ingress', protocol: 'tcp' }], volumes, read_only: true, restart: 'unless-stopped',
      cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'] } } }
}
function fixture(id = 'a', granted = false) {
  const bindings = () => ({ [tcp]: [{ HostIp: '127.0.0.1', HostPort: String(port) }] })
  const container = { Id: id.repeat(64), Image: imageId, Platform: 'linux',
    State: { Status: 'running', Running: true, Health: { Status: 'healthy', FailingStreak: 0,
      Log: [{ ExitCode: 0, Output: 'synthetic private probe output' }] } },
    Config: { Labels: { 'com.docker.compose.project': project, 'com.docker.compose.service': 'deva' },
      Env: ['DEVA_WEB_TOKEN=synthetic-private-credential'] },
    HostConfig: { ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'], CapAdd: null,
      SecurityOpt: ['no-new-privileges:true'], Devices: [], DeviceRequests: null, NetworkMode: networkName,
      PortBindings: bindings(), PublishAllPorts: false },
    NetworkSettings: { Ports: { ...bindings(), '8787/tcp': null, '9797/tcp': [] }, Networks: { [networkName]: {} } },
    Mounts: [{ Type: 'volume', Name: volumeName, Driver: 'local', Destination: '/data', RW: true }] }
  if (granted) container.Mounts.push({ Type: 'bind', Destination: '/run/deva-project-docs/snapshot.json',
    Source: snapshotFile, RW: false, Propagation: 'rprivate' })
  return { container, image: { Id: imageId, Os: 'linux', Architecture: 'amd64' },
    node: { os: 'linux', arch: 'x64', uid: 1000, version: nodeVersion }, project, port, snapshotFile, granted }
}

const fails = (fn, message) => assert.throws(fn, { name: 'Error', message })

test('preflight accepts the current Compose plan shapes, including harmless omissions', () => {
  for (const granted of [false, true]) {
    const plan = planFixture(granted), options = { project, port, work, snapshotFile, granted }
    assert.equal(checkPlan(plan, options), undefined)
    delete plan.services.deva.command
    delete plan.services.deva.build.dockerfile
    delete plan.networks.default.ipam
    assert.equal(checkPlan(plan, options), undefined)
  }
})

for (const [name, reason, mutate, granted = false] of [
  ['extra service', 'services', plan => { plan.services.other = plan.services.deva }],
  ['external service image', 'services', (_, service) => { service.image = 'other:stable' }],
  ['host IPC', 'services', (_, service) => { service.ipc = 'host' }],
  ['alternate command', 'runtime', (_, service) => { service.command = ['node', '-e', '0'] }],
  ['alternate build context', 'build', (_, service) => { service.build.context = '/private-fixture/other' }],
  ['build secrets', 'build', (_, service) => { service.build.secrets = ['synthetic'] }],
  ['external network', 'network', plan => { plan.networks.default.external = true }],
  ['driver-bound data volume', 'volume', plan => { plan.volumes['deva-data'].driver_opts = { type: 'none', o: 'bind' } }],
  ['wildcard port', 'ports', (_, service) => { service.ports[0].host_ip = '0.0.0.0' }],
  ['host mount', 'mounts', (_, service) => { service.volumes.push({ type: 'bind', source: '/private-fixture/other' }) }],
  ['auto-created snapshot source', 'snapshot', (_, service) => { service.volumes[1].bind.create_host_path = true }, true],
]) test(`preflight rejects ${name} with a constant code`, () => {
  const plan = planFixture(granted)
  mutate(plan, plan.services.deva)
  fails(() => checkPlan(plan, { project, port, work, snapshotFile, granted }), `plan.${reason}`)
})

test('bind auto-creation needs an explicit false source and a meaningful config-only contrast', () => {
  assert.equal(sourceCreationControl('bind:\n  create_host_path: false\n'), 'bind:\n  create_host_path: true\n')
  for (const ambiguous of ['# create_host_path: false', 'create_host_path: true', 'create_host_path: false\ncreate_host_path: false']) {
    fails(() => sourceCreationControl(ambiguous), 'plan.source-control')
  }
  const pair = (value, source = snapshotFile) => ({ services: { deva: { volumes: [{ type: 'bind', source,
    target: '/run/deva-project-docs/snapshot.json', bind: { propagation: 'rprivate', ...(value === undefined ? {} : { create_host_path: value }) } }] } } })
  for (const [a, b] of [[false, true], [undefined, true], [false, undefined]]) checkSourceCreationControl(pair(a), pair(b))
  for (const [a, b] of [[undefined, undefined], [true, undefined], [false, false]]) fails(() => checkSourceCreationControl(pair(a), pair(b)), 'plan.source-control')
  fails(() => checkSourceCreationControl(pair(false), pair(true, '/changed/leaf')), 'plan.source-control')
})

test('engine evidence yields a bounded Linux x86-64 server version', () => {
  assert.equal(checkEngine(engine), '27.5.1')
  assert.equal(checkEngine({ ...engine, Architecture: 'amd64', ServerVersion: '26.1.3+dfsg1' }), '26.1.3+dfsg1')
  fails(() => checkEngine({ ...engine, OSType: 'windows' }), 'engine.os')
  fails(() => checkEngine({ ...engine, Architecture: 'arm64' }), 'engine.architecture')
  for (const version of ['27.5.1\n', '27.5.1 private=/path', `27.5.1+${'a'.repeat(64)}`]) {
    fails(() => checkEngine({ ...engine, ServerVersion: version }), 'engine.version')
  }
})

test('default, enabled and revoked fixtures produce only qualified receipt fields', () => {
  const stages = [fixture(), fixture('b', true), fixture('c')].map(checkStage)
  assert.deepEqual(stages[1], { containerId: 'b'.repeat(64), imageId, volumeName, nodeVersion })
  assert.equal(checkContinuity(stages), undefined)
})

for (const [name, reason, mutate, granted = false] of [
  ['short ID', 'container-id', e => { e.container.Id = 'deadbeef' }],
  ['swapped inspected image', 'image', e => { e.image.Id = `sha256:${'e'.repeat(64)}` }],
  ['foreign image architecture', 'platform', e => { e.image.Architecture = 'arm64' }],
  ['foreign Node architecture', 'node', e => { e.node.arch = 'arm64' }],
  ['root Node process', 'node', e => { e.node.uid = 0 }],
  ['wrong Node release', 'node', e => { e.node.version = 'v24.1.0' }],
  ['fake health status', 'health', e => { e.container.State.Health = { Status: 'healthy' } }],
  ['writable root', 'hardening', e => { e.container.HostConfig.ReadonlyRootfs = false }],
  ['extra capability', 'hardening', e => { e.container.HostConfig.CapAdd = ['SYS_ADMIN'] }],
  ['missing no-new-privileges', 'hardening', e => { e.container.HostConfig.SecurityOpt = [] }],
  ['extra device', 'devices', e => { e.container.HostConfig.Devices = [{ PathOnHost: '/private/device' }] }],
  ['host network', 'network', e => { e.container.HostConfig.NetworkMode = 'host' }],
  ['extra attached network', 'network', e => { e.container.NetworkSettings.Networks.other = {} }],
  ['wildcard port', 'ports', e => { e.container.NetworkSettings.Ports[tcp][0].HostIp = '0.0.0.0' }],
  ['second published port', 'ports', e => { e.container.NetworkSettings.Ports['8787/tcp'] = e.container.NetworkSettings.Ports[tcp] }],
  ['extra mount in a disabled stage', 'mounts', e => { e.container.Mounts.push({ Type: 'bind' }) }],
  ['swapped volume', 'volume', e => { e.container.Mounts[0].Name = 'other-volume' }],
  ['writable snapshot', 'snapshot', e => { e.container.Mounts[1].RW = true }, true],
  ['shared snapshot', 'snapshot', e => { e.container.Mounts[1].Propagation = 'rshared' }, true],
  ['different snapshot', 'snapshot', e => { e.container.Mounts[1].Source = '/private-fixture/withheld.json' }, true],
]) test(`stage rejects ${name} with a constant code`, () => {
  const evidence = fixture('a', granted)
  mutate(evidence)
  fails(() => checkStage(evidence), `stage.${reason}`)
})

test('continuity rejects missing, duplicate or changed stage evidence', () => {
  const [a, b, c] = [fixture(), fixture('b', true), fixture('c')].map(checkStage)
  fails(() => checkContinuity([a, b]), 'continuity.stages')
  fails(() => checkContinuity([a, b, a]), 'continuity.containers')
  fails(() => checkContinuity([a, b, { ...c, imageId: `sha256:${'e'.repeat(64)}` }]), 'continuity.image')
  fails(() => checkContinuity([a, b, { ...c, volumeName: `deva-accept-${'e'.repeat(24)}_deva-data` }]), 'continuity.volume')
  fails(() => checkContinuity([a, b, { ...c, nodeVersion: 'v22.21.2' }]), 'continuity.node')
})
