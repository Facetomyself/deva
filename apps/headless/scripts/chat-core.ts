// Only the audited, portable parts of the same desktop implementation become server code.
export { createChatStore, isValidSessionId, deriveTitle } from '../../desktop/src/main/services/chat-store-core'
export { consumeModelStep } from '../../desktop/src/main/services/model-step-stream'
export { modelMessages } from '../../desktop/src/main/services/model-view'
export { estimateTokens } from '../../desktop/src/shared/context-estimate'
export {
  assetKind, isSupported, supportsAttachmentAdapter, maxUploadedAttachmentBytes, buildUploadedPart,
  uploadedAttachmentSnapshot, UploadedAttachmentError, ATTACH_TEXT_PREFIX, ATTACHMENTS_ONLY_QUESTION
} from '../../desktop/src/main/services/attachment-parts-core'
export type {
  BuiltUploadedAttachment, UploadedAttachmentDisplay, UploadedAttachmentKind, UploadedAttachmentMeta
} from '../../desktop/src/main/services/attachment-parts-core'
