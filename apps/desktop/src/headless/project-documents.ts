import { randomBytes } from 'node:crypto'
import { MAX_PROJECT_DETAIL_JSON, MAX_PROJECT_LIST_JSON } from './project-docs-format'
import { SnapshotError, type ProjectSnapshot } from './project-snapshot'

export const PROJECT_DOCS = '/api/project-docs'
const opaqueId = () => randomBytes(16).toString('hex')
export type ProjectResponse = Readonly<{ json: string; bytes: number }>

function encode(value: unknown, maxBytes: number): ProjectResponse {
  const json = JSON.stringify(value), bytes = Buffer.byteLength(json)
  if (bytes > maxBytes) throw new SnapshotError('snapshot_limit')
  return Object.freeze({ json, bytes })
}

/** An immutable, process-local publication. A URL is an exact lookup key, never a filesystem path. */
export function projectDocumentResponses(snapshot: ProjectSnapshot | undefined) {
  if (!snapshot) return undefined
  const generation = opaqueId(), responses = new Map<string, ProjectResponse>()
  const documents = snapshot.documents.map(({ name, text, bytes }) => {
    let id: string, path: string
    do { id = opaqueId(); path = `${PROJECT_DOCS}/${generation}/${id}` } while (responses.has(path))
    responses.set(path, encode({ generation, id, name, bytes, text }, MAX_PROJECT_DETAIL_JSON))
    return { id, name, bytes }
  })
  responses.set(PROJECT_DOCS, encode({ project: snapshot.project, generation, documents }, MAX_PROJECT_LIST_JSON))
  return (path: string) => responses.get(path)
}
