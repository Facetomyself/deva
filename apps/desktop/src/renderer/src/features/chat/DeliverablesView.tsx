import { useState, type ReactNode } from 'react'
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Copy,
  Download,
  ExternalLink,
  Eye,
  File,
  FolderOpen,
  Package
} from 'lucide-react'

// Leave six-file cards unfolded rather than creating a control for one remaining row.
const FOLD_PREVIEW = 5
const ACTION_ICONS = {
  open: ExternalLink,
  preview: Eye,
  download: Download,
  locate: FolderOpen,
  copy: Copy
}

export interface DeliverableViewAction {
  id: keyof typeof ACTION_ICONS
  label: string
  onClick: () => void
  disabled?: boolean
  copied?: boolean
}

export interface DeliverableViewRow {
  key: string
  index?: number
  name: string
  detail: string
  title?: string
  thumb?: string | null
  missing?: boolean
  primary?: () => void
  actions: readonly DeliverableViewAction[]
}

interface DeliverablesViewProps {
  title: string
  labels: {
    count: (n: number) => string
    collapsed: (name: string, n: number) => string
    expand: (remaining: number) => string
    collapse: string
  }
  rows: readonly DeliverableViewRow[]
  groupId?: string
  origin?: 'reply' | 'desktop'
  onCollapse?: () => void
  children?: ReactNode
}

export function formatDeliverableSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`
}

function DeliverableFileRow({ row }: { row: DeliverableViewRow }): React.JSX.Element {
  return (
    <div className={`deliv__item${row.missing ? ' is-missing' : ''}`}
      data-testid="deliverables-file-row" data-delivery-item-index={row.index}>
      <button type="button" className="deliv__main" onClick={row.primary}
        disabled={!row.primary} title={row.title}>
        <span className="deliv__thumb">
          {row.thumb ? <img src={row.thumb} alt="" draggable={false} /> : <File size={20} />}
        </span>
        <span className="deliv__meta">
          <span className="deliv__name">{row.name}</span>
          <span className="deliv__sub">{row.detail}</span>
        </span>
      </button>
      <span className="deliv__actions">
        {row.actions.map(({ id, label, onClick, disabled, copied }) => {
          const Icon = copied ? Check : ACTION_ICONS[id]
          return (
            <button key={id} type="button" className="deliv__act" data-testid={`deliverables-${id}`}
              onClick={onClick} disabled={disabled} title={label} aria-label={label}>
              <Icon size={14} />
            </button>
          )
        })}
      </span>
    </div>
  )
}

/** Shared file card; the host supplies display metadata and owns every action. */
export function DeliverablesView({ title, labels, rows, groupId, origin, onCollapse, children }: DeliverablesViewProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [cardOpen, setCardOpen] = useState(true)
  const foldable = rows.length > FOLD_PREVIEW + 1
  const shown = foldable && !expanded ? rows.slice(0, FOLD_PREVIEW) : rows
  const summary = rows.length > 1 ? labels.collapsed(rows[0].name, rows.length) : rows[0]?.name

  return (
    <div className={`card deliv${cardOpen ? ' is-open' : ''}`} data-testid="deliverables-card"
      data-delivery-group-id={groupId} data-delivery-origin={origin} tabIndex={groupId ? -1 : undefined}>
      <button type="button" className="card__head deliv__head" data-testid="deliverables-card-toggle"
        onClick={() => { if (cardOpen) onCollapse?.(); setCardOpen(!cardOpen) }} aria-expanded={cardOpen}>
        <ChevronRight size={13} className="deliv__caret" />
        <span className="card__head-icon"><Package size={14} /></span>
        <span className="card__title">
          {title}
          {!cardOpen && summary && <span className="deliv__summary"> · {summary}</span>}
        </span>
        {cardOpen && <span className="deliv__count">{labels.count(rows.length)}</span>}
      </button>
      <div className="deliv__list" hidden={!cardOpen}>
        {shown.map((row) => <DeliverableFileRow key={row.key} row={row} />)}
        {children}
      </div>
      {cardOpen && foldable && (
        <button type="button" className="deliv__more" data-testid="deliverables-show-more"
          onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
          {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          {expanded ? labels.collapse : labels.expand(rows.length - FOLD_PREVIEW)}
        </button>
      )}
    </div>
  )
}
