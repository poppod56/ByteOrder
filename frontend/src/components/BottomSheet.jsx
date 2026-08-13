import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * Sheet that slides up from the bottom edge — the phone-native way to show detail
 * without losing the list behind it.
 *
 * Scrolls internally and caps at 90vh so a long item (lots of toppings) stays
 * usable on a short screen, and locks the body scroll underneath so dragging the
 * sheet's content cannot scroll the menu behind it.
 */
export default function BottomSheet({ open, onClose, title, children, footer }) {
  const { t } = useTranslation()
  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = e => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = previous
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-end" role="dialog" aria-modal="true" aria-label={title}>
      <button
        aria-label={t('itemSheet.close')}
        onClick={onClose}
        className="absolute inset-0 bg-black/40 cursor-default"
      />
      <div className="relative w-full bg-brand-surface rounded-t-3xl shadow-2xl max-h-[90vh] flex flex-col animate-[slideUp_180ms_ease-out]">
        <style>{`@keyframes slideUp { from { transform: translateY(100%) } to { transform: translateY(0) } }`}</style>

        {/* Grab handle — signals the sheet is dismissable without spending a row on a button */}
        <div className="pt-3 pb-1 flex justify-center shrink-0">
          <div className="h-1.5 w-10 rounded-full bg-gray-300" />
        </div>

        <div className="overflow-y-auto px-5 pb-2 flex-1">{children}</div>

        {footer && (
          <div className="shrink-0 px-5 pt-3 pb-5 border-t border-gray-100 bg-brand-surface rounded-b-none">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}
