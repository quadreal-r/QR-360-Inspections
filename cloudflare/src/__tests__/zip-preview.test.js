import { describe, expect, it } from 'vitest'
import { sanitizePhotoName } from '../zip-preview.js'

describe('sanitizePhotoName', () => {
  it('accepts a plain jpg/png basename', () => {
    expect(sanitizePhotoName('photo1.jpg')).toBe('photo1.jpg')
    expect(sanitizePhotoName('Photo_2.PNG')).toBe('Photo_2.PNG')
  })

  it('strips leading path segments and keeps only the basename', () => {
    expect(sanitizePhotoName('sub/dir/photo.jpg')).toBe('photo.jpg')
    expect(sanitizePhotoName('C:\\Users\\x\\photo.jpg')).toBe('photo.jpg')
    expect(sanitizePhotoName('/etc/passwd/photo.jpg')).toBe('photo.jpg')
  })

  it('rejects path-traversal-only names, empty names, and null bytes', () => {
    expect(sanitizePhotoName('../../etc/passwd')).toBeNull()
    expect(sanitizePhotoName('..')).toBeNull()
    expect(sanitizePhotoName('.')).toBeNull()
    expect(sanitizePhotoName('')).toBeNull()
    expect(sanitizePhotoName('evil\0.jpg')).toBeNull()
  })

  it('rejects non-image extensions', () => {
    expect(sanitizePhotoName('photo.exe')).toBeNull()
    expect(sanitizePhotoName('photo')).toBeNull()
    expect(sanitizePhotoName('photo.jpg.exe')).toBeNull()
  })
})
