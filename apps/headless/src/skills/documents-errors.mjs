const statusByCode = Object.freeze({
  skill_invalid: 400,
  skill_unsupported: 409,
  skill_limit: 413,
  skill_restricted: 422
})

export class SkillDocumentError extends Error {
  constructor(code) {
    super(code)
    this.name = 'SkillDocumentError'
    this.code = code
    this.status = this.statusCode = statusByCode[code]
  }
}

export function fail(code = 'skill_unsupported') { throw new SkillDocumentError(code) }
