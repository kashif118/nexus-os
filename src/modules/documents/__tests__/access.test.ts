import { describe, expect, it } from 'vitest'

import {
  canReadDocument,
  canShareDocument,
  canWriteDocument,
  visibilityFilter,
  type DocumentFacts,
  type ViewerFacts,
} from '../access'

const ME = 'm_me'
const SOMEONE_ELSE = 'm_other'

const doc = (
  visibility: DocumentFacts['visibility'],
  uploadedById = SOMEONE_ELSE,
): DocumentFacts => ({
  visibility,
  uploadedById,
})

const viewer = (overrides: Partial<ViewerFacts> = {}): ViewerFacts => ({
  membershipId: ME,
  canReadAny: false,
  canReadScoped: true,
  grant: null,
  ...overrides,
})

describe('canReadDocument', () => {
  it('lets the uploader read their own private file', () => {
    expect(canReadDocument(doc('PRIVATE', ME), viewer())).toEqual({
      allowed: true,
      reason: 'UPLOADER',
    })
  })

  it('does NOT let an organization-wide reader open a private file', () => {
    // This is the rule that makes PRIVATE mean something. If document.read.any
    // could open it, a user who chose PRIVATE would have been misled.
    expect(canReadDocument(doc('PRIVATE'), viewer({ canReadAny: true }))).toEqual({
      allowed: false,
    })
  })

  it('lets someone with an explicit grant open a private file', () => {
    expect(canReadDocument(doc('PRIVATE'), viewer({ grant: 'VIEW' }))).toEqual({
      allowed: true,
      reason: 'EXPLICIT_GRANT',
    })
  })

  it('lets an organization-wide reader open a restricted file', () => {
    expect(canReadDocument(doc('RESTRICTED'), viewer({ canReadAny: true }))).toEqual({
      allowed: true,
      reason: 'ORGANIZATION_READER',
    })
  })

  it('does not let a scoped reader open a restricted file without a grant', () => {
    expect(canReadDocument(doc('RESTRICTED'), viewer({ canReadScoped: true }))).toEqual({
      allowed: false,
    })
  })

  it('lets any reader open an organization-visible file', () => {
    expect(canReadDocument(doc('ORGANIZATION'), viewer()).allowed).toBe(true)
    expect(canReadDocument(doc('ORGANIZATION'), viewer({ canReadAny: true })).allowed).toBe(true)
  })

  it('refuses someone with no document read permission at all', () => {
    expect(
      canReadDocument(doc('ORGANIZATION'), viewer({ canReadAny: false, canReadScoped: false })),
    ).toEqual({ allowed: false })
  })

  it('does not treat a null uploader as a match for a null membership', () => {
    // A removed member leaves uploadedById null. That must never match.
    const orphan: DocumentFacts = { visibility: 'PRIVATE', uploadedById: null }
    expect(canReadDocument(orphan, viewer({ canReadAny: true }))).toEqual({ allowed: false })
  })
})

describe('canWriteDocument', () => {
  it('lets the uploader edit their own file', () => {
    expect(canWriteDocument(doc('PRIVATE', ME), { ...viewer(), canUpdate: false })).toBe(true)
  })

  it('lets an EDIT grant edit', () => {
    expect(
      canWriteDocument(doc('RESTRICTED'), { ...viewer(), grant: 'EDIT', canUpdate: false }),
    ).toBe(true)
  })

  it('does not let a VIEW grant edit', () => {
    expect(
      canWriteDocument(doc('RESTRICTED'), { ...viewer(), grant: 'VIEW', canUpdate: true }),
    ).toBe(false)
  })

  it('lets the update permission edit an organization-visible file', () => {
    expect(canWriteDocument(doc('ORGANIZATION'), { ...viewer(), canUpdate: true })).toBe(true)
  })

  it('never lets someone edit what they cannot read', () => {
    expect(
      canWriteDocument(doc('PRIVATE'), { ...viewer(), canReadAny: true, canUpdate: true }),
    ).toBe(false)
  })
})

describe('canShareDocument', () => {
  it('lets the uploader share', () => {
    expect(canShareDocument(doc('PRIVATE', ME), { ...viewer(), canShare: false })).toBe(true)
  })

  it('lets a MANAGE grant share', () => {
    expect(
      canShareDocument(doc('RESTRICTED'), { ...viewer(), grant: 'MANAGE', canShare: false }),
    ).toBe(true)
  })

  it('does not let the share permission alone re-share someone else’s private file', () => {
    expect(canShareDocument(doc('PRIVATE'), { ...viewer(), canShare: true })).toBe(false)
  })
})

describe('visibilityFilter', () => {
  it('always includes your own uploads', () => {
    const filter = visibilityFilter({
      membershipId: ME,
      canReadAny: false,
      canReadScoped: false,
      grantedDocumentIds: [],
    })

    expect(filter.OR).toEqual([{ uploadedById: ME }])
  })

  it('includes granted ids and organization-visible documents for a scoped reader', () => {
    const filter = visibilityFilter({
      membershipId: ME,
      canReadAny: false,
      canReadScoped: true,
      grantedDocumentIds: ['d1', 'd2'],
    })

    expect(filter.OR).toEqual([
      { uploadedById: ME },
      { id: { in: ['d1', 'd2'] } },
      { visibility: 'ORGANIZATION' },
    ])
  })

  it('includes restricted documents for an organization-wide reader, but never private ones', () => {
    const filter = visibilityFilter({
      membershipId: ME,
      canReadAny: true,
      canReadScoped: true,
      grantedDocumentIds: [],
    })

    expect(filter.OR).toContainEqual({ visibility: { in: ['ORGANIZATION', 'RESTRICTED'] } })
    expect(JSON.stringify(filter)).not.toContain('PRIVATE')
  })
})

describe('the filter and the predicate agree', () => {
  /**
   * The list query and the single-document check are two implementations of one
   * rule, and a disagreement between them is exactly how a document leaks into
   * a list. This table walks every combination and asserts they match.
   */
  const visibilities = ['ORGANIZATION', 'RESTRICTED', 'PRIVATE'] as const

  it('for every visibility, permission and grant combination', () => {
    for (const visibility of visibilities) {
      for (const canReadAny of [true, false]) {
        for (const canReadScoped of [true, false]) {
          for (const granted of [true, false]) {
            for (const mine of [true, false]) {
              const document = doc(visibility, mine ? ME : SOMEONE_ELSE)
              const predicate = canReadDocument(document, {
                membershipId: ME,
                canReadAny,
                canReadScoped,
                grant: granted ? 'VIEW' : null,
              }).allowed

              const filter = visibilityFilter({
                membershipId: ME,
                canReadAny,
                canReadScoped,
                grantedDocumentIds: granted ? ['d1'] : [],
              })

              // Evaluate the filter by hand against this one document.
              const matched = filter.OR.some((clause) => {
                if ('uploadedById' in clause) return mine
                if ('id' in clause) return granted
                const visibilityClause = (clause as { visibility?: unknown }).visibility
                if (typeof visibilityClause === 'string') return visibility === visibilityClause
                if (visibilityClause && typeof visibilityClause === 'object') {
                  const list = (visibilityClause as { in?: string[] }).in ?? []
                  return list.includes(visibility)
                }
                return false
              })

              expect(
                matched,
                `visibility=${visibility} any=${canReadAny} scoped=${canReadScoped} granted=${granted} mine=${mine}`,
              ).toBe(predicate)
            }
          }
        }
      }
    }
  })
})
