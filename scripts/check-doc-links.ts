import { stat } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";

const root = resolve(import.meta.dir, "../docs-dist");
const files = Array.from(new Bun.Glob("**/*.html").scanSync({ cwd: root }));
if (!files.length) throw new Error("Build the documentation before checking links");
const contents = new Map<string, string>();
for (const file of files)
  contents.set(resolve(root, file), await Bun.file(resolve(root, file)).text());
const errors: string[] = [];
const anchors = new Map(
  Array.from(contents, ([file, html]) => [
    file,
    new Set(Array.from(html.matchAll(/\b(?:id|name)="([^"]+)"/g), (item) => item[1])),
  ]),
);
const targets = new Map<string, string>();
const sourceLines = new Map<string, number>();
const repository = resolve(import.meta.dir, "..");
const sourcePrefix = "https://github.com/usersatoshi/kouro/blob/main/";
let sourceLinks = 0;
let checked = 0;
for (const [file, html] of contents) {
  for (const match of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
    const href = match[1]!.replaceAll("&amp;", "&");
    if (href.startsWith(sourcePrefix)) {
      const [path, fragment] = href.slice(sourcePrefix.length).split("#");
      const source = resolve(repository, decodeURIComponent(path!));
      if (!source.startsWith(`${repository}${sep}`))
        throw new Error(`Source link escapes repository: ${href}`);
      let lines = sourceLines.get(source);
      if (lines === undefined) {
        if (!(await Bun.file(source).exists())) throw new Error(`Missing source file: ${href}`);
        lines = (await Bun.file(source).text()).split("\n").length;
        sourceLines.set(source, lines);
      }
      const line = Number(fragment?.replace(/^L/, ""));
      if (!Number.isSafeInteger(line) || line < 1 || line > lines)
        throw new Error(`Invalid source line: ${href}`);
      sourceLinks++;
      continue;
    }
    if (/^(?:[a-z]+:|\/\/)/i.test(href)) continue;
    if (href.startsWith("/")) {
      errors.push(`${relative(root, file)}: root-relative link ${href}`);
      continue;
    }
    const url = new URL(href, `https://docs.invalid/${relative(root, file).split(sep).join("/")}`);
    const target = resolve(root, decodeURIComponent(url.pathname).slice(1));
    const inRoot = relative(root, target);
    if (inRoot.startsWith(`..${sep}`) || inRoot === "..") {
      errors.push(`Link escapes site: ${href}`);
      continue;
    }
    try {
      let path = targets.get(target);
      if (!path) {
        if (contents.has(target)) path = target;
        else {
          const info = await stat(target);
          path = info.isDirectory() ? resolve(target, "index.html") : target;
          if (!info.isFile() && !(await Bun.file(path).exists()))
            throw new Error("missing entrypoint");
        }
        targets.set(target, path);
      }
      const targetHtml = contents.get(path);
      if (url.hash && targetHtml) {
        const anchor = decodeURIComponent(url.hash.slice(1));
        if (!anchors.get(path)?.has(anchor)) throw new Error(`missing anchor ${anchor}`);
      }
      checked++;
    } catch (error) {
      errors.push(`${relative(root, file)} → ${href}: ${String(error)}`);
    }
  }
}
if (errors.length) throw new Error(errors.join("\n"));
console.log(
  `Checked ${checked} local references and ${sourceLinks} source links across ${files.length} HTML pages`,
);
