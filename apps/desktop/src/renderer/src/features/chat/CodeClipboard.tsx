import { createContext, useContext, useMemo, type ReactNode } from 'react'

/** The web presentation can provide its local clipboard operation without introducing a
 * dependency on the browser host in the shared Markdown renderer or in Electron. */
export type CodeClipboard = { writeText(text: string): Promise<void>; locked: boolean }
const Context = createContext<CodeClipboard | null>(null)
export function CodeClipboardProvider({ writeText, locked, children }: CodeClipboard & { children: ReactNode }): React.JSX.Element {
  const value = useMemo(() => ({ writeText, locked }), [writeText, locked])
  return <Context.Provider value={value}>{children}</Context.Provider>
}
export function useCodeClipboard(): CodeClipboard | null { return useContext(Context) }
