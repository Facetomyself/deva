import { posix } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

const containerIdPattern = /^[a-f0-9]{64}$/
const imageIdPattern = /^sha256:[a-f0-9]{64}$/
const projectPattern = /^deva-accept-[a-f0-9]{24}$/
const volumePattern = /^deva-accept-[a-f0-9]{24}_deva-data$/
const nodePattern = /^v22\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})$/
const enginePattern = /^\d{1,3}\.\d{1,3}\.\d{1,4}(?:[-+][a-zA-Z0-9]+(?:[.+~-][a-zA-Z0-9]+)*)?$/
const snapshotTarget = '/run/deva-project-docs/snapshot.json'
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value)
const x86 = value => value === 'amd64' || value === 'x86_64'
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const emptyList = value => value == null || (Array.isArray(value) && value.length === 0)
const emptyMap = value => value == null || (record(value) && Object.keys(value).length === 0)
const onlyKeys = (value, allowed) => record(value) && Object.keys(value).every(key => allowed.includes(key))
const unsetOr = (value, expected) => value === undefined || value === expected
const exactListValue = (value, expected) => Array.isArray(value) && value.length === 1 && expected.includes(value[0])
const noNewPrivileges = ['no-new-privileges:true', 'no-new-privileges=true']
const validPort = value => Number.isInteger(value) && value > 0 && value <= 65535
const absolute = value => typeof value === 'string' && posix.isAbsolute(value) && posix.normalize(value) === value &&
  !value.endsWith('/') && !/[\x00-\x1f\x7f]/.test(value)
const privateSource = value => absolute(value) && posix.dirname(value) !== '/'

function requireEvidence(condition, reason) {
  if (!condition) throw new Error(reason)
}

export function checkEngine(info) {
  const { OSType, Architecture, ServerVersion } = info ?? {}
  requireEvidence(OSType === 'linux', 'engine.os')
  requireEvidence(x86(Architecture), 'engine.architecture')
  requireEvidence(matches(enginePattern, ServerVersion) && ServerVersion.length <= 64, 'engine.version')
  return ServerVersion
}

const planServiceKeys = ['build', 'cap_drop', 'command', 'entrypoint', 'environment', 'networks', 'ports',
  'read_only', 'restart', 'security_opt', 'volumes', 'privileged']
const planEnvironmentKeys = ['DEVA_HOST', 'DEVA_PORT', 'DEVA_ORIGIN', 'DEVA_WEB_TOKEN', 'DEVA_MODEL_PROTOCOL',
  'DEVA_MODEL_BASE_URL', 'DEVA_MODEL', 'DEVA_MODEL_API_KEY']

