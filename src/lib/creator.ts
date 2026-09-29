/**
 * Creator attribution.
 *
 * One definition, used by the landing page footer and the About screen, so the
 * name and contact address cannot drift between them.
 *
 * Deliberately minimal: a name, an email, and a role. No social links, no
 * company, no avatar URL — inventing any of those would be inventing facts, and
 * an attribution block full of dead links is worse than a plain one.
 *
 * `avatarUrl` is `null` and the About screen renders initials in its place. It
 * is here so that adding a real image later is a one-line change rather than a
 * component rewrite: drop a file into `public/` and set the path.
 */

export interface Creator {
  name: string
  email: string
  role: string
  /** A path under `public/`, e.g. `/creator.jpg`. Null renders initials. */
  avatarUrl: string | null
}

export const CREATOR: Creator = {
  name: 'Muhammad Kashif',
  email: 'kashifarish2001@gmail.com',
  role: 'Architect and engineer',
  avatarUrl: null,
}

/** Initials for the avatar placeholder. */
export function creatorInitials(name: string = CREATOR.name): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')
}
