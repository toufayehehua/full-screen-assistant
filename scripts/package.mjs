import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
const parts = manifest.version.split(".");
const filename = `Full-Screen-Assistant-${parts.slice(0, 3).join(".")}-build${parts[3] || 0}.zip`;
const output = path.join(root, "releases", filename);
const storeOutput = path.join(root, "releases", filename.replace(".zip", "-webstore.zip"));
const staging = await mkdtemp(path.join(tmpdir(), "fsa-package-"));
try {
  const directory = "Full-Screen Assistant";
  const target = path.join(staging, directory);
  await mkdir(target);
  for (const file of ["manifest.json", "bridge.js", "page.js", "service-worker.js", "placeholder.html", "placeholder.css", "placeholder.js", "icons", "_locales", "README.md"]) {
    await cp(path.join(root, file), path.join(target, file), { recursive: true });
  }
  await cp(path.join(root, "store", "privacy-policy.html"), path.join(target, "privacy.html"));
  await mkdir(path.dirname(output), { recursive: true });
  await rm(output, { force: true });
  const result = spawnSync("zip", ["-qr", output, directory], { cwd: staging, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`zip exited with status ${result.status}`);
  await rm(storeOutput, { force: true });
  const storeResult = spawnSync("zip", ["-qr", storeOutput, "."], { cwd: target, stdio: "inherit" });
  if (storeResult.error) throw storeResult.error;
  if (storeResult.status !== 0) throw new Error(`store zip exited with status ${storeResult.status}`);
  console.log(output);
  console.log(storeOutput);
} finally {
  await rm(staging, { recursive: true, force: true });
}
