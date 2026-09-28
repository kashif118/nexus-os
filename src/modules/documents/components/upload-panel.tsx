'use client'

import { Upload } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'

import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/select'

/**
 * Upload panel.
 *
 * Posts to the route handler rather than a Server Action: Server Action
 * arguments travel through the React flight payload, which is the wrong
 * transport for a multi-megabyte file. `XMLHttpRequest` rather than `fetch`
 * because it reports upload progress, and a 20 MB upload with no feedback feels
 * broken.
 *
 * Nothing here decides what may be uploaded. The server re-checks the size, the
 * declared type and the actual leading bytes; this only avoids a pointless
 * round trip for the obvious cases.
 */
export function UploadPanel({
  orgSlug,
  folders,
  currentFolderId,
}: {
  orgSlug: string
  folders: Array<{ id: string; name: string; path: string }>
  currentFolderId?: string | undefined
}) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [state, setState] = useState<
    | { status: 'idle' }
    | { status: 'uploading'; percent: number }
    | { status: 'error'; message: string }
  >({ status: 'idle' })
  const [visibility, setVisibility] = useState('ORGANIZATION')
  const [folderId, setFolderId] = useState(currentFolderId ?? '')

  const upload = (file: File) => {
    const form = new FormData()
    form.set('file', file)
    form.set('visibility', visibility)
    if (folderId) form.set('folderId', folderId)

    const request = new XMLHttpRequest()
    request.open('POST', `/api/orgs/${orgSlug}/documents`)

    request.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable) return
      setState({ status: 'uploading', percent: Math.round((event.loaded / event.total) * 100) })
    })

    request.addEventListener('load', () => {
      if (request.status >= 200 && request.status < 300) {
        setState({ status: 'idle' })
        if (inputRef.current) inputRef.current.value = ''
        router.refresh()
        return
      }

      let message = 'The upload failed.'
      try {
        const parsed: unknown = JSON.parse(request.responseText)
        if (parsed && typeof parsed === 'object' && 'error' in parsed) {
          message = String((parsed as { error: unknown }).error)
        }
      } catch {
        // Keep the generic message.
      }
      setState({ status: 'error', message })
    })

    request.addEventListener('error', () =>
      setState({ status: 'error', message: 'The upload could not reach the server.' }),
    )

    setState({ status: 'uploading', percent: 0 })
    request.send(form)
  }

  return (
    <div className="space-y-3">
      {state.status === 'error' ? <Alert variant="destructive">{state.message}</Alert> : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="upload-visibility">Visibility</Label>
          <NativeSelect
            id="upload-visibility"
            value={visibility}
            onChange={(event) => setVisibility(event.target.value)}
          >
            <option value="ORGANIZATION">Everyone in the organization</option>
            <option value="RESTRICTED">Only people I share it with, plus admins</option>
            <option value="PRIVATE">Only me and people I share it with</option>
          </NativeSelect>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="upload-folder">Folder</Label>
          <NativeSelect
            id="upload-folder"
            value={folderId}
            onChange={(event) => setFolderId(event.target.value)}
          >
            <option value="">No folder</option>
            {folders.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.path}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>

      <p className="text-muted-foreground text-xs">
        {visibility === 'PRIVATE'
          ? 'A private file is not readable by administrators. Only you and people you share it with can open it.'
          : visibility === 'RESTRICTED'
            ? 'Visible to people you share it with, and to anyone who can read every document.'
            : 'Visible to every member who can read documents.'}
      </p>

      <input
        ref={inputRef}
        type="file"
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) upload(file)
        }}
      />

      <Button
        type="button"
        size="sm"
        disabled={state.status === 'uploading'}
        onClick={() => inputRef.current?.click()}
      >
        <Upload className="size-3.5" aria-hidden="true" />
        {state.status === 'uploading' ? `Uploading ${state.percent}%` : 'Choose a file'}
      </Button>

      {state.status === 'uploading' ? (
        <div
          className="bg-muted h-1.5 w-full overflow-hidden rounded-full"
          role="progressbar"
          aria-valuenow={state.percent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="bg-primary h-full transition-all"
            style={{ width: `${state.percent}%` }}
          />
        </div>
      ) : null}
    </div>
  )
}
