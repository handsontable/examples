# ADR-0007: Auth via the Handsontable Google login broker

**Status:** Accepted (supersedes the original spec's Cloudflare Access)

## Context
Authoring is internal-team-only. The `publish-app` skill prescribes a shared
Google login broker (Handsontable accounts only, no passwords) for org apps.

## Decision
Gate authoring + all write endpoints behind the broker
(`https://mcp-auth-proxy-j0tb.onrender.com`). Frontend redirects to
`/broker/login?return_to=…`, receives a JWT, resolves identity via
`/broker/userinfo` (`@handsontable.com` only). The Worker re-validates the token
server-side and sets `created_by` from the verified email. Deploy on a
`*.workers.dev` host (an allowed return host).

## Scope of the gate (amended)
The authoring editor/playground (browse examples, edit, live preview, version
switching) is **public**. Sign-in is required **only** to create a persistent
client demo (`POST /api/demos` — the Share action) and to list "My demos". Anon
visitors get a "Sign in with Handsontable" control; Share when signed out starts
the broker login. `GET /api/demos/:id`, `/d/:id`, and `/embed/:id` are public.

## Profile identity — derived from the address, not from Google (amended, DEV-2166)

The Settings page (`/settings`) needs a display name and an avatar for a user
who has not set one. DEV-2166's acceptance criteria specified taking both from
Google — name from the SSO display name, picture from the SSO picture — with the
email's local part and a monogram only as a fallback.

**Those claims do not exist for us.** The broker's `/broker/login` redirects to
Google with `scope=openid email`. `name` and `picture` are `profile`-scope
claims, so Google never returns them and `/broker/userinfo` never carries them.
This is not a parsing gap in `auth.ts` — the data is never requested. Obtaining
it would mean changing the scope list in `mcp-auth-proxy`, a separate repository
under separate ownership, and re-consenting every user.

Decision:

1. **The display name comes from the email address.** Only `@handsontable.com`
   accounts can sign in — the broker rejects the rest — and team addresses are
   issued as `name.surname`, so the address already carries the name. Dots become
   spaces and each word is capitalised: `artur.medrygal@handsontable.com` →
   `Artur Medrygal`. Hyphenated given names keep their shape
   (`anna-maria.kowalska` → `Anna-Maria Kowalska`), and the tail of each word is
   lower-cased so an ALL-CAPS address does not shout on every card.
2. **The rule is structural, so it degrades quietly.** An address that does not
   follow the convention — `dev`, a role alias, a bot — capitalises to a single
   word. No worse than the raw local part it replaces, and no lookup table to
   maintain.
3. **There is no default avatar.** An uploaded picture or nothing; "nothing"
   draws the existing monogram, which is the no-avatar state rather than a
   placeholder for a picture we intend to find later.
4. **A user's own value always wins.** The derivation is applied on read, only
   when `profiles.display_name IS NULL`. Nothing derived is ever written to the
   row, so clearing the field returns to the derived name rather than freezing
   whatever it happened to be that day.

The `name`/`picture` plumbing added while this was still open has been removed
rather than left as a dormant seam: it could never fire, and dead branches read
as supported paths. If the broker's scope is ever widened, `deriveDefaults()`
(`workers/api/src/profile.ts`) is the one function that changes.

Implemented in `displayNameFromEmail()`, in `workers/api/src/profile.ts` and
mirrored in `apps/authoring/src/displayName.ts` so the client can paint before
`GET /api/profile` answers. `pipeline/profile.test.mjs` asserts the two agree.

## Consequences
- No per-app Google setup; no passwords; no service account.
- Replaces Cloudflare Access for this project.
- Display names are only as correct as the address convention. A team member
  whose address does not parse gets a plain capitalised word and can type their
  own name on `/settings`; nothing in the system depends on the derived value.