export function checkPlan(plan, options) {
  const { project, port, work, snapshotFile, granted } = options ?? {}
  requireEvidence(matches(projectPattern, project) && validPort(port) && absolute(work) &&
    typeof granted === 'boolean' && (!granted || privateSource(snapshotFile)), 'plan.inputs')
  requireEvidence(onlyKeys(plan, ['name', 'services', 'networks', 'volumes']) && plan.name === project &&
    onlyKeys(plan.services, ['deva']) && onlyKeys(plan.services.deva, planServiceKeys), 'plan.services')
  const service = plan.services.deva
  const { build, environment: env } = service
  requireEvidence(onlyKeys(build, ['context', 'dockerfile']) && build.context === work &&
    (unsetOr(build.dockerfile, 'Dockerfile') || build.dockerfile === posix.join(work, 'Dockerfile')), 'plan.build')
  const envKeys = granted ? [...planEnvironmentKeys, 'DEVA_PROJECT_DOCS_SHA256'] : planEnvironmentKeys
  requireEvidence(onlyKeys(env, envKeys) && envKeys.every(key => typeof env[key] === 'string') &&
    (!granted || matches(containerIdPattern, env.DEVA_PROJECT_DOCS_SHA256)), 'plan.environment')
  requireEvidence(service.read_only === true && unsetOr(service.privileged, false) && service.restart === 'unless-stopped' &&
    exactListValue(service.cap_drop, ['ALL']) && exactListValue(service.security_opt, noNewPrivileges) &&
    service.command == null && service.entrypoint == null, 'plan.runtime')

  const network = plan.networks?.default, attached = service.networks
  requireEvidence(onlyKeys(plan.networks, ['default']) && onlyKeys(network, ['name', 'driver', 'external', 'ipam']) &&
    network.name === `${project}_default` && unsetOr(network.driver, 'bridge') && unsetOr(network.external, false) &&
    emptyMap(network.ipam) && (attached === undefined || (onlyKeys(attached, ['default']) &&
      Object.hasOwn(attached, 'default') && emptyMap(attached.default))), 'plan.network')
  const volume = plan.volumes?.['deva-data']
  requireEvidence(onlyKeys(plan.volumes, ['deva-data']) && onlyKeys(volume, ['name', 'driver', 'external', 'driver_opts']) &&
    volume.name === `${project}_deva-data` && unsetOr(volume.driver, 'local') && unsetOr(volume.external, false) &&
    emptyMap(volume.driver_opts), 'plan.volume')

  const publication = service.ports?.[0]
  requireEvidence(Array.isArray(service.ports) && service.ports.length === 1 &&
    onlyKeys(publication, ['host_ip', 'target', 'published', 'protocol', 'mode']) && publication.host_ip === '127.0.0.1' &&
    publication.target === port && [String(port), port].includes(publication.published) &&
    unsetOr(publication.protocol, 'tcp') && unsetOr(publication.mode, 'ingress'), 'plan.ports')
  const mounts = service.volumes
  requireEvidence(Array.isArray(mounts) && mounts.length === (granted ? 2 : 1), 'plan.mounts')
  const data = mounts.find(mount => mount?.target === '/data')
  requireEvidence(onlyKeys(data, ['type', 'source', 'target', 'volume', 'read_only']) && data.type === 'volume' &&
    data.source === 'deva-data' && emptyMap(data.volume) && unsetOr(data.read_only, false), 'plan.mounts')
  if (granted) {
    const bind = mounts.find(mount => mount?.target === snapshotTarget)
    requireEvidence(onlyKeys(bind, ['type', 'source', 'target', 'bind', 'read_only']) && bind.type === 'bind' &&
      bind.source === snapshotFile && bind.read_only === true && onlyKeys(bind.bind, ['propagation', 'create_host_path']) &&
      bind.bind.propagation === 'rprivate' && unsetOr(bind.bind.create_host_path, false), 'plan.snapshot')
  }
}

// A config-only contrast: Compose v2.36 omits false; v5.7 omits true. Absence by itself proves neither.
export function sourceCreationControl(yaml) {
  const declaration = /^([ \t]*create_host_path:[ \t]*)false[ \t]*$/gmu
  requireEvidence(typeof yaml === 'string' && [...yaml.matchAll(declaration)].length === 1, 'plan.source-control')
  return yaml.replace(declaration, '$1true')
}
export function checkSourceCreationControl(plan, control) {
  const leaf = p => p?.services?.deva?.volumes?.find(v => v?.type === 'bind' && v.target === snapshotTarget)?.bind
  const a = leaf(plan), b = leaf(control)
  requireEvidence(record(a) && record(b) && unsetOr(a.create_host_path, false) && unsetOr(b.create_host_path, true) &&
    a.create_host_path !== b.create_host_path, 'plan.source-control')
  const adjusted = structuredClone(control), test = leaf(adjusted)
  if (Object.hasOwn(a, 'create_host_path')) test.create_host_path = a.create_host_path
  else delete test.create_host_path
  requireEvidence(isDeepStrictEqual(plan, adjusted), 'plan.source-control')
}

function exactPort(bindings, port, allowUnpublished = false) {
  if (!record(bindings)) return false
  const key = `${port}/tcp`
  const rows = bindings[key]
  // Docker may include unbound image EXPOSE entries with null or empty bindings.
  return Object.keys(bindings).every(name => name === key || (allowUnpublished && emptyList(bindings[name]))) &&
    Array.isArray(rows) && rows.length === 1 && rows[0]?.HostIp === '127.0.0.1' && rows[0]?.HostPort === String(port)
}

