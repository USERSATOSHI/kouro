# @kouro/host

Kouro's local execution host, HTTP API, and CLI. The package publishes the
`kouro` executable; the CLI is intentionally part of `@kouro/host` rather than
a separate package.

## Install

The supported end-user install is the repository root from GitHub:

```sh
npm install --global github:usersatoshi/kouro
```

The package itself is also published as `@kouro/host` for workspace/library
consumers. The CLI requires Bun at runtime.
