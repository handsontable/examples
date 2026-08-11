# Handsontable examples

Runnable code examples for [Handsontable](https://handsontable.com), the JavaScript
data grid. Every example here is a real, self-contained project you can clone, run,
and copy into your own codebase.

The same examples power the live demos in the
[Handsontable documentation](https://handsontable.com/docs) and at
**[demos.handsontable.com](https://demos.handsontable.com)**, where you can open any
of them in the browser, edit the code, switch the Handsontable version, and share a
permanent link — no install needed.

## Client examples

Each folder in [`examples/`](./examples) is an independent project with its own
`package.json` and lockfile. Install and run one on its own; there is no root
install step.

| Example | What it shows |
|---------|---------------|
| [`example1`](./examples/example1) | Vanilla TypeScript (Vite) — the general-purpose feature tour |
| [`javascript`](./examples/javascript) | Plain JavaScript (Vite) |
| [`typescript`](./examples/typescript) | TypeScript (Vite) |
| [`react`](./examples/react) | React with TypeScript (Vite) |
| [`react-js`](./examples/react-js) | React with JavaScript (Vite) |
| [`vue`](./examples/vue) | Vue 3 (Vite) |
| [`angular`](./examples/angular) | Angular |
| [`next.js`](./examples/next.js) | Next.js, App Router |
| [`next-shadcn.js`](./examples/next-shadcn.js) | Next.js with shadcn/ui |
| [`nuxt`](./examples/nuxt) | Nuxt 3 |
| [`astro`](./examples/astro) | Astro |
| [`remix`](./examples/remix) | Remix |
| [`ant-design`](./examples/ant-design) | Handsontable themed to match Ant Design |
| [`mui`](./examples/mui) | Handsontable themed to match MUI |
| [`base-web`](./examples/base-web) | Handsontable themed to match Base Web |
| [`fluent-ui`](./examples/fluent-ui) | Handsontable themed to match Fluent UI |

## Server examples

Each folder in [`server-examples/`](./server-examples) is a full stack — a backend
plus a Handsontable frontend — demonstrating server-side **pagination, sorting,
filtering and CRUD** through the `dataProvider` plugin. Useful when your dataset is
too large to send to the browser at once.

| Example | Backend |
|---------|---------|
| [`express`](./server-examples/express) | Express.js (Node) |
| [`nestjs`](./server-examples/nestjs) | NestJS (Node) |
| [`django`](./server-examples/django) | Django REST Framework (Python) |
| [`rails`](./server-examples/rails) | Ruby on Rails |
| [`laravel`](./server-examples/laravel) | Laravel (PHP) |
| [`symfony`](./server-examples/symfony) | Symfony (PHP) |
| [`spring`](./server-examples/spring) | Spring Boot (Java) |

Each ships a `docker-compose.yml` and its own README with setup instructions.

## Quick start

```bash
git clone https://github.com/handsontable/examples.git
cd examples/examples/react     # or any other folder under examples/

pnpm install
pnpm dev                       # then open the URL it prints
```

Every example has `dev` and `build`; most also have `preview` to serve the built
output. Run `pnpm run` in an example folder to see its own scripts, and check its
README for anything specific — Angular, for instance, also answers to `pnpm start`
and serves on a different port.

## Copying an example to a separate repo

The examples are deliberately standalone, so this is mostly a copy:

1. Copy the example folder somewhere outside this repository:
   ```bash
   cp -R examples/react ~/my-handsontable-app
   cd ~/my-handsontable-app
   ```
2. Edit `package.json` — set `name`, `version` and `description` to your own, and
   drop the `license` field or replace it with yours.
3. Initialise a repository and install:
   ```bash
   git init && git add -A && git commit -m "Initial commit"
   pnpm install
   ```
4. Every example depends on `handsontable@latest` so the demos always show the
   current release. Pin a real version before you ship:
   `pnpm add handsontable@<version>`, plus the matching `@handsontable/*-wrapper`
   if the example uses one.

Nothing in an example folder reaches outside itself, so no other files need to come
with it.

## Try it without installing anything

**[demos.handsontable.com](https://demos.handsontable.com)** runs every example in
this repository live, in the browser:

- **Any Handsontable version** — switch versions and watch the same code re-render.
- **Two runtimes behind one editor** — simple examples bundle in the browser with
  the open-source [Sandpack](https://sandpack.codesandbox.io/) bundler; the
  meta-framework examples (Next.js, Nuxt, Astro, Remix, Angular) run a real dev
  server in a container, so SSR behaves the way it does locally.
- **Permanent share links** — save an edited demo and link to it.

It also renders every code example from the Handsontable documentation guides. The
system is self-hosted and lives in [`runner/`](./runner); its
[README](./runner/README.md) and [`docs/`](./runner/docs) cover the design.

## Repository layout

| Path | What it is |
|------|------------|
| `examples/` | The 16 client examples above. Independent projects. |
| `server-examples/` | The 7 server-side stacks above. Independent projects. |
| `runner/` | The self-hosted demo runner behind demos.handsontable.com. |
| `runner/apps/authoring/public/docs-examples/` | **Generated** — a snapshot of every documentation-guide example, imported from the docs repository. Do not edit by hand; it is the bulk of this repository's size. |

## License

The example code in this repository is MIT-licensed — see [LICENSE](./LICENSE). Copy
it, change it, ship it.

Handsontable itself is separate, commercial software, dual-licensed:

- **Free** for non-commercial use such as teaching, academic research and
  evaluation — [read the license](https://github.com/handsontable/handsontable/blob/master/handsontable-non-commercial-license.pdf).
- **Commercial**, with support and maintenance — see [pricing](https://handsontable.com/pricing).

The examples install Handsontable under the non-commercial evaluation terms. Using
one as the basis for a commercial product means buying a license.

## Get help

Ask in [GitHub Discussions](https://github.com/handsontable/handsontable/discussions),
or read the [documentation](https://handsontable.com/docs). Commercial license
holders with an active support plan can reach the
[support team](https://handsontable.com/contact?category=technical_support)
directly.

Found something broken in an example? Please
[open an issue](https://github.com/handsontable/examples/issues).
