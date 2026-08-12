import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../../lib/api', () => ({
  default: {
    get: vi.fn(),
    put: vi.fn(() => Promise.resolve({ data: {} })),
    delete: vi.fn(() => Promise.resolve({})),
  },
}))

import api from '../../lib/api'
import ItemImageField from './ItemImageField'

const WITHOUT = { id: 5, name: 'Cheeseburger', has_image: false }
const WITH = { ...WITHOUT, has_image: true }

function pngFile(name = 'burger.png', bytes = 1024, type = 'image/png') {
  return new File([new Uint8Array(bytes)], name, { type })
}

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockResolvedValue({ data: new Blob([new Uint8Array(4)], { type: 'image/png' }) })
  global.URL.createObjectURL = vi.fn(() => 'blob:preview')
  global.URL.revokeObjectURL = vi.fn()
})

describe('ItemImageField', () => {
  it('offers to add a photo when there is none', () => {
    render(<ItemImageField item={WITHOUT} onChanged={vi.fn()} />)

    expect(screen.getByText('Add photo')).toBeInTheDocument()
    expect(screen.queryByText('Remove photo')).not.toBeInTheDocument()
    expect(api.get).not.toHaveBeenCalled()
  })

  it('fetches the preview through the API client rather than an img src', async () => {
    // Admin routes are behind auth, and a plain image request sends no
    // Authorization header — it would come back 401.
    render(<ItemImageField item={WITH} onChanged={vi.fn()} />)

    await waitFor(() => {
      expect(api.get).toHaveBeenCalledWith('/menu/items/5/image', { responseType: 'blob' })
    })
    expect(await screen.findByAltText('Cheeseburger photo')).toHaveAttribute('src', 'blob:preview')
  })

  it('uploads a chosen file as a data URL', async () => {
    const onChanged = vi.fn()
    render(<ItemImageField item={WITHOUT} onChanged={onChanged} />)

    await userEvent.upload(screen.getByText('Add photo').querySelector('input'), pngFile())

    await waitFor(() => expect(api.put).toHaveBeenCalled())
    const [url, body] = api.put.mock.calls[0]
    expect(url).toBe('/menu/items/5/image')
    expect(body.data_url).toMatch(/^data:image\/png;base64,/)
    expect(onChanged).toHaveBeenCalled()
  })

  it('replaces an existing photo through the same control', async () => {
    render(<ItemImageField item={WITH} onChanged={vi.fn()} />)

    await userEvent.upload(screen.getByText('Replace photo').querySelector('input'), pngFile())

    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/menu/items/5/image', expect.anything()))
  })

  it('removes a photo once confirmed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const onChanged = vi.fn()
    render(<ItemImageField item={WITH} onChanged={onChanged} />)

    await userEvent.click(screen.getByText('Remove photo'))

    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/menu/items/5/image'))
    expect(onChanged).toHaveBeenCalled()
  })

  it('keeps the photo when the removal is declined', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<ItemImageField item={WITH} onChanged={vi.fn()} />)

    await userEvent.click(screen.getByText('Remove photo'))

    expect(api.delete).not.toHaveBeenCalled()
  })

  it('rejects a file type the API would refuse, without uploading it', async () => {
    render(<ItemImageField item={WITHOUT} onChanged={vi.fn()} />)

    // applyAccept is off deliberately: the accept attribute already keeps an SVG
    // out of the file picker, so this exercises the guard behind it — the path a
    // drag-drop or an "All files" picker can still reach.
    await userEvent.upload(
      screen.getByText('Add photo').querySelector('input'),
      new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' }),
      { applyAccept: false },
    )

    expect(await screen.findByText(/PNG, JPEG, WebP or GIF\./)).toBeInTheDocument()
    expect(api.put).not.toHaveBeenCalled()
  })

  it('rejects an oversized file before spending the upload', async () => {
    render(<ItemImageField item={WITHOUT} onChanged={vi.fn()} />)

    await userEvent.upload(screen.getByText('Add photo').querySelector('input'), pngFile('big.png', 600 * 1024))

    expect(await screen.findByText(/must be under 512 KB/)).toBeInTheDocument()
    expect(api.put).not.toHaveBeenCalled()
  })

  it('surfaces what the API said when an upload fails', async () => {
    api.put.mockRejectedValue({ response: { data: { detail: "Unsupported image type 'image/tiff'" } } })
    render(<ItemImageField item={WITHOUT} onChanged={vi.fn()} />)

    await userEvent.upload(screen.getByText('Add photo').querySelector('input'), pngFile())

    expect(await screen.findByText("Unsupported image type 'image/tiff'")).toBeInTheDocument()
  })

  it('falls back to a placeholder when the preview cannot be loaded', async () => {
    api.get.mockRejectedValue(new Error('boom'))
    render(<ItemImageField item={WITH} onChanged={vi.fn()} />)

    await waitFor(() => expect(api.get).toHaveBeenCalled())
    expect(screen.queryByAltText('Cheeseburger photo')).not.toBeInTheDocument()
  })
})
