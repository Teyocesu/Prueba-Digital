import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import JSZip from "jszip";

const outputDirectory = resolve("tests/.qa-fixtures");
await mkdir(outputDirectory, { recursive: true });

function makeWav(durationSeconds, seed = 1) {
  const sampleRate = 48_000;
  const channelCount = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const sampleCount = Math.round(durationSeconds * sampleRate);
  const dataSize = sampleCount * channelCount * bytesPerSample;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);

  bytes.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, 36 + dataSize, true);
  bytes.set(new TextEncoder().encode("WAVE"), 8);
  bytes.set(new TextEncoder().encode("fmt "), 12);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * bytesPerSample, true);
  view.setUint16(32, channelCount * bytesPerSample, true);
  view.setUint16(34, bitsPerSample, true);
  bytes.set(new TextEncoder().encode("data"), 36);
  view.setUint32(40, dataSize, true);

  for (let index = 44; index < bytes.length; index += 2) {
    const sample = Math.round(
      Math.sin(((index - 44 + seed) / 38) * Math.PI * 2) * 4_000,
    );
    view.setInt16(index, sample, true);
  }
  return bytes;
}

const onePixelPng = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);

async function writeZip(name, entries) {
  const zip = new JSZip();
  for (const [path, value] of entries) {
    zip.file(path, value);
  }
  const bytes = await zip.generateAsync({
    type: "uint8array",
    compression: "STORE",
  });
  await writeFile(resolve(outputDirectory, name), bytes);
}

const audioA = makeWav(1.25, 1);
const audioD1 = makeWav(0.7, 2);
const audioD2 = makeWav(0.45, 3);

await writeZip("A.zip", [
  ["2WhatsApp Audio prueba judicial.ogg", audioA],
  ["1-PHOTO-prueba judicial.png", onePixelPng],
  [".DS_Store", Uint8Array.from([1, 2, 3])],
  ["__MACOSX/._archivo", Uint8Array.from([4, 5, 6])],
  ["._2WhatsApp Audio prueba judicial.ogg", Uint8Array.from([7, 8])],
]);

await writeZip("B.zip", [
  ["Conversación escrita – Núñez.png", onePixelPng],
]);

await writeZip("D.zip", [
  ["Audio uno con espacios.ogg", audioD1],
  ["Audio dos con ñ.ogg", audioD2],
  ["Captura primera.png", onePixelPng],
  ["Captura segunda.png", onePixelPng],
]);

const folderRoot = resolve(
  outputDirectory,
  "folder-case",
  "MATERIAL_PARA_SELECCIONAR",
);
await Promise.all(
  ["A", "D", "F", ".oculta", "__MACOSX"].map((name) =>
    mkdir(resolve(folderRoot, name), { recursive: true }),
  ),
);
await Promise.all([
  writeFile(resolve(folderRoot, "A", "Audio A original.ogg"), audioA),
  writeFile(resolve(folderRoot, "A", "Captura A original.png"), onePixelPng),
  writeFile(resolve(folderRoot, "D", "Audio D original.ogg"), audioD1),
  writeFile(resolve(folderRoot, "D", "Captura D original.png"), onePixelPng),
  writeFile(resolve(folderRoot, "F", "Captura sin audio.png"), onePixelPng),
  writeFile(resolve(folderRoot, ".DS_Store"), Uint8Array.from([1, 2, 3])),
  writeFile(resolve(folderRoot, ".oculta", "secreto.png"), onePixelPng),
  writeFile(resolve(folderRoot, "__MACOSX", "._Audio A original.ogg"), audioA),
]);

await writeFile(resolve(outputDirectory, "control.bin"), audioA);
const modified = Uint8Array.from(audioA);
modified[modified.length - 1] ^= 0x01;
await writeFile(resolve(outputDirectory, "modificado.bin"), modified);

console.log(outputDirectory);
