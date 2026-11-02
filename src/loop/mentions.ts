/**
 * Agent-written text never notifies anyone: a zero-width space after each `@`
 * that would start a mention keeps the text readable but unlinked.
 */
export function withoutMentions(text: string): string {
  return text.replace(/(?<![\w`])@(?=[A-Za-z0-9])/g, "@​");
}
