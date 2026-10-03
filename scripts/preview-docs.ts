import { resolve, sep } from "node:path";

const root = resolve(import.meta.dir, "../docs-dist");
if (!(await Bun.file(resolve(root, "index.html")).exists()))
  throw new Error("Run bun run docs:build first");
const port = Number(process.env.KOURO_DOCS_PORT ?? 4173);
const basePath = process.env.KOURO_DOCS_BASE_PATH ?? "/";
if (!/^\/(?:[\w-]+\/)*$/.test(basePath))
  throw new Error("KOURO_DOCS_BASE_PATH must be a directory URL such as /kouro/");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    if (!["GET", "HEAD"].includes(request.method))
      return new Response("Method not allowed", { status: 405 });
    let path: string;
    try {
      path = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return new Response("Bad path", { status: 400 });
    }
    if (!path.startsWith(basePath)) return new Response("Not found", { status: 404 });
    path = path.slice(basePath.length - 1);
    const target = resolve(root, `.${path.endsWith("/") ? `${path}index.html` : path}`);
    if (!target.startsWith(`${root}${sep}`)) return new Response("Not found", { status: 404 });
    const file = Bun.file(target);
    if (!(await file.exists())) return new Response("Not found", { status: 404 });
    return new Response(request.method === "HEAD" ? null : file, {
      headers: { "content-type": file.type, "cache-control": "no-store" },
    });
  },
});
console.log(`Kouro documentation: http://127.0.0.1:${server.port}${basePath}`);
