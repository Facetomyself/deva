import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import { GitBranch } from 'lucide-react'

type GitBranchPillProps = ComponentPropsWithoutRef<'button'> & {
  label: string; mergeLabel?: string; busy?: boolean; children?: ReactNode
}

/** The desktop branch chip, without workspace access or Git behavior. */
export const GitBranchPill = forwardRef<HTMLButtonElement, GitBranchPillProps>(function GitBranchPill(
  { label, mergeLabel, busy, className, children, ...button }, ref
) {
  return <button {...button} type="button" ref={ref} className={`cf-gitchip${busy ? ' is-busy' : ''}${className ? ` ${className}` : ''}`}>
    <GitBranch size={13} aria-hidden="true" />
    <span className="cf-gitchip__branch" title={label}>{label}</span>
    {mergeLabel && <span className="cf-gitchip__merge">{mergeLabel}</span>}
    {children}
  </button>
})
