/**
 * Prices travel as integers in minor units (satang, cents) because menu
 * arithmetic has to be exact. Division happens here and nowhere else.
 */
export function formatMoney(minor, currency = 'THB') {
  if (minor === null || minor === undefined) return ''
  const amount = minor / 100
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount)
  } catch {
    // An unrecognised currency code should still render a readable price.
    return `${amount.toFixed(2)} ${currency}`
  }
}

/** Per-unit price of a configured line: the dish plus whatever was added to it. */
export function unitPriceOf(line) {
  if (line.unit_price === null || line.unit_price === undefined) return null
  const toppings = line.ingredients.filter(i => i.included).reduce((sum, i) => sum + (i.price_delta || 0), 0)
  const options = line.options.reduce((sum, o) => sum + (o.price_delta || 0), 0)
  return line.unit_price + toppings + options
}

export function lineTotalOf(line) {
  const unit = unitPriceOf(line)
  return unit === null ? null : unit * line.quantity
}

/**
 * Cart total, or null when nothing in it is priced. Unpriced lines are skipped
 * rather than counted as free, matching how order-service builds the total.
 */
export function cartTotalOf(cart) {
  const totals = cart.map(lineTotalOf).filter(t => t !== null)
  return totals.length === 0 ? null : totals.reduce((a, b) => a + b, 0)
}
