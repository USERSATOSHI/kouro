import { resolve, relative } from "node:path";

const root = resolve(import.meta.dir, "..");
const errors: string[] = [];
for (const area of ["core", "web"]) {
  const source = resolve(root, "packages", area, "src");
  for await (const file of new Bun.Glob("**/*.{ts,tsx}").scan(source)) {
    if (/\.(test|spec)\./.test(file)) continue;
    const full = resolve(source, file);
    const text = await Bun.file(full).text();
    const scanner = new Bun.Transpiler({ loader: file.endsWith("tsx") ? "tsx" : "ts" });
    for (const entry of scanner.scan(text).imports) {
      const dependency = entry.path;
      const server = /^(node:|bun:|elysia(?:\/|$)|@kouro\/host(?:\/|$))/.test(dependency);
      const frontend = /^(react(?:-dom)?(?:\/|$)|@xyflow\/)/.test(dependency);
      const resolved = dependency.startsWith(".")
        ? resolve(source, file, "..", dependency)
        : dependency;
      const outside = dependency.startsWith(".") && !resolved.startsWith(source + "/");
      if (server || (area === "core" && (frontend || outside))) {
        errors.push(`${relative(root, full)} imports forbidden dependency ${dependency}`);
      }
    }
  }
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Core/web import boundaries passed.");
}
