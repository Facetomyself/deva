// Byte limits shared by the offline validator, startup publication and browser reader.
export const MAX_PROJECT_DOCUMENTS = 32
export const MAX_PROJECT_TEXT_BYTES = 256 * 1024
export const MAX_PROJECT_LIST_JSON = 32 * 1024
export const MAX_PROJECT_DETAIL_JSON = 200 * 1024
const badLabel = /[/:\\\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069\uD800-\uDFFF]/u
const utf8 = new TextEncoder()
export const isProjectDocsLabel = (v: unknown): v is string => typeof v === 'string' && v.length > 0 &&
  v.length <= 80 && v === v.trim() && v !== '.' && v !== '..' && !badLabel.test(v) && utf8.encode(v).length <= 80
