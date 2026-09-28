'use client'

import { Trash2 } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useActionState, useEffect } from 'react'

import { Field } from '@/components/forms/field'
import { SubmitButton } from '@/components/forms/submit-button'
import { Alert } from '@/components/ui/alert'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'

import {
  createFolderAction,
  deleteDocumentAction,
  deleteFolderAction,
  revokeGrantAction,
  shareDocumentAction,
  updateDocumentAction,
  type FormState,
} from '../actions'

/** Create a folder. */
export function FolderForm({
  orgSlug,
  folders,
}: {
  orgSlug: string
  folders: Array<{ id: string; path: string }>
}) {
  const [state, formAction] = useActionState<FormState, FormData>(
    createFolderAction.bind(null, orgSlug),
    null,
  )
  const fields = state && !state.ok ? state.error.fields : undefined

  return (
    <form action={formAction} className="space-y-3" noValidate>
      {state && !state.ok && !state.error.fields ? (
        <Alert variant="destructive">{state.error.message}</Alert>
      ) : null}

      <Field name="name" label="Folder name" required errors={fields?.name} />

      <div className="space-y-1.5">
        <Label htmlFor="parentId">Inside</Label>
        <NativeSelect id="parentId" name="parentId" defaultValue="">
          <option value="">Top level</option>
          {folders.map((folder) => (
            <option key={folder.id} value={folder.id}>
              {folder.path}
            </option>
          ))}
        </NativeSelect>
      </div>

      <SubmitButton size="sm" variant="outline" pendingLabel="Creating…">
        Create folder
      </SubmitButton>
    </form>
  )
}

