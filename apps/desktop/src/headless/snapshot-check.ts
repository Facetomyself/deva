import { fstatSync } from 'node:fs'
import { isSnapshotDigest, MAX_SNAPSHOT_BYTES, SnapshotError, validateProjectSnapshot } from './project-snapshot'

const usage = 'Usage: node check.mjs --sha256 <64 lowercase hex characters> < snapshot.json'

async function main(args: string[]): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(usage); return 0 }
  if (args.length !== 2 || args[0] !== '--sha256' || !isSnapshotDigest(args[1]) || process.stdin.isTTY) {
    console.error(usage); return 2
  }
  // Use one fixed-size buffer, not a growing collection of arbitrary stdin chunks.
  const input = Buffer.allocUnsafe(MAX_SNAPSHOT_BYTES)
  let used = 0
  try {
    // On Linux, Node can present a directory on fd 0 as immediate EOF. It is not an empty snapshot.
    if (fstatSync(0).isDirectory()) throw new Error('input_error')
    for await (const chunk of process.stdin) {
      if (!Buffer.isBuffer(chunk)) throw new Error('input_error')
      if (chunk.length > input.length - used) throw new SnapshotError('snapshot_limit')
      chunk.copy(input, used); used += chunk.length
    }
    const result = validateProjectSnapshot(input.subarray(0, used), args[1])
    console.log(JSON.stringify({ ok: true, version: result.version, documents: result.documents.length,
      textBytes: result.totalTextBytes, sourceBytes: used }))
    return 0
  } catch (error) {
    process.stdin.destroy()
    console.error(`Snapshot check failed: ${error instanceof SnapshotError ? error.code : 'input_error'}`)
    return 1
  } finally { input.fill(0, 0, used) }
}

process.exitCode = await main(process.argv.slice(2))
