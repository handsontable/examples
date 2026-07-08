# ADR-0012: One container image + DO class per framework

**Status:** Accepted

## Context
Cloudflare Containers bind one image per Durable Object class. Frameworks have
very different dependency trees (and the two Next examples differ by major
version + Tailwind/shadcn).

## Decision
One baked image and one `Sandbox` subclass per framework
(`RemixSandbox`, `AngularSandbox`, `NextSandbox`, `NextShadcnSandbox`,
`AstroSandbox`, `NuxtSandbox`). Dockerfiles and the Worker's dev-command map are
generated from the catalog by `scripts/prepare-container.mjs`. Session ids encode
the container (`<container>--<uuid>`) so file/delete routes pick the right binding.

## Consequences
- Fast warm boots (deps baked); no giant all-in-one image.
- Six images to build/warm; a warm instance per framework recommended.
