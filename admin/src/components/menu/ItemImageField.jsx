import { useEffect, useRef, useState } from 'react'
import api from '../../lib/api'

const MAX_BYTES = 512 * 1024
const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/**
 * Upload, replace and remove the photo for one menu item.
 *
 * The preview is fetched through the API client rather than pointed at with an
 * <img src>: every admin route sits behind auth, and a plain image request
 * carries no Authorization header, so it would come back 401.
 */
export default function ItemImageField({ item, onChanged }) {
  const [objectUrl, setObjectUrl] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const fileInput = useRef(null)

  useEffect(() => {
    if (!item.has_image) {
      setObjectUrl(null)
      return
    }
    let revoked = false
    let url = null
    api.get(`/menu/items/${item.id}/image`, { responseType: 'blob' })
      .then(({ data }) => {
        if (revoked) return
        url = URL.createObjectURL(data)
        setObjectUrl(url)
      })
      .catch(() => setObjectUrl(null))
    return () => {
      revoked = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [item.id, item.has_image])

  async function handleFile(event) {
    const file = event.target.files?.[0]
    if (!file) return
    setError('')

    if (!ACCEPTED.includes(file.type)) {
      setError('Use a PNG, JPEG, WebP or GIF.')
      event.target.value = ''
      return
    }
    if (file.size > MAX_BYTES) {
      setError(`Image must be under ${MAX_BYTES / 1024} KB (this one is ${Math.round(file.size / 1024)} KB).`)
      event.target.value = ''
      return
    }

    setBusy(true)
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result)
        reader.onerror = () => reject(new Error('Could not read that file'))
        reader.readAsDataURL(file)
      })
      await api.put(`/menu/items/${item.id}/image`, { data_url: dataUrl })
      onChanged()
    } catch (err) {
      setError(err.response?.data?.detail || 'Upload failed.')
    } finally {
      setBusy(false)
      // Cleared so picking the same file again still fires a change event.
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  async function handleRemove() {
    if (!confirm(`Remove the photo for "${item.name}"?`)) return
    setError('')
    setBusy(true)
    try {
      await api.delete(`/menu/items/${item.id}/image`)
      onChanged()
    } catch (err) {
      setError(err.response?.data?.detail || 'Could not remove the photo.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-start gap-3">
      {objectUrl ? (
        <img
          src={objectUrl}
          alt={`${item.name} photo`}
          className="w-20 h-20 rounded-lg object-cover border shrink-0"
        />
      ) : (
        <div className="w-20 h-20 rounded-lg border border-dashed border-gray-300 flex items-center justify-center text-2xl text-gray-300 shrink-0">
          🍽
        </div>
      )}

      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-xs font-semibold text-brand-600 hover:text-brand-700 cursor-pointer">
            {item.has_image ? 'Replace photo' : 'Add photo'}
            <input
              ref={fileInput}
              type="file"
              accept={ACCEPTED.join(',')}
              onChange={handleFile}
              disabled={busy}
              className="hidden"
            />
          </label>
          {item.has_image && (
            <button
              onClick={handleRemove}
              disabled={busy}
              className="text-xs text-red-500 hover:text-red-700 disabled:opacity-40"
            >
              Remove photo
            </button>
          )}
          {busy && <span className="text-xs text-gray-400">Working…</span>}
        </div>
        <p className="text-xs text-gray-400 mt-1">PNG, JPEG, WebP or GIF · max 512 KB</p>
        {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
      </div>
    </div>
  )
}
