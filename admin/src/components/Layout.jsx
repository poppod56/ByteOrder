import { useState, useEffect } from 'react'
import { Outlet, NavLink } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import api from '../lib/api'
import i18n, { SUPPORTED_LANGUAGES } from '../i18n'

// onSignOut is supplied by the mode-specific wrapper in App: Clerk's signOut in
// cloud mode, clearing the local JWT in self-hosted. Keeping it out of here is
// what lets this component render in both.
export default function Layout({ onSignOut }) {
  const { t } = useTranslation()
  const [kitchenName, setKitchenName] = useState('ByteOrder')

  const nav = [
    { to: '/orders', label: t('layout.navOrders') },
    { to: '/cashier', label: t('layout.navCashier') },
    { to: '/history', label: t('layout.navHistory') },
    { to: '/menu', label: t('layout.navMenu') },
    { to: '/ingredients', label: t('layout.navIngredients') },
    { to: '/tables', label: t('layout.navTables') },
    { to: '/printers', label: t('layout.navPrinters') },
    { to: '/settings', label: t('layout.navSettings') },
  ]

  useEffect(() => {
    const apply = (key, prop) =>
      api.get(`/settings/${key}`).then(({ data }) => {
        if (data.value) document.documentElement.style.setProperty(prop, data.value)
      }).catch(() => {})
    apply('brand_primary', '--brand-primary')
    apply('brand_bg',      '--brand-bg')
    apply('brand_surface', '--brand-surface')
    apply('brand_text',    '--brand-text')
    api.get('/settings/kitchen_name').then(({ data }) => {
      if (data.value) {
        setKitchenName(data.value)
        document.title = `${data.value} ${t('layout.adminSuffix')}`
      }
    }).catch(() => {})
    api.get('/settings/default_language').then(({ data }) => {
      const lang = data.value
      const resolved = SUPPORTED_LANGUAGES.includes(lang) ? lang : 'en'
      i18n.changeLanguage(resolved)
      document.documentElement.lang = resolved
    }).catch(() => {})
  }, [])

  return (
    <div className="min-h-screen bg-brand-bg flex flex-col">
      <header className="bg-brand-600 text-white shadow">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <span className="text-xl font-bold tracking-tight">{kitchenName} {t('layout.adminSuffix')}</span>
          <button onClick={onSignOut} className="text-sm underline hover:no-underline">{t('layout.logOut')}</button>
        </div>
      </header>

      <nav className="bg-white border-b shadow-sm">
        <div className="max-w-7xl mx-auto px-4 flex gap-1">
          {nav.map(({ to, label }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                  isActive
                    ? 'border-brand-600 text-brand-600'
                    : 'border-transparent text-gray-600 hover:text-brand-600'
                }`
              }
            >
              {label}
            </NavLink>
          ))}
        </div>
      </nav>

      <main className="flex-1 max-w-7xl mx-auto w-full px-4 py-6">
        <Outlet />
      </main>
    </div>
  )
}
