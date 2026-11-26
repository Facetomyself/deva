import type { ComponentPropsWithRef, HTMLAttributes, MouseEventHandler, ReactNode } from 'react'
import { ChevronLeft, ChevronRight, Puzzle } from 'lucide-react'

type DataAttributes = { [name: `data-${string}`]: string | undefined }

/** The extension row keeps the drill-in button and the independent toggle as siblings. */
export function ExtensionSettingsRow({ name, badge, note, noteWarn, accessory, toggle, onOpen, rowProps, openProps }: {
  name: string; badge: string; note?: string; noteWarn?: boolean; accessory?: ReactNode; toggle: ReactNode
  onOpen?: MouseEventHandler<HTMLButtonElement>; rowProps?: HTMLAttributes<HTMLDivElement> & DataAttributes
  openProps?: Omit<ComponentPropsWithRef<'button'>, 'onClick'> & DataAttributes
}): React.JSX.Element {
  const label = (
    <span className="cf-setrow__name">
      <span className="cf-setrow__label" title={name}>
        {name}
      </span>
      <span className="cf-badge">{badge}</span>
      {note && (
        <span className={`cf-setrow__note${noteWarn ? ' cf-setrow__note--warn' : ''}`}>
          {note}
        </span>
      )}
    </span>
  )
  return (
    <div {...rowProps} className="cf-setrow">
      {onOpen ? (
        <button {...openProps} className="cf-setrow__open" onClick={onOpen}>
          {label}
          {accessory}
          <ChevronRight className="cf-setrow__chevron" size={15} />
        </button>
      ) : (
        <div className="cf-setrow__main">{label}</div>
      )}
      {toggle}
    </div>
  )
}

/** The native skill detail surface; the caller supplies its policy, controls and body. */
export function SkillSettingsDetail({ name, backLabel, onBack, controls, children, sectionProps, backProps }: {
  name: string; backLabel: string; onBack: () => void; controls?: ReactNode; children: ReactNode
  sectionProps?: HTMLAttributes<HTMLElement> & DataAttributes
  backProps?: ComponentPropsWithRef<'button'> & DataAttributes
}): React.JSX.Element {
  return (
    <section {...sectionProps} className="provider-detail provider-detail--fill">
      <div className="provider-detail__topbar">
        <button {...backProps} className="provider-detail__back" onClick={onBack}>
          <ChevronLeft size={16} />
          {backLabel}
        </button>
        <div className="provider-detail__spacer" />
        {controls}
      </div>
      <header className="provider-detail__head">
        <span className="ext-detail__icon">
          <Puzzle size={18} />
        </span>
        <h2 className="ext-detail__name ext-detail__name--mono">{name}</h2>
      </header>
      {children}
    </section>
  )
}
