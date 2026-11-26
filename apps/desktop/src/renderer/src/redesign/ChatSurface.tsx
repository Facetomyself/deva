import type { ComponentPropsWithoutRef, ReactNode, Ref } from 'react'
import './redesign.css'

export function ChatSurface({ className, ...props }: ComponentPropsWithoutRef<'div'>): React.JSX.Element {
  return <div className={`cf-shell${className ? ` ${className}` : ''}`} {...props} />
}

export function ConversationSurface({ className, ...props }: ComponentPropsWithoutRef<'main'>): React.JSX.Element {
  return <main className={`cf-conv${className ? ` ${className}` : ''}`} {...props} />
}

export function ConversationHeader({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="cf-conv__head">{children}</div>
}

export function ConversationScroller({ scrollRef, selecting, children, ...props }: ComponentPropsWithoutRef<'div'> & {
  scrollRef: Ref<HTMLDivElement>
  selecting?: boolean
}): React.JSX.Element {
  return <div className="cf-msgs" ref={scrollRef} {...props}>
    <div className={`cf-msgs__inner${selecting ? ' is-selecting' : ''}`}>{children}</div>
  </div>
}
