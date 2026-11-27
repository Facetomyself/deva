/** Native text attachment block: keep this representation identical across desktop and Web. */
export const ATTACH_TEXT_PREFIX = '[附件文件] '
export const ATTACHMENTS_ONLY_QUESTION = '请理解并处理上述附件。'
export const formatTextAttachment = (name: string, text: string): string =>
  `${ATTACH_TEXT_PREFIX}${name}\n\`\`\`\n${text}\n\`\`\``
