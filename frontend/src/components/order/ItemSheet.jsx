import { useEffect, useMemo, useState } from 'react'
import BottomSheet from '../BottomSheet'
import { formatMoney } from '../../lib/money'

/** A group of one is a choice between alternatives; a wider one accumulates. */
function capOf(group) {
  return group.max_select > 0 ? group.max_select : 1
}

/** `required` on its own means "at least one", even when min_select was left at 0. */
function minimumOf(group) {
  return group.required ? Math.max(1, group.min_select) : group.min_select
}

export default function ItemSheet({ item, currency, imageUrl, onClose, onAdd }) {
  const [quantity, setQuantity] = useState(1)
  const [included, setIncluded] = useState({})
  const [chosen, setChosen] = useState({})

  const groups = item?.option_groups || []

  useEffect(() => {
    if (!item) return
    setQuantity(1)
    setIncluded(Object.fromEntries(
      item.item_ingredients.map(ii => [ii.ingredient.id, ii.is_default])
    ))
    setChosen(Object.fromEntries(groups.map(g => [g.id, []])))
  }, [item])

  const unmet = groups.filter(g => (chosen[g.id] || []).length < minimumOf(g))

  const unitPrice = useMemo(() => {
    if (!item || item.price === null || item.price === undefined) return null
    const toppings = (item.item_ingredients || [])
      .filter(ii => included[ii.ingredient.id])
      .reduce((sum, ii) => sum + (ii.price_delta || 0), 0)
    const options = groups.reduce((sum, g) => sum + (chosen[g.id] || []).reduce(
      (s, id) => s + (g.options.find(o => o.id === id)?.price_delta || 0), 0,
    ), 0)
    return item.price + toppings + options
  }, [item, included, chosen])

  if (!item) return null

  function toggleOption(group, optionId) {
    setChosen(prev => {
      const picked = prev[group.id] || []
      if (picked.includes(optionId)) {
        return { ...prev, [group.id]: picked.filter(id => id !== optionId) }
      }
      if (capOf(group) === 1) return { ...prev, [group.id]: [optionId] }
      if (picked.length >= capOf(group)) return prev
      return { ...prev, [group.id]: [...picked, optionId] }
    })
  }

  function add() {
    onAdd({
      menu_item_id: item.id,
      menu_item_name: item.name,
      unit_price: item.price ?? null,
      quantity,
      ingredients: (item.item_ingredients || []).map(ii => ({
        ingredient_id: ii.ingredient.id,
        ingredient_name: ii.ingredient.name,
        included: !!included[ii.ingredient.id],
        price_delta: ii.price_delta || 0,
      })),
      options: groups.flatMap(g => (chosen[g.id] || []).map(id => {
        const option = g.options.find(o => o.id === id)
        return {
          option_id: id,
          option_name: option?.name || '',
          group_name: g.name,
          price_delta: option?.price_delta || 0,
        }
      })),
    })
  }

  const lineTotal = unitPrice === null ? null : unitPrice * quantity

  return (
    <BottomSheet
      open
      onClose={onClose}
      title={item.name}
      footer={
        <>
          {unmet.length > 0 && (
            <p className="text-sm text-gray-500 mb-2 text-center">
              Please choose: {unmet.map(g => g.name).join(', ')}
            </p>
          )}
          <button
            onClick={add}
            disabled={unmet.length > 0}
            className="w-full bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white font-bold py-3.5 rounded-xl text-lg flex items-center justify-center gap-2"
          >
            <span>Add {quantity} to cart</span>
            {lineTotal !== null && <span className="opacity-80">· {formatMoney(lineTotal, currency)}</span>}
          </button>
        </>
      }
    >
      {imageUrl && (
        <img
          src={imageUrl}
          alt={item.name}
          className="w-full h-44 object-cover rounded-2xl mb-4"
        />
      )}

      <div className="flex items-start justify-between gap-4 mb-1">
        <h2 className="text-2xl font-bold text-brand-text">{item.name}</h2>
        {item.price !== null && item.price !== undefined && (
          <p className="text-xl font-bold text-brand-600 whitespace-nowrap">
            {formatMoney(item.price, currency)}
          </p>
        )}
      </div>
      {item.description && <p className="text-gray-500 mb-5">{item.description}</p>}

      {groups.map(group => {
        const picked = chosen[group.id] || []
        const cap = capOf(group)
        const minimum = minimumOf(group)
        return (
          <div key={group.id} className="mb-5">
            <div className="flex items-baseline justify-between mb-1">
              <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">{group.name}</h3>
              {minimum > 0 && <span className="text-xs font-semibold text-brand-600">Required</span>}
            </div>
            <p className="text-xs text-gray-400 mb-2">
              {cap === 1 ? 'Choose one' : `Choose up to ${cap}`}
              {minimum > 1 && ` — at least ${minimum}`}
            </p>
            <div className="flex flex-wrap gap-2">
              {group.options.map(option => {
                const on = picked.includes(option.id)
                // Greyed rather than hidden at the cap, so the limit is visible.
                const atCap = !on && cap > 1 && picked.length >= cap
                return (
                  <button
                    key={option.id}
                    onClick={() => toggleOption(group, option.id)}
                    disabled={atCap}
                    className={`px-4 py-2 rounded-full font-medium text-sm border-2 ${
                      on
                        ? 'bg-brand-600 border-brand-600 text-white'
                        : atCap
                          ? 'bg-white border-gray-100 text-gray-300'
                          : 'bg-white border-gray-200 text-gray-500'
                    }`}
                  >
                    {option.name}
                    {option.price_delta ? ` +${formatMoney(option.price_delta, currency)}` : ''}
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}

      {item.item_ingredients?.length > 0 && (
        <div className="mb-5">
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">Toppings</h3>
          <div className="flex flex-wrap gap-2">
            {item.item_ingredients.map(ii => {
              const on = !!included[ii.ingredient.id]
              return (
                <button
                  key={ii.ingredient.id}
                  onClick={() => setIncluded(prev => ({ ...prev, [ii.ingredient.id]: !on }))}
                  className={`px-4 py-2 rounded-full font-medium text-sm border-2 ${
                    on ? 'bg-brand-600 border-brand-600 text-white' : 'bg-white border-gray-200 text-gray-500'
                  }`}
                >
                  {ii.ingredient.name}
                  {ii.price_delta ? ` +${formatMoney(ii.price_delta, currency)}` : ''}
                </button>
              )
            })}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between py-2">
        <span className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Quantity</span>
        <div className="flex items-center gap-4">
          <button
            aria-label="Fewer"
            onClick={() => setQuantity(q => Math.max(1, q - 1))}
            disabled={quantity <= 1}
            className="w-11 h-11 rounded-full border-2 border-gray-200 text-xl font-bold text-gray-600 disabled:text-gray-300"
          >
            −
          </button>
          <span className="text-xl font-bold w-8 text-center" data-testid="quantity">{quantity}</span>
          <button
            aria-label="More"
            onClick={() => setQuantity(q => Math.min(99, q + 1))}
            disabled={quantity >= 99}
            className="w-11 h-11 rounded-full border-2 border-brand-600 text-xl font-bold text-brand-600 disabled:opacity-40"
          >
            +
          </button>
        </div>
      </div>
    </BottomSheet>
  )
}
