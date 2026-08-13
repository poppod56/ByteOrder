import { createContext, useContext, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { menuApi, orderApi, setKitchenId } from '../lib/api'
import i18n, { SUPPORTED_LANGUAGES } from '../i18n'

const KitchenContext = createContext(null)

export function useKitchen() {
  return useContext(KitchenContext)
}

function langCacheKey(kitchenId) {
  return `bo_lang_${kitchenId}`
}

function applyLanguage(kitchenId, lang) {
  const resolved = SUPPORTED_LANGUAGES.includes(lang) ? lang : 'en'
  i18n.changeLanguage(resolved)
  document.documentElement.lang = resolved
  try { localStorage.setItem(langCacheKey(kitchenId), resolved) } catch {}
}

// Applies the kitchen's last-known language immediately, before the settings
// fetch resolves — otherwise every navigation would flash English first.
function applyCachedLanguage(kitchenId) {
  let cached
  try { cached = localStorage.getItem(langCacheKey(kitchenId)) } catch { cached = null }
  if (cached) {
    i18n.changeLanguage(cached)
    document.documentElement.lang = cached
  }
}

function loadBrandSettings(kitchenId) {
  const apply = (key, prop) =>
    menuApi.get(`/settings/${key}`).then(({ data: s }) => {
      if (s.value) document.documentElement.style.setProperty(prop, s.value)
    }).catch(() => {})
  apply('brand_primary', '--brand-primary')
  apply('brand_bg',      '--brand-bg')
  apply('brand_surface', '--brand-surface')
  apply('brand_text',    '--brand-text')
  menuApi.get('/settings/kitchen_name').then(({ data: s }) => {
    if (s.value) document.title = s.value
  }).catch(() => {})
  menuApi.get('/settings/default_language').then(({ data: s }) => {
    applyLanguage(kitchenId, s.value)
  }).catch(() => {})
}

/**
 * KitchenProvider resolves the active kitchen in one of two ways:
 *
 * Cloud (slug-based):   rendered inside /k/:slug/* — reads slug from URL params,
 *                        calls GET /slug/:slug to resolve kitchen_id.
 *
 * Self-hosted (direct): pass fixedKitchenId="default" — skips the slug lookup
 *                        and uses the ID directly. slug will be null in context.
 */
export function KitchenProvider({ children, fixedKitchenId = null }) {
  const params = useParams()
  const { t } = useTranslation()
  const slug = fixedKitchenId ? null : (params.slug ?? null)
  const [kitchenId, setKitchenIdState] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (fixedKitchenId) {
      applyCachedLanguage(fixedKitchenId)
      setKitchenId(fixedKitchenId)
      setKitchenIdState(fixedKitchenId)
      loadBrandSettings(fixedKitchenId)
      return
    }
    if (!slug) return
    menuApi.get(`/slug/${slug}`)
      .then(({ data }) => {
        applyCachedLanguage(data.kitchen_id)
        setKitchenId(data.kitchen_id)
        setKitchenIdState(data.kitchen_id)
        loadBrandSettings(data.kitchen_id)
      })
      .catch(() => setError('Kitchen not found'))
  }, [slug, fixedKitchenId])

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-800 mb-2">{t('common.kitchenNotFound')}</h1>
          <p className="text-gray-500">{t('common.checkUrlAndTryAgain')}</p>
        </div>
      </div>
    )
  }

  if (!kitchenId) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="w-8 h-8 border-4 border-brand-600 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <KitchenContext.Provider value={{ kitchenId, slug }}>
      {children}
    </KitchenContext.Provider>
  )
}
