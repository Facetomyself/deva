// Guard against accidental literal echoes from a configured provider (e.g. a debug proxy).
// Do not scan user input or pass credential values to the UI. This does not claim to detect
// arbitrary encodings or a remote provider deliberately constructing covert output.
const MASK = '[redacted]'

export function literalMatcher(values) {
  // The settings schema already bounds individual values, their count and aggregate bytes.
  const nodes = [{ go: new Map(), parent: 0, depth: 0, match: 0 }]
  for (const value of new Set(values.filter(v => typeof v === 'string' && v.length))) {
    let at = 0
    for (let i = 0; i < value.length; i++) {
      const ch = value[i]; let next = nodes[at].go.get(ch)
      if (next === undefined) { next = nodes.length; nodes[at].go.set(ch, next); nodes.push({ go: new Map(), parent: 0, depth: nodes[at].depth + 1, match: 0 }) }
      at = next
    }
    nodes[at].match = value.length
  }
  const queue = [...nodes[0].go.values()]
  for (let i = 0; i < queue.length; i++) {
    const at = queue[i]
    for (const [ch, next] of nodes[at].go) {
      let fallback = nodes[at].parent
      while (fallback && !nodes[fallback].go.has(ch)) fallback = nodes[fallback].parent
      nodes[next].parent = nodes[fallback].go.get(ch) ?? 0
      nodes[next].match = Math.max(nodes[next].match, nodes[nodes[next].parent].match)
      queue.push(next)
    }
  }
  return () => {
    let at = 0, pending = ''
    return {
      next(chunk) {
        if (nodes.length === 1) return chunk
        let safe = ''
        for (let i = 0; i < chunk.length; i++) {
          const ch = chunk[i]; pending += ch
          while (at && !nodes[at].go.has(ch)) at = nodes[at].parent
          at = nodes[at].go.get(ch) ?? 0
          const node = nodes[at]
          if (node.match) {
            safe += pending.slice(0, Math.max(0, pending.length - node.match)) + MASK
            // Retain the automaton position: a longer/overlapping value may include
            // part of the secret we just hid; its new suffix must not leak either.
            pending = ''
          } else if (pending.length > node.depth) {
            safe += pending.slice(0, pending.length - node.depth)
            pending = node.depth ? pending.slice(-node.depth) : ''
          }
        }
        return safe
      },
      finish() {
        // A long unresolved prefix on stream termination must not reveal a nearly complete credential.
        const safe = pending.length >= 8 ? MASK : pending
        at = 0; pending = ''; return safe
      }
    }
  }
}

export async function* filterModelOutput(source, privateValues) {
  const make = literalMatcher(privateValues)
  const lanes = { text_delta: make(), thinking_delta: make() }
  function* finish() {
    for (const [type, lane] of Object.entries(lanes)) { const text = lane.finish(); if (text) yield { type, text } }
  }
  for await (const ev of source) {
    if (Object.hasOwn(lanes, ev.type)) {
      const text = lanes[ev.type].next(ev.text)
      if (text) yield { type: ev.type, text }
    } else {
      if (ev.type === 'done') yield* finish()
      if (ev.type === 'error') yield { type: 'error', error: { kind: ev.error.kind, retryable: ev.error.retryable, message: 'Model request failed' } }
      else yield ev
    }
  }
  yield* finish()
}
