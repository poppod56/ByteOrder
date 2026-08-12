/**
 * Prices are integers in minor units (satang, cents) so menu arithmetic is exact.
 * Division happens here and nowhere else.
 */
export function formatMoney(minor, currency = 'THB') {
  if (minor === null || minor === undefined) return ''
  const amount = minor / 100
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount)
  } catch {
    return `${amount.toFixed(2)} ${currency}`
  }
}

/** Major-unit text from an input box to minor units, or null when left blank. */
export function parseMoney(text) {
  const trimmed = String(text).trim()
  if (trimmed === '') return null
  const amount = Number(trimmed)
  if (!Number.isFinite(amount) || amount < 0) return null
  return Math.round(amount * 100)
}

/** Minor units back to the plain major-unit string an input box wants. */
export function toMoneyInput(minor) {
  return minor === null || minor === undefined ? '' : (minor / 100).toFixed(2)
}
