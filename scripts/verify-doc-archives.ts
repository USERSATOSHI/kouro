import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { ApplicationService } from "../packages/host/src/application/service";
import { docsExamples } from "./docs-examples";

const root = resolve(import.meta.dir, "..");
const directory = await mkdtemp(join(tmpdir(), "kouro-doc-archives-"));
const service = new ApplicationService({
  dataDir: join(directory, "state"),
  templateRoot: join(directory, ".kouro"),
});
try {
  for (const example of docsExamples) {
    const bytes = await Bun.file(
      resolve(root, "docs-dist/downloads", `${example.id}.tar.gz`),
    ).bytes();
    if (bytes[0] !== 0x1f || bytes[1] !== 0x8b)
      throw new Error(`Download is not gzip compressed: ${example.id}`);
    await new Bun.Archive(bytes).extract(directory);
    const extracted = await Bun.file(join(directory, ".kouro", example.id, "kouro.ts")).text();
    if (extracted !== (await Bun.file(resolve(root, "docs/examples", `${example.id}.ts`)).text()))
      throw new Error(`Download differs from example source: ${example.id}`);
  }
  await service.start();
  const workflows = await service.workflows();
  for (const example of docsExamples) {
    const loaded = workflows.find((workflow) => workflow.id === example.id);
    if (!loaded || loaded.bundle.rootDefinitionId !== example.id)
      throw new Error(`Kouro failed to load the downloaded workflow: ${example.id}`);
  }
  console.log(
    `Loaded all ${docsExamples.length} downloaded workflows through the Kouro template loader`,
  );
} finally {
  await service.close();
  await rm(directory, { recursive: true, force: true });
}
