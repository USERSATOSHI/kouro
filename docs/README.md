# Kouro documentation

The HTML documentation combines custom pages for workflow authoring and practical
examples with a searchable TypeDoc reference generated from
`packages/core/src/index.ts`.

```sh
bun install --frozen-lockfile
bun run docs:build
bun run docs:preview
```

Open `http://127.0.0.1:4173`. Set `KOURO_DOCS_PORT` to choose another preview port.
Use `KOURO_DOCS_BASE_PATH=/kouro/` to preview the GitHub project subpath.
The preview serves static documentation on loopback; it does not start or change
the Kouro workbench. `docs-dist/` is generated and ignored by Git.

## Editing the site

- `site/index.html`, `site/guide.html`, and `site/examples.html` are the custom
  HTML templates. Shared navigation, version, footer, and code are injected by
  `scripts/build-docs.ts`.
- `site/assets/` contains local styles, JavaScript, and the favicon. There are
  no remote fonts, analytics, or runtime CDN dependencies.
- `examples/` contains the actual workflow sources. `scripts/docs-examples.ts`
  describes their use cases, assumptions, and execution limits. Update both when
  behavior changes. The displayed code and downloadable archives use those same
  sources; archives include the workflow manifest and supporting files under
  `.kouro/WORKFLOW_ID/`.
- `typedoc.json` configures the API output in `docs-dist/api/` and its custom
  styling/navigation. `site/api.md` introduces the authoring APIs. Documentation
  links use relative paths so the site works under a GitHub project subpath.

`docs:build` typechecks the examples, compiles every workflow with the real Kouro
compiler, generates TypeDoc with warnings treated as errors, and checks local
HTML links, anchors, and source destinations. Download archives are extracted
and loaded through the real Kouro template loader without executing tasks.
TypeDoc's source-path validation is disabled for the
cross-links to custom pages, which are created after API generation; the final
site link check validates these destinations. These checks validate authoring
and static output; they do not establish successful live model execution. The
examples require project-specific commands, authenticated harnesses, and real
model selections.

Run `bun run test:docs` after building to check rendered navigation, examples,
copy/download interactions, and mobile layout under `/kouro/` with Chromium.
It uses its own preview server on port 4174 (`KOURO_DOCS_TEST_PORT` overrides it).

## GitHub Pages

The [Documentation workflow](../.github/workflows/docs.yml) builds documentation
on relevant pull requests and pushes to `main`. Pull requests only build; pushes
to `main` upload the site artifact and deploy to the `github-pages` environment.
It can also be dispatched manually on `main`.

In the **GitHub** repository's **Settings → Pages → Build and deployment**, choose
**GitHub Actions** as the source, then push the workflow to that repository.
GitHub documents the required configuration in
[Using custom workflows with GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).
The default project URL for `usersatoshi/kouro` would be
`https://usersatoshi.github.io/kouro/`; it is not live merely because a local
build passed. This checkout's `origin` is Forgejo: the Pages action runs only
when the change reaches GitHub, through a configured mirror or a GitHub push.

The [TypeDoc output options](https://typedoc.org/documents/Options.Output.html)
describe the CSS, JavaScript, favicon, and HTML footer hooks used by this site.

## Existing runtime guides

- [Local workflows, fusion, milestones, and swarms](v2/local-workflow-use.md)
- [Agent plugins and task CLI](v2/agent-plugins.md)
- [Operator guide](v2/operator-guide.md)
- [Runtime contracts](v2/contracts.md)
