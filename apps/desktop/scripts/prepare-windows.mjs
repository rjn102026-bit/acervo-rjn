import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("Este pacote beta é destinado a Windows x64.");
}
const manifest = JSON.parse(await readFile(new URL("./windows-dependencies.json", import.meta.url), "utf8"));
const cache = path.join(root, "src-tauri", "target", "dependencies");
const resources = path.join(root, "src-tauri", "resources", "ffmpeg");
await mkdir(cache, { recursive: true });
async function digest(file) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}
async function download(asset) {
  const file = path.join(cache, asset.name);
  if (!(await stat(file).catch(() => null))) {
    console.log("Baixando " + asset.name);
    const response = await fetch(asset.url, { signal: AbortSignal.timeout(600_000) });
    if (!response.ok || !response.body) throw new Error("Falha no download: " + response.status);
    const partial = file + ".partial";
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
    if (await digest(partial) !== asset.sha256) throw new Error("SHA-256 inválido: " + asset.name);
    await rename(partial, file);
  }
  if (await digest(file) !== asset.sha256) throw new Error("Cache corrompido: " + asset.name);
  return file;
}
const zip = await download(manifest.binary);
const unpack = path.join(cache, manifest.version + "-unpacked");
await mkdir(unpack, { recursive: true });
await run("tar.exe", ["-xf", zip, "-C", unpack], { windowsHide: true });
const entries = await readdir(unpack, { withFileTypes: true });
const distribution = entries.find((entry) => entry.isDirectory() && entry.name.startsWith("ffmpeg-"));
if (!distribution) throw new Error("Pacote FFmpeg sem diretório de distribuição.");
const source = path.join(unpack, distribution.name);
const sourceArchives = await Promise.all(manifest.sources.map(download));
if (await stat(resources).catch(() => null)) {
  if (path.resolve(resources) !== path.resolve(root, "src-tauri", "resources", "ffmpeg") ||
      !(await stat(path.join(resources, "PROVENANCE.json")).catch(() => null))) {
    throw new Error("Recusando substituir uma pasta sem identificação de recursos gerados.");
  }
  await rm(resources, { recursive: true });
}
await mkdir(path.join(resources, "bin"), { recursive: true });
const artifacts = (await readdir(path.join(source, "bin")))
  .filter((name) => name === "ffmpeg.exe" || name === "ffprobe.exe" || name.endsWith(".dll"));
for (const name of artifacts) await cp(path.join(source, "bin", name), path.join(resources, "bin", name));
await cp(path.join(source, "LICENSE.txt"), path.join(resources, "LICENSE.txt"));
await mkdir(path.join(resources, "sources"), { recursive: true });
for (let index = 0; index < manifest.sources.length; index++)
  await cp(sourceArchives[index], path.join(resources, "sources", manifest.sources[index].name));
const { stdout, stderr } = await run(path.join(resources, "bin", "ffmpeg.exe"), ["-version"], { windowsHide: true });
const version = stdout + stderr;
if (version.includes("--enable-gpl") || version.includes("--enable-nonfree"))
  throw new Error("O pacote não corresponde à variante LGPL exigida.");
await run(path.join(resources, "bin", "ffprobe.exe"), ["-version"], { windowsHide: true });
await writeFile(path.join(resources, "BUILD-INFO.txt"), version);
await writeFile(path.join(resources, "PROVENANCE.json"), JSON.stringify(manifest, null, 2) + "\n");
await writeFile(path.join(resources, "NOTICE.txt"), [
  "Lumen Desktop utiliza FFmpeg e FFprobe como processos externos.",
  "FFmpeg: Copyright (c) FFmpeg developers — https://ffmpeg.org/",
  "Variante LGPL shared, sem --enable-gpl e sem --enable-nonfree.",
  "Licença integral: LICENSE.txt. Versão/configuração: BUILD-INFO.txt.",
  "Origem e hashes: PROVENANCE.json.",
  "Fontes do FFmpeg e receitas de compilação: sources/.",
  "Os binários foram fornecidos por BtbN/FFmpeg-Builds, sem modificações.",
  "Este aviso não altera as licenças dos componentes de terceiros.",
].join("\n") + "\n");
console.log("FFmpeg/FFprobe preparados e verificados: " + manifest.version);
