/**
 * Who may read a document — expressed as a pure function so the rule can be
 * tested exhaustively, and so there is exactly one answer in the system.
 *
 * The three visibilities are not degrees of the same thing; they answer
 * different questions:
 *
 * - `ORGANIZATION` — "anyone here may see this." Any member holding a document
 *   read permission qualifies.
 * - `RESTRICTED` — "only these people, plus whoever audits the organization."
 *   Explicit grants, the uploader, and holders of `document.read.any`.
 * - `PRIVATE` — "only me and whoever I share it with." A blanket
 *   `document.read.any` does NOT open it. This is the rule that makes the
 *   visibility meaningful: if an org-wide permission could read everything,
 *   nothing would really be private, and a user who chose PRIVATE would have
 *   been misled.
 *
 * The cost of that choice is that an owner cannot read a private document
 * through the product. They can still see that it exists, who uploaded it and
 * when — enough to ask for it, or to delete it — which is the balance between
 * a user's expectation and an organization's control over its own data.
 */

export type Visibility = 'ORGANIZATION' | 'RESTRICTED' | 'PRIVATE'
export type GrantAccess = 'VIEW' | 'EDIT' | 'MANAGE'

export interface DocumentFacts {
  visibility: Visibility
  /** Membership id of the uploader, null if that member has been removed. */
  uploadedById: string | null
}

export interface ViewerFacts {
  membershipId: string
  /** `document.read.any` — the organization-wide reader permission. */
  canReadAny: boolean
  /** `document.read.scoped` — may read what is shared with them. */
  canReadScoped: boolean
  /** Highest grant this viewer holds on this specific document, if any. */
  grant: GrantAccess | null
}

export type ReadReason =
  'UPLOADER' | 'EXPLICIT_GRANT' | 'ORGANIZATION_VISIBILITY' | 'ORGANIZATION_READER'

export type ReadDecision = { allowed: true; reason: ReadReason } | { allowed: false }

export function canReadDocument(document: DocumentFacts, viewer: ViewerFacts): ReadDecision {
  // The uploader always keeps access to what they uploaded.
  if (document.uploadedById !== null && document.uploadedById === viewer.membershipId) {
    return { allowed: true, reason: 'UPLOADER' }
  }

  // An explicit grant beats visibility in every case except PRIVATE, where it
  // is in fact the only way in besides being the uploader.
  if (viewer.grant !== null) {
    return { allowed: true, reason: 'EXPLICIT_GRANT' }
  }

  if (document.visibility === 'PRIVATE') {
    return { allowed: false }
  }

  if (document.visibility === 'ORGANIZATION') {
    return viewer.canReadAny || viewer.canReadScoped
      ? { allowed: true, reason: 'ORGANIZATION_VISIBILITY' }
      : { allowed: false }
  }

  // RESTRICTED: no grant, so only an organization-wide reader gets in.
  return viewer.canReadAny ? { allowed: true, reason: 'ORGANIZATION_READER' } : { allowed: false }
}

/**
 * Who may change a document.
 *
 * Writing is stricter than reading: the `document.update` permission is
 * necessary but not sufficient for a private or restricted file — you also need
 * to be able to read it, and an EDIT or MANAGE grant rather than a VIEW.
 */
export function canWriteDocument(
  document: DocumentFacts,
  viewer: ViewerFacts & { canUpdate: boolean },
): boolean {
  if (!canReadDocument(document, viewer).allowed) return false
  if (document.uploadedById === viewer.membershipId) return true
  if (viewer.grant === 'EDIT' || viewer.grant === 'MANAGE') return true
  return viewer.canUpdate && document.visibility === 'ORGANIZATION'
}

/** Who may change who else can see it. */
export function canShareDocument(
  document: DocumentFacts,
  viewer: ViewerFacts & { canShare: boolean },
): boolean {
  if (!canReadDocument(document, viewer).allowed) return false
  if (document.uploadedById === viewer.membershipId) return true
  if (viewer.grant === 'MANAGE') return true
  return viewer.canShare && document.visibility !== 'PRIVATE'
}

/**
 * The database filter for a document listing.
 *
 * Returning a filter rather than post-filtering matters: a list that fetched
 * everything and then hid rows would paginate wrongly, count wrongly, and leak
 * through the total. This is the same rule as `canReadDocument`, expressed as a
 * query — the integration tests assert the two agree.
 */
export function visibilityFilter(viewer: {
  membershipId: string
  canReadAny: boolean
  canReadScoped: boolean
  /** Document ids this viewer holds an explicit grant on. */
  grantedDocumentIds: string[]
}) {
  const clauses: Array<Record<string, unknown>> = [
    { uploadedById: viewer.membershipId },
    ...(viewer.grantedDocumentIds.length > 0 ? [{ id: { in: viewer.grantedDocumentIds } }] : []),
  ]

  if (viewer.canReadAny) {
    clauses.push({ visibility: { in: ['ORGANIZATION', 'RESTRICTED'] } })
  } else if (viewer.canReadScoped) {
    clauses.push({ visibility: 'ORGANIZATION' })
  }

  return { OR: clauses }
}
