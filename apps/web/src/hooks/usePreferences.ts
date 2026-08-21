import { useCallback, useEffect, useState } from 'react'

export interface Preferences {
  landingPage: LandingPage
  density: 'comfortable' | 'compact'
}

export type LandingPage = '/overview' | '/agent-inventory' | '/exposure' | '/governance'

const DEFAULTS: Preferences = {
  landingPage: '/overview',
  density: 'comfortable',
}

const STORAGE_KEY = 'agent-sentinel:preferences'
const CHANGE_EVENT = 'agent-sentinel:preferences-changed'
const LANDING_PAGES = new Set<LandingPage>([
  '/overview',
  '/agent-inventory',
  '/exposure',
  '/governance',
])

export function isLandingPage(value: unknown): value is LandingPage {
  return typeof value === 'string' && LANDING_PAGES.has(value as LandingPage)
}

function isDensity(value: unknown): value is Preferences['density'] {
  return value === 'comfortable' || value === 'compact'
}

function loadPreferences(): Preferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed = JSON.parse(raw) as Partial<Preferences>
    return {
      landingPage: isLandingPage(parsed.landingPage)
        ? parsed.landingPage
        : DEFAULTS.landingPage,
      density: isDensity(parsed.density) ? parsed.density : DEFAULTS.density,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

function savePreferences(prefs: Preferences): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

export function usePreferences(): [Preferences, (update: Partial<Preferences>) => void] {
  const [prefs, setPrefs] = useState<Preferences>(loadPreferences)

  useEffect(() => {
    const handler = () => {
      setPrefs(loadPreferences())
    }
    window.addEventListener(CHANGE_EVENT, handler)
    return () => {
      window.removeEventListener(CHANGE_EVENT, handler)
    }
  }, [])

  const update = useCallback(
    (patch: Partial<Preferences>) => {
      const next = { ...prefs, ...patch }
      savePreferences(next)
      setPrefs(next)
    },
    [prefs],
  )

  return [prefs, update]
}
