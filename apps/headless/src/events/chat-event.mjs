const invalidIdChar = /[^A-Za-z0-9_-]/
const stopReasons = new Set([
  'end_turn', 'tool_use', 'max_tokens', 'stop', 'refusal', 'aborted', 'error', 'step_limit', 'repeated', 'degenerate'
])
const retryReasons = new Set(['truncated', 'empty', 'context', 'output_limit', 'effort', 'repetition', 'output_fit'])

export function isSessionId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 128 && !invalidIdChar.test(id)
}

function nonNegativeInt(n) {
  return Number.isSafeInteger(n) && n >= 0
}

// Initial chat output only. Never spread a desktop event or serialize its arbitrary objects.
// text_delta is user-visible chat prose from the trusted producer, not raw provider/tool output.
function selectOutput(input) {
  const type = input?.type
  switch (type) {
    case 'text_delta': {
      const text = input.text
      return typeof text === 'string' ? { type, text } : null
    }
    case 'turn_start':
    case 'stream_reset':
    // Usage is read from the authoritative session+model projection. Broadcast only an invalidation.
    case 'context_changed':
    case 'member_report':
    case 'error':
      return { type }
    case 'done': {
      const { stopReason, durationMs } = input
      const event = { type }
      if (stopReasons.has(stopReason)) event.stopReason = stopReason
      if (nonNegativeInt(durationMs)) event.durationMs = durationMs
      return event
    }
    case 'auto_retry':
    case 'reconnecting': {
      const { attempt, max, reason } = input
      const event = { type }
      if (nonNegativeInt(attempt)) event.attempt = attempt
      if (nonNegativeInt(max)) event.max = max
      if (type === 'auto_retry' && retryReasons.has(reason)) event.reason = reason
      return event
    }
    default:
      return null
  }
}

export function projectChatEvent(payload) {
  const { sessionId, turnId, event: input } = payload ?? {}
  if (!isSessionId(sessionId) || !(turnId === '' || isSessionId(turnId))) return null
  const event = selectOutput(input)
  return event && { type: 'chat', sessionId, turnId, event }
}
