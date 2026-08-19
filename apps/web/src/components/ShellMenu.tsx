import { useEffect, useRef, type ReactNode } from 'react'

interface ShellMenuProps {
  label: string
  trigger: ReactNode
  children: ReactNode
  align?: 'start' | 'end'
}

export function ShellMenu({ label, trigger, children, align = 'end' }: ShellMenuProps) {
  const detailsRef = useRef<HTMLDetailsElement>(null)
  const summaryRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const closeMenu = (event: MouseEvent) => {
      if (!detailsRef.current?.contains(event.target as Node))
        detailsRef.current?.removeAttribute('open')
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && detailsRef.current?.hasAttribute('open')) {
        detailsRef.current.removeAttribute('open')
        summaryRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', closeMenu)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeMenu)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [])

  return (
    <details ref={detailsRef} className={`shell-menu shell-menu--${align}`}>
      <summary ref={summaryRef} role="button" aria-label={label}>
        {trigger}
      </summary>
      <div
        className="shell-menu__popover"
        role="group"
        aria-label={label}
        onClick={(event) => {
          if ((event.target as Element).closest('a')) detailsRef.current?.removeAttribute('open')
        }}
      >
        {children}
      </div>
    </details>
  )
}