/** Delete an empty folder. */
export function DeleteFolderButton({ orgSlug, folderId }: { orgSlug: string; folderId: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(
    deleteFolderAction.bind(null, orgSlug),
    null,
  )

  return (
    <form action={formAction} className="space-y-2">
      {state && !state.ok ? <Alert variant="destructive">{state.error.message}</Alert> : null}
      <input type="hidden" name="id" value={folderId} />
      <SubmitButton size="sm" variant="ghost" pendingLabel="Deleting…">
        <Trash2 className="size-3.5" aria-hidden="true" />
        Delete folder
      </SubmitButton>
    </form>
  )
}

/** Rename, describe, move and change the visibility of a document. */
export function DocumentSettingsForm({
  orgSlug,
  document,
  folders,
  canChangeVisibility,
}: {
  orgSlug: string
  document: {
    id: string
    name: string
    description: string | null
    folderId: string | null
    visibility: string
  }
  folders: Array<{ id: string; path: string }>
  canChangeVisibility: boolean
}) {
  const [state, formAction] = useActionState<FormState, FormData>(
    updateDocumentAction.bind(null, orgSlug),
    null,
  )
  const fields = state && !state.ok ? state.error.fields : undefined

  return (
    <form action={formAction} className="space-y-3" noValidate>
      {state?.ok ? <Alert variant="success">{state.data.message}</Alert> : null}
      {state && !state.ok && !state.error.fields ? (
        <Alert variant="destructive">{state.error.message}</Alert>
      ) : null}

      <input type="hidden" name="id" value={document.id} />

      <Field name="name" label="Name" required defaultValue={document.name} errors={fields?.name} />

      <div className="space-y-1.5">
        <Label htmlFor="description">Description</Label>
        <Textarea
          id="description"
          name="description"
          rows={2}
          defaultValue={document.description ?? ''}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="folderId">Folder</Label>
        <NativeSelect id="folderId" name="folderId" defaultValue={document.folderId ?? ''}>
          <option value="">No folder</option>
          {folders.map((folder) => (
            <option key={folder.id} value={folder.id}>
              {folder.path}
            </option>
          ))}
        </NativeSelect>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="visibility">Visibility</Label>
        <NativeSelect
          id="visibility"
          name="visibility"
          defaultValue={document.visibility}
          disabled={!canChangeVisibility}
        >
          <option value="ORGANIZATION">Everyone in the organization</option>
          <option value="RESTRICTED">Shared people, plus admins</option>
          <option value="PRIVATE">Only me and people I share it with</option>
        </NativeSelect>
        {!canChangeVisibility ? (
          <p className="text-muted-foreground text-xs">
            Only someone who can share this document may widen who sees it.
          </p>
        ) : null}
      </div>

      <SubmitButton size="sm" pendingLabel="Saving…">
        Save
      </SubmitButton>
    </form>
  )
}

/** Grant a person, team or role access to one document. */
export function ShareForm({
  orgSlug,
  documentId,
  people,
  teams,
  roles,
}: {
  orgSlug: string
  documentId: string
  people: Array<{ id: string; name: string }>
  teams: Array<{ id: string; name: string }>
  roles: Array<{ id: string; name: string }>
}) {
  const [state, formAction] = useActionState<FormState, FormData>(
    shareDocumentAction.bind(null, orgSlug),
    null,
  )

  return (
    <form action={formAction} className="space-y-3" noValidate>
      {state?.ok ? <Alert variant="success">{state.data.message}</Alert> : null}
      {state && !state.ok ? <Alert variant="destructive">{state.error.message}</Alert> : null}

      <input type="hidden" name="documentId" value={documentId} />

      <div className="space-y-1.5">
        <Label htmlFor="subject">Share with</Label>
        {/*
          Subject type and id travel in one field and are split by the form so
          the two cannot disagree — a USER type with a TEAM id would otherwise
          be a valid-looking request.
        */}
        <NativeSelect
          id="subject"
          name="subject"
          defaultValue=""
          onChange={(event) => {
            const [type, id] = event.target.value.split(':')
            const form = event.target.form
            if (!form) return
            ;(form.elements.namedItem('subjectType') as HTMLInputElement).value = type ?? ''
            ;(form.elements.namedItem('subjectId') as HTMLInputElement).value = id ?? ''
          }}
        >
          <option value="">Choose someone…</option>
          <optgroup label="People">
            {people.map((person) => (
              <option key={person.id} value={`USER:${person.id}`}>
                {person.name}
              </option>
            ))}
          </optgroup>
          <optgroup label="Teams">
            {teams.map((team) => (
              <option key={team.id} value={`TEAM:${team.id}`}>
                {team.name}
              </option>
            ))}
          </optgroup>
          <optgroup label="Roles">
            {roles.map((role) => (
              <option key={role.id} value={`ROLE:${role.id}`}>
                {role.name}
              </option>
            ))}
          </optgroup>
        </NativeSelect>
      </div>

      <input type="hidden" name="subjectType" defaultValue="" />
      <input type="hidden" name="subjectId" defaultValue="" />

      <div className="space-y-1.5">
        <Label htmlFor="access">Access</Label>
        <NativeSelect id="access" name="access" defaultValue="VIEW">
          <option value="VIEW">Can view</option>
          <option value="EDIT">Can edit</option>
          <option value="MANAGE">Can manage sharing</option>
        </NativeSelect>
      </div>

      <SubmitButton size="sm" variant="outline" pendingLabel="Sharing…">
        Share
      </SubmitButton>
    </form>
  )
}

/** Remove one grant. */
export function RevokeGrantButton({
  orgSlug,
  documentId,
  grantId,
}: {
  orgSlug: string
  documentId: string
  grantId: string
}) {
  const [state, formAction] = useActionState<FormState, FormData>(
    revokeGrantAction.bind(null, orgSlug),
    null,
  )

  return (
    <form action={formAction}>
      {state && !state.ok ? <Alert variant="destructive">{state.error.message}</Alert> : null}
      <input type="hidden" name="documentId" value={documentId} />
      <input type="hidden" name="grantId" value={grantId} />
      <SubmitButton size="sm" variant="ghost" pendingLabel="Removing…">
        Remove
      </SubmitButton>
    </form>
  )
}

/** Delete a document, returning to the list afterwards. */
export function DeleteDocumentButton({
  orgSlug,
  documentId,
}: {
  orgSlug: string
  documentId: string
}) {
  const router = useRouter()
  const [state, formAction] = useActionState<FormState, FormData>(
    deleteDocumentAction.bind(null, orgSlug),
    null,
  )

  useEffect(() => {
    if (state?.ok) router.replace(`/${orgSlug}/documents`)
  }, [state, orgSlug, router])

  return (
    <form action={formAction} className="space-y-2">
      {state && !state.ok ? <Alert variant="destructive">{state.error.message}</Alert> : null}
      <input type="hidden" name="id" value={documentId} />
      <SubmitButton size="sm" variant="destructive" pendingLabel="Deleting…">
        Delete document
      </SubmitButton>
    </form>
  )
}
