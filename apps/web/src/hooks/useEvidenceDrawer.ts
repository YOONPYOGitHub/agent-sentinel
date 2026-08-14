import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'

import type { Evidence } from '@agent-sentinel/domain'

export function useEvidenceDrawer(initialEvidence?: Evidence, onDismiss?: () => void) {
  const [selectedEvidence, setSelectedEvidence] = useState<Evidence | undefined>(initialEvidence)
  const drawerRef = useRef<HTMLElement>(null)

  useEffect(() => {
    setSelectedEvidence(initialEvidence)
  }, [initialEvidence])

  useEffect(() => {
    if (selectedEvidence === undefined) {
      return
    }

    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    drawerRef.current?.focus()
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSelectedEvidence(undefined)
        onDismiss?.()
      }
    }
    document.addEventListener('keydown', closeOnEscape)

    return () => {
      document.removeEventListener('keydown', closeOnEscape)
      previousFocus?.focus()
    }
  }, [onDismiss, selectedEvidence])

  const trapFocus = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab') return
    const focusable = event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    const first = focusable.item(0)
    const last = focusable.item(focusable.length - 1)
    if (first === null || last === null) {
      event.preventDefault()
    } else if (
      event.shiftKey &&
      (document.activeElement === first || document.activeElement === event.currentTarget)
    ) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }, [])

  return { selectedEvidence, setSelectedEvidence, drawerRef, trapFocus }
}
