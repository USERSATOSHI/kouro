import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { docsExamples } from "./docs-examples";

const root = resolve(import.meta.dir, "..");
const output = resolve(root, "docs-dist");
const source = resolve(root, "docs/site");
const { version } = (await Bun.file(resolve(root, "package.json")).json()) as { version: string };
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );

function highlighted(code: string) {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    code,
  );
  let html = "";
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    const text = escape(scanner.getTokenText());
    const style =
      token >= ts.SyntaxKind.FirstKeyword && token <= ts.SyntaxKind.LastKeyword
        ? "keyword"
        : token === ts.SyntaxKind.StringLiteral ||
            token === ts.SyntaxKind.NoSubstitutionTemplateLiteral
          ? "string"
          : token === ts.SyntaxKind.SingleLineCommentTrivia ||
              token === ts.SyntaxKind.MultiLineCommentTrivia
            ? "comment"
            : token === ts.SyntaxKind.NumericLiteral
              ? "number"
              : undefined;
    html += style ? `<span class="syntax-${style}">${text}</span>` : text;
  }
  return html;
}
function codeBlock(id: string, filename: string, code: string, download?: string) {
  return `<div class="code"><div class="code-header"><span>${escape(filename)}</span><span>${download ? `<a href="${download}" download>Download file</a> · ` : ""}<button type="button" class="copy" data-copy="${id}" aria-label="Copy ${escape(filename)}" aria-live="polite">Copy</button></span></div><pre><code id="${id}">${highlighted(code)}</code></pre></div>`;
}
function navigation(page: string) {
  const link = (label: string, href: string) =>
    `<a href="${href}"${page === href ? ' aria-current="page"' : ""}>${label}</a>`;
  return `<a class="skip" href="#main">Skip to content</a><header class="header"><nav class="navigation container" aria-label="Main navigation"><a class="logo" href="index.html"><img src="assets/favicon.svg" alt="">kouro</a>${link("Learn", "guide.html")}${link("Examples", "examples.html")}${link("API reference", "api/index.html")}<span class="version">v${escape(version)}</span></nav></header>`;
}
const footer = `<div class="container"><footer class="footer"><span>Kouro v${escape(version)} · Local workflow orchestration</span><span><a href="https://github.com/usersatoshi/kouro">Source</a> · API generated with <a href="https://typedoc.org">TypeDoc</a></span></footer></div>`;

await rm(output, { recursive: true, force: true });
await mkdir(resolve(output, "downloads"), { recursive: true });
await cp(resolve(source, "assets"), resolve(output, "assets"), { recursive: true });
const typedoc = Bun.spawn(
  [
    process.execPath,
    resolve(root, "node_modules/typedoc/bin/typedoc"),
    "--options",
    resolve(root, "typedoc.json"),
  ],
  {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  },
);
if ((await typedoc.exited) !== 0) throw new Error("TypeDoc generation failed");

let examples = "";
for (const example of docsExamples) {
  const code = await readFile(resolve(root, "docs/examples", `${example.id}.ts`), "utf8");
  const directory = resolve(output, "downloads", example.id);
  await mkdir(directory, { recursive: true });
  const manifest =
    JSON.stringify(
      {
        id: example.id,
        name: example.title,
        version: "1",
        description: example.description,
        entrypoint: "./kouro.ts",
      },
      null,
      2,
    ) + "\n";
  const files: Record<string, string> = { "manifest.json": manifest, "kouro.ts": code };
  for (const file of example.files)
    files[file] = await readFile(resolve(root, "docs/examples", file), "utf8");
  for (const [file, content] of Object.entries(files))
    await writeFile(resolve(directory, file), content);
  const archive = new Bun.Archive(
    Object.fromEntries(
      Object.entries(files).map(([file, content]) => [`.kouro/${example.id}/${file}`, content]),
    ),
    { compress: "gzip" },
  );
  await writeFile(resolve(output, "downloads", `${example.id}.tar.gz`), await archive.bytes());
  examples += `<section class="example" id="${example.id}" data-example><span class="eyebrow">${example.category}</span><h2>${escape(example.title)}</h2><p class="description">${escape(example.description)}</p><ol class="flow" aria-label="Workflow stages">${example.flow.map((step) => `<li>${escape(step)}</li>`).join("")}</ol><div class="task"><strong>Example task</strong>${escape(example.task)}</div><p>${escape(example.notes)}</p><a class="button" href="downloads/${example.id}.tar.gz" download>Download complete workflow ↓</a><details${example.id === "first-workflow" ? " open" : ""}><summary>Read kouro.ts</summary>${codeBlock(`${example.id}-code`, "kouro.ts", code, `downloads/${example.id}/kouro.ts`)}</details>${example.files.map((file) => `<details><summary>Read ${escape(file)}</summary>${codeBlock(`${example.id}-${file.replace(/\W/g, "-")}`, file, files[file]!, `downloads/${example.id}/${file}`)}</details>`).join("")}</section>`;
}
const firstCode = await readFile(resolve(root, "docs/examples/first-workflow.ts"), "utf8");
for (const page of ["index.html", "guide.html", "examples.html"]) {
  const template = await readFile(resolve(source, page), "utf8");
  const html = template
    .replaceAll("{{navigation}}", navigation(page))
    .replaceAll("{{footer}}", footer)
    .replaceAll("{{firstExample}}", codeBlock("first-workflow-code", "kouro.ts", firstCode))
    .replaceAll(
      "{{exampleLinks}}",
      docsExamples
        .map((example) => `<a href="#${example.id}">${escape(example.title)}</a>`)
        .join(""),
    )
    .replaceAll("{{examples}}", examples);
  if (/\{\{\w+\}\}/.test(html)) throw new Error(`Unresolved HTML template variable in ${page}`);
  await writeFile(resolve(output, page), html);
}
await writeFile(resolve(output, ".nojekyll"), "");
console.log(`Built Kouro docs in ${output}`);