export function checkStage(evidence) {
  const { container, image, node, project, port, snapshotFile, granted } = evidence ?? {}
  requireEvidence(matches(projectPattern, project), 'stage.project')
  requireEvidence(record(container) && matches(containerIdPattern, container.Id), 'stage.container-id')
  requireEvidence(record(image) && matches(imageIdPattern, image.Id) && container.Image === image.Id, 'stage.image')
  requireEvidence(image.Os === 'linux' && x86(image.Architecture) &&
    (container.Platform === undefined || container.Platform === 'linux'), 'stage.platform')
  requireEvidence(node?.os === 'linux' && node.arch === 'x64' && node.uid === 1000 &&
    matches(nodePattern, node.version), 'stage.node')
  const { State: state, HostConfig: host, Config: config, NetworkSettings: network, Mounts: mounts } = container
  const health = state?.Health
  requireEvidence(state?.Running === true && state.Status === 'running' && !state.Paused && !state.Restarting &&
    health?.Status === 'healthy' && health.FailingStreak === 0 && Array.isArray(health.Log) &&
    health.Log.at(-1)?.ExitCode === 0, 'stage.health')
  requireEvidence(config?.Labels?.['com.docker.compose.project'] === project &&
    config.Labels['com.docker.compose.service'] === 'deva', 'stage.labels')
  requireEvidence(host?.ReadonlyRootfs === true && host.Privileged === false && emptyList(host.CapAdd) &&
    exactListValue(host.CapDrop, ['ALL']) && exactListValue(host.SecurityOpt, noNewPrivileges), 'stage.hardening')
  requireEvidence(emptyList(host.Devices) && emptyList(host.DeviceRequests) &&
    emptyList(host.DeviceCgroupRules), 'stage.devices')
  const networkName = `${project}_default`, attached = network?.Networks
  requireEvidence(host.NetworkMode === networkName && (attached === undefined ||
    (onlyKeys(attached, [networkName]) && Object.hasOwn(attached, networkName))), 'stage.network')
  requireEvidence(validPort(port) && !host.PublishAllPorts &&
    exactPort(network?.Ports, port, true) &&
    (host.PortBindings === undefined || exactPort(host.PortBindings, port)), 'stage.ports')

  requireEvidence(typeof granted === 'boolean' && emptyMap(host.Tmpfs) && emptyList(host.VolumesFrom) &&
    Array.isArray(mounts) && mounts.length === (granted ? 2 : 1), 'stage.mounts')
  const volumeName = `${project}_deva-data`
  const volume = mounts.find(mount => mount?.Destination === '/data')
  requireEvidence(volume?.Type === 'volume' && volume.Name === volumeName && volume.RW === true &&
    (volume.Driver === undefined || volume.Driver === 'local'), 'stage.volume')
  if (granted) {
    const bind = mounts.find(mount => mount?.Destination === snapshotTarget)
    // The caller creates and checks the private source on disk; inspect proves the exact leaf was mounted.
    requireEvidence(privateSource(snapshotFile) && bind?.Type === 'bind' && bind.Source === snapshotFile &&
      bind.RW === false && unsetOr(bind.Propagation, 'rprivate'), 'stage.snapshot')
  }
  return { containerId: container.Id, imageId: image.Id, volumeName, nodeVersion: node.version }
}

export function checkContinuity(stages) {
  requireEvidence(Array.isArray(stages) && stages.length === 3 && Array.from(stages).every(stage =>
    record(stage) && matches(containerIdPattern, stage.containerId) && matches(imageIdPattern, stage.imageId) &&
    matches(volumePattern, stage.volumeName) && matches(nodePattern, stage.nodeVersion)), 'continuity.stages')
  const [first, ...rest] = stages
  requireEvidence(new Set(stages.map(stage => stage.containerId)).size === 3, 'continuity.containers')
  requireEvidence(rest.every(stage => stage.imageId === first.imageId), 'continuity.image')
  requireEvidence(rest.every(stage => stage.volumeName === first.volumeName), 'continuity.volume')
  requireEvidence(rest.every(stage => stage.nodeVersion === first.nodeVersion), 'continuity.node')
}
