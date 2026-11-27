// Bundles the server into one file, with the licenses of the open-source
// packages the bundle carries beside it: their notices must ship with copies.
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const OUT_DIR = "dist";
const BUNDLE = "dreamcash-mcp.js";
const LICENSES = "THIRD_PARTY_LICENSES.md";
const LICENSE_FILE = /^(licen[cs]e|notice)/i;
// the package an input belongs to: the path through its last node_modules
const PACKAGE_DIR = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//;

const result = await Bun.build({
  entrypoints: ["src/main.ts"],
  target: "node",
  format: "esm",
  outdir: OUT_DIR,
  naming: BUNDLE,
  metafile: true,
});
if (!result.success || !result.metafile) {
  for (const log of result.logs) console.error(log);
  throw new Error("The bundle didn't build.");
}

const packageDirs = new Set(
  Object.keys(result.metafile.inputs).flatMap(
    (input) => input.match(PACKAGE_DIR)?.[1] ?? [],
  ),
);

const noticeOf = async (dir: string) => {
  const { name, version, license } = await Bun.file(
    join(dir, "package.json"),
  ).json();
  const files = (await readdir(dir)).filter((file) => LICENSE_FILE.test(file));
  if (files.length === 0) {
    throw new Error(`${name} has no license file to ship with the bundle.`);
  }
  const texts = await Promise.all(
    files.sort().map((file) => Bun.file(join(dir, file)).text()),
  );
  return {
    name: name as string,
    section: `## ${name} ${version} (${license})\n\n${texts.join("\n\n").trim()}`,
  };
};

const notices = (await Promise.all([...packageDirs].map(noticeOf))).sort(
  (a, b) => a.name.localeCompare(b.name),
);
await Bun.write(
  join(OUT_DIR, LICENSES),
  [
    `# Third-party licenses\n\n${BUNDLE} includes these packages.`,
    ...notices.map((notice) => notice.section),
  ].join("\n\n"),
);
console.log(`${BUNDLE} with the licenses of ${notices.length} packages`);
