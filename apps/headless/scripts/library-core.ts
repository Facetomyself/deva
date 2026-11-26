// Portable file format and validation only; Electron IPC and desktop-only profiles are not imported.
export * from '../../desktop/src/main/services/profile-core'
export * from '../../desktop/src/main/services/avatar-image-core'
export * from '../../desktop/src/main/services/memory-core'
export * from '../../desktop/src/main/services/persona-format'
export { parseSkillDocument } from '../../desktop/src/main/services/skill-document-format'
export { BUILTIN_SKILL_CATALOG } from '../../desktop/src/shared/skill-catalog'
