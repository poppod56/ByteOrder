import { useState, useEffect, useRef } from 'react'
import { useOrganization } from '@clerk/clerk-react'
import { useTranslation } from 'react-i18next'
import api from '../lib/api'
import i18n, { SUPPORTED_LANGUAGES } from '../i18n'

const MAX_LOGO_BYTES = 512 * 1024  // 512 KB

/**
 * useOrganization throws outside a ClerkProvider, which self-hosted deployments
 * never mount — so the hook is confined to a component that only renders in
 * cloud mode, and the form itself takes the organisation as a plain prop.
 */
export default function Settings({ authMode }) {
  return authMode === 'cloud'
    ? <SettingsWithClerkOrg />
    : <SettingsForm organization={null} />
}

function SettingsWithClerkOrg() {
  const { organization } = useOrganization()
  return <SettingsForm organization={organization} />
}

function SettingsForm({ organization }) {
  const { t } = useTranslation()
  const [printerUrl, setPrinterUrl] = useState('')
  const [frontendUrl, setFrontendUrl] = useState('')
  const [currency, setCurrency] = useState('THB')
  const [language, setLanguage] = useState('en')
  const [kitchenName, setKitchenName] = useState('')
  const [logo, setLogo] = useState('')
  const [brandPrimary, setBrandPrimary] = useState('#ea580c')
  const [brandBg, setBrandBg] = useState('#f9fafb')
  const [brandSurface, setBrandSurface] = useState('#ffffff')
  const [brandText, setBrandText] = useState('#111827')
  const [slug, setSlug] = useState('')
  const [slugBanner, setSlugBanner] = useState(false)
  const [nameBanner, setNameBanner] = useState(false)
  const [saved, setSaved] = useState('')
  const [error, setError] = useState('')
  const fileInputRef = useRef(null)

  useEffect(() => {
    api.get('/settings/').then(({ data }) => {
      const map = Object.fromEntries(data.map(s => [s.key, s.value || '']))
      setPrinterUrl(map.printer_url || '')
      setFrontendUrl(map.frontend_url || '')
      setCurrency(map.currency || 'THB')
      setLanguage(SUPPORTED_LANGUAGES.includes(map.default_language) ? map.default_language : 'en')
      if (map.kitchen_name) {
        setKitchenName(map.kitchen_name)
      } else if (organization?.name) {
        setKitchenName(organization.name)
        setNameBanner(true)
      }
      setLogo(map.logo || '')
      const colour = map.brand_primary || '#ea580c'
      setBrandPrimary(colour)
      document.documentElement.style.setProperty('--brand-primary', colour)
      const bg = map.brand_bg || '#f9fafb'
      setBrandBg(bg)
      document.documentElement.style.setProperty('--brand-bg', bg)
      const surface = map.brand_surface || '#ffffff'
      setBrandSurface(surface)
      document.documentElement.style.setProperty('--brand-surface', surface)
      const text = map.brand_text || '#111827'
      setBrandText(text)
      document.documentElement.style.setProperty('--brand-text', text)
    })

    api.get('/menu/kitchens/me')
      .then(({ data }) => setSlug(data.slug))
      .catch(err => {
        // 404 = not set up yet — pre-fill from Clerk org slug
        if (err.response?.status === 404 && organization?.slug) {
          setSlug(organization.slug)
          setSlugBanner(true)
        }
      })
  }, [organization])

  function handleBrandColour(hex) {
    setBrandPrimary(hex)
    document.documentElement.style.setProperty('--brand-primary', hex)
  }
  function handleBrandBg(hex) {
    setBrandBg(hex)
    document.documentElement.style.setProperty('--brand-bg', hex)
  }
  function handleBrandSurface(hex) {
    setBrandSurface(hex)
    document.documentElement.style.setProperty('--brand-surface', hex)
  }
  function handleBrandText(hex) {
    setBrandText(hex)
    document.documentElement.style.setProperty('--brand-text', hex)
  }

  function handleLogoFile(e) {
    const file = e.target.files[0]
    if (!file) return
    if (file.size > MAX_LOGO_BYTES) {
      setError(t('settings.logoTooLarge', { size: Math.round(file.size / 1024) }))
      e.target.value = ''
      return
    }
    setError('')
    const reader = new FileReader()
    reader.onload = ev => setLogo(ev.target.result)
    reader.readAsDataURL(file)
  }

  function clearLogo() {
    setLogo('')
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  async function saveSettings(e) {
    e.preventDefault()
    setError('')
    setSaved('')
    try {
      await Promise.all([
        api.put('/settings/printer_url',   { value: printerUrl }),
        api.put('/settings/frontend_url',  { value: frontendUrl.trim().replace(/\/+$/, '') }),
        api.put('/settings/currency',      { value: currency.trim().toUpperCase() }),
        api.put('/settings/default_language', { value: language }),
        api.put('/settings/kitchen_name',  { value: kitchenName }),
        api.put('/settings/logo',          { value: logo }),
        api.put('/settings/brand_primary', { value: brandPrimary }),
        api.put('/settings/brand_bg',      { value: brandBg }),
        api.put('/settings/brand_surface', { value: brandSurface }),
        api.put('/settings/brand_text',    { value: brandText }),
        api.put('/menu/kitchens/me',       { slug }),
      ])
      i18n.changeLanguage(language)
      document.documentElement.lang = language
      setSlugBanner(false)
      setSaved(t('settings.saved'))
    } catch (err) {
      setError(err.response?.data?.detail || t('settings.saveFailed'))
    }
  }

  // Prefer the configured Frontend URL over guessing from the admin origin —
  // this preview should show customers the same address their QR codes encode.
  const customerBase = frontendUrl.trim().replace(/\/+$/, '')
    || window.location.origin.replace(/(^https?:\/\/)admin\./, '$1')
  const customerUrl = slug ? `${customerBase}/k/${slug}` : null

  return (
    <div className="max-w-lg space-y-8">
      <h1 className="text-2xl font-bold text-brand-text">{t('settings.title')}</h1>

      {saved && <p className="text-green-600 text-sm">{saved}</p>}
      {error && <p className="text-red-600 text-sm">{error}</p>}

      <form onSubmit={saveSettings} className="bg-brand-surface rounded-xl shadow p-6 space-y-4">
        <h2 className="text-lg font-semibold text-gray-800">{t('settings.kitchenSettings')}</h2>

        {slugBanner && (
          <div className="bg-blue-50 border border-blue-200 text-blue-800 text-sm rounded-lg px-4 py-3">
            {t('settings.slugBanner')}
            <button type="button" onClick={() => setSlugBanner(false)} className="ml-2 underline text-blue-600 text-xs">{t('settings.dismiss')}</button>
          </div>
        )}
        {nameBanner && (
          <div className="bg-blue-50 border border-blue-200 text-blue-800 text-sm rounded-lg px-4 py-3">
            {t('settings.nameBanner')}
            <button type="button" onClick={() => setNameBanner(false)} className="ml-2 underline text-blue-600 text-xs">{t('settings.dismiss')}</button>
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">{t('settings.kitchenName')}</label>
          <input
            value={kitchenName}
            onChange={e => setKitchenName(e.target.value)}
            className="w-full border rounded-lg px-3 py-2"
            placeholder={t('settings.kitchenNamePlaceholder')}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">{t('settings.customerUrlSlug')}</label>
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-400 shrink-0">/k/</span>
            <input
              value={slug}
              onChange={e => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
              className="flex-1 border rounded-lg px-3 py-2 font-mono text-sm"
              placeholder={t('settings.slugPlaceholder')}
            />
          </div>
          {customerUrl && (
            <p className="text-xs text-gray-500 mt-1">
              {t('settings.customerUrl')}{' '}
              <a href={customerUrl} target="_blank" rel="noopener noreferrer" className="text-brand-600 underline break-all">
                {customerUrl}
              </a>
            </p>
          )}
          <p className="text-xs text-gray-400 mt-1">{t('settings.slugHint')}</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">{t('settings.frontendUrl')}</label>
          <input
            value={frontendUrl}
            onChange={e => setFrontendUrl(e.target.value)}
            className="w-full border rounded-lg px-3 py-2 font-mono text-sm"
            placeholder={t('settings.frontendUrlPlaceholder')}
          />
          <p className="text-xs text-gray-400 mt-1">
            {t('settings.frontendUrlHint')}
          </p>
        </div>

        <div>
          <label htmlFor="currency" className="block text-sm font-medium text-gray-700 mb-1">{t('settings.currency')}</label>
          <input
            id="currency"
            value={currency}
            onChange={e => setCurrency(e.target.value)}
            maxLength={3}
            className="w-24 border rounded-lg px-3 py-2 font-mono text-sm uppercase"
            placeholder="THB"
          />
          <p className="text-xs text-gray-400 mt-1">
            {t('settings.currencyHint')}
          </p>
        </div>

        <div>
          <label htmlFor="language" className="block text-sm font-medium text-gray-700 mb-1">{t('settings.language')}</label>
          <select
            id="language"
            value={language}
            onChange={e => setLanguage(e.target.value)}
            className="w-full border rounded-lg px-3 py-2"
          >
            <option value="en">{t('settings.languageEnglish')}</option>
            <option value="th">{t('settings.languageThai')}</option>
          </select>
          <p className="text-xs text-gray-400 mt-1">{t('settings.languageHint')}</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">{t('settings.printerUrl')}</label>
          <input
            value={printerUrl}
            onChange={e => setPrinterUrl(e.target.value)}
            className="w-full border rounded-lg px-3 py-2 font-mono text-sm"
            placeholder="http://192.168.1.x:5000"
          />
          <p className="text-xs text-gray-400 mt-1">{t('settings.printerUrlHint')}</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">{t('settings.brandColour')}</label>
          <div className="flex items-center gap-3">
            <input type="color" value={brandPrimary} onChange={e => handleBrandColour(e.target.value)} className="h-10 w-16 rounded border cursor-pointer p-0.5" />
            <span className="text-sm font-mono text-gray-600">{brandPrimary}</span>
            <button type="button" onClick={() => handleBrandColour('#ea580c')} className="text-xs text-gray-400 hover:text-gray-700 underline">{t('settings.reset')}</button>
          </div>
          <p className="text-xs text-gray-400 mt-1">{t('settings.brandColourHint')}</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">{t('settings.backgroundColour')}</label>
          <div className="flex items-center gap-3">
            <input type="color" value={brandBg} onChange={e => handleBrandBg(e.target.value)} className="h-10 w-16 rounded border cursor-pointer p-0.5" />
            <span className="text-sm font-mono text-gray-600">{brandBg}</span>
            <button type="button" onClick={() => handleBrandBg('#f9fafb')} className="text-xs text-gray-400 hover:text-gray-700 underline">{t('settings.reset')}</button>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">{t('settings.surfaceColour')}</label>
          <div className="flex items-center gap-3">
            <input type="color" value={brandSurface} onChange={e => handleBrandSurface(e.target.value)} className="h-10 w-16 rounded border cursor-pointer p-0.5" />
            <span className="text-sm font-mono text-gray-600">{brandSurface}</span>
            <button type="button" onClick={() => handleBrandSurface('#ffffff')} className="text-xs text-gray-400 hover:text-gray-700 underline">{t('settings.reset')}</button>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">{t('settings.textColour')}</label>
          <div className="flex items-center gap-3">
            <input type="color" value={brandText} onChange={e => handleBrandText(e.target.value)} className="h-10 w-16 rounded border cursor-pointer p-0.5" />
            <span className="text-sm font-mono text-gray-600">{brandText}</span>
            <button type="button" onClick={() => handleBrandText('#111827')} className="text-xs text-gray-400 hover:text-gray-700 underline">{t('settings.reset')}</button>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">{t('settings.kitchenLogo')}</label>
          {logo ? (
            <div className="flex items-center gap-4 mb-2">
              <img src={logo} alt="Logo preview" className="h-16 w-auto object-contain rounded border" />
              <button type="button" onClick={clearLogo} className="text-xs text-red-500 hover:text-red-700">{t('common.remove')}</button>
            </div>
          ) : (
            <p className="text-xs text-gray-400 mb-2">{t('settings.noLogo')}</p>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleLogoFile}
            className="text-sm text-gray-600 file:mr-3 file:py-1 file:px-3 file:rounded file:border-0 file:text-sm file:bg-brand-50 file:text-brand-700 hover:file:bg-brand-100"
          />
          <p className="text-xs text-gray-400 mt-1">{t('settings.logoHint')}</p>
        </div>

        <button type="submit" className="bg-brand-600 hover:bg-brand-700 text-white font-medium rounded-lg px-6 py-2">
          {t('settings.saveSettings')}
        </button>
      </form>
    </div>
  )
}
