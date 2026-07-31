import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import JSZip from "jszip";

const outputDirectory = resolve("tests/.qa-fixtures");
await mkdir(outputDirectory, { recursive: true });

const encoder = new TextEncoder();

function writeAscii(target, offset, value) {
  target.set(encoder.encode(value), offset);
}

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

/**
 * Contenedor ISO BMFF mínimo para probar detección, hash y preservación.
 * Tiene una firma MP4 verosímil, pero deliberadamente no contiene pistas ni
 * muestras reproducibles: no debe usarse para probar el reproductor.
 */
function makeSyntheticMp4(seed = 1) {
  const bytes = new Uint8Array(80);
  const view = new DataView(bytes.buffer);

  view.setUint32(0, 32, false);
  writeAscii(bytes, 4, "ftyp");
  writeAscii(bytes, 8, "isom");
  view.setUint32(12, 0x00000200, false);
  writeAscii(bytes, 16, "isom");
  writeAscii(bytes, 20, "iso2");
  writeAscii(bytes, 24, "mp41");
  writeAscii(bytes, 28, "avc1");

  view.setUint32(32, 8, false);
  writeAscii(bytes, 36, "free");
  view.setUint32(40, 40, false);
  writeAscii(bytes, 44, "mdat");
  for (let index = 48; index < bytes.length; index += 1) {
    bytes[index] = (seed * 31 + index * 17) & 0xff;
  }
  return bytes;
}

/**
 * Cabecera EBML con DocType "webm" y segmento vacío. Es suficiente para
 * detección e integridad, pero no representa un video reproducible.
 */
function makeSyntheticWebm(seed = 1) {
  const header = Uint8Array.from([
    0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81,
    0x01, 0x42, 0xf2, 0x81, 0x04, 0x42, 0xf3, 0x81, 0x08, 0x42, 0x82, 0x84,
    0x77, 0x65, 0x62, 0x6d, 0x42, 0x87, 0x81, 0x02, 0x42, 0x85, 0x81, 0x02,
    0x18, 0x53, 0x80, 0x67, 0x80, 0xec, 0x81, seed & 0xff,
  ]);
  return header;
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
const videoMp4 = makeSyntheticMp4(1);
const videoWebm = makeSyntheticWebm(2);

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

const multipleFolderRoot = resolve(
  outputDirectory,
  "multiple-folder-case",
  "CARPETAS_PARA_SELECCIONAR_JUNTAS",
);
await Promise.all(
  ["A", "B"].map((name) =>
    mkdir(resolve(multipleFolderRoot, name), { recursive: true }),
  ),
);
await Promise.all([
  writeFile(resolve(multipleFolderRoot, "A", "A1 Captura.png"), onePixelPng),
  writeFile(resolve(multipleFolderRoot, "A", "Audio 1.ogg"), makeWav(0.31, 11)),
  writeFile(resolve(multipleFolderRoot, "A", "Audio 2.ogg"), makeWav(0.32, 12)),
  writeFile(resolve(multipleFolderRoot, "A", "Audio 3.ogg"), makeWav(0.33, 13)),
  writeFile(resolve(multipleFolderRoot, "B", "B1 Captura.png"), onePixelPng),
  writeFile(resolve(multipleFolderRoot, "B", "Audio 4.ogg"), makeWav(0.34, 14)),
  writeFile(resolve(multipleFolderRoot, "B", "Audio 5.ogg"), makeWav(0.35, 15)),
  writeFile(resolve(multipleFolderRoot, "B", "Audio 6.ogg"), makeWav(0.36, 16)),
]);

const videoOnlyRoot = resolve(
  outputDirectory,
  "video-only",
  "SOLO_VIDEOS_PARA_SELECCIONAR",
);
await mkdir(videoOnlyRoot, { recursive: true });
await Promise.all([
  writeFile(resolve(videoOnlyRoot, "Video audiencia 01.mp4"), videoMp4),
  writeFile(resolve(videoOnlyRoot, "Video audiencia 02.webm"), videoWebm),
]);

const mixedRoot = resolve(
  outputDirectory,
  "mixed",
  "AUDIOS_VIDEOS_Y_CAPTURA",
);
await mkdir(mixedRoot, { recursive: true });
await Promise.all([
  writeFile(resolve(mixedRoot, "Audio declaración.wav"), makeWav(0.42, 21)),
  writeFile(resolve(mixedRoot, "Video declaración.mp4"), makeSyntheticMp4(3)),
  writeFile(resolve(mixedRoot, "Captura conversación.png"), onePixelPng),
]);

const matrixRoot = resolve(
  outputDirectory,
  "multi-folder-matrix",
  "CARPETAS_AUDIO_VIDEO_PARA_SELECCIONAR",
);
await Promise.all(
  ["A", "B", "C"].map((name) =>
    mkdir(resolve(matrixRoot, name), { recursive: true }),
  ),
);
await Promise.all([
  writeFile(resolve(matrixRoot, "A", "Audio A.wav"), makeWav(0.51, 31)),
  writeFile(resolve(matrixRoot, "A", "Captura A.png"), onePixelPng),
  writeFile(resolve(matrixRoot, "B", "Video B.mp4"), makeSyntheticMp4(4)),
  writeFile(resolve(matrixRoot, "C", "Audio C.wav"), makeWav(0.53, 33)),
  writeFile(resolve(matrixRoot, "C", "Video C.webm"), makeSyntheticWebm(5)),
  writeFile(resolve(matrixRoot, "C", "Captura C 1.png"), onePixelPng),
  writeFile(resolve(matrixRoot, "C", "Captura C 2.png"), onePixelPng),
]);

await writeFile(resolve(outputDirectory, "control.bin"), audioA);
const modified = Uint8Array.from(audioA);
modified[modified.length - 1] ^= 0x01;
await writeFile(resolve(outputDirectory, "modificado.bin"), modified);

console.log(outputDirectory);
