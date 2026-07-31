import { describe, expect, it } from "vitest";
import JSZip from "jszip";

import {
  classifyFormat,
  detectFormat,
  formatDuration,
  isMacOSJunk,
  isValidSha256,
  loadEvidenceFiles,
  readWavDuration,
  safeBasename,
  sha256,
  verifySha256,
} from "../lib/evidence";

function writeAscii(target: Uint8Array, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    target[offset + index] = text.charCodeAt(index);
  }
}

function makeWav(durationMs: number, includeJunkChunk = false): Uint8Array {
  const sampleRate = 8_000;
  const channels = 1;
  const bitsPerSample = 16;
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const dataLength = Math.round((durationMs / 1_000) * byteRate);
  const junkLength = includeJunkChunk ? 3 : 0;
  const junkChunkLength = includeJunkChunk ? 8 + junkLength + 1 : 0;
  const totalLength = 12 + junkChunkLength + 24 + 8 + dataLength;
  const bytes = new Uint8Array(totalLength);
  const view = new DataView(bytes.buffer);

  writeAscii(bytes, 0, "RIFF");
  view.setUint32(4, totalLength - 8, true);
  writeAscii(bytes, 8, "WAVE");

  let offset = 12;
  if (includeJunkChunk) {
    writeAscii(bytes, offset, "JUNK");
    view.setUint32(offset + 4, junkLength, true);
    bytes.set([1, 2, 3], offset + 8);
    offset += junkChunkLength;
  }

  writeAscii(bytes, offset, "fmt ");
  view.setUint32(offset + 4, 16, true);
  view.setUint16(offset + 8, 1, true);
  view.setUint16(offset + 10, channels, true);
  view.setUint32(offset + 12, sampleRate, true);
  view.setUint32(offset + 16, byteRate, true);
  view.setUint16(offset + 20, blockAlign, true);
  view.setUint16(offset + 22, bitsPerSample, true);
  offset += 24;

  writeAscii(bytes, offset, "data");
  view.setUint32(offset + 4, dataLength, true);
  return bytes;
}

function standaloneBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function makeJpeg(): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);
}

function makeFtyp(majorBrand: string, compatibleBrands: string[] = []) {
  const bytes = new Uint8Array(16 + compatibleBrands.length * 4);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, bytes.length, false);
  writeAscii(bytes, 4, "ftyp");
  writeAscii(bytes, 8, majorBrand);
  for (let index = 0; index < compatibleBrands.length; index += 1) {
    writeAscii(bytes, 16 + index * 4, compatibleBrands[index]);
  }
  return bytes;
}

function makeEbml(docType: "webm" | "matroska"): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([0x1a, 0x45, 0xdf, 0xa3], 0);
  writeAscii(bytes, 12, docType);
  return bytes;
}

function makeMpegTransportStream(firstSyncOffset = 0): Uint8Array {
  const bytes = new Uint8Array(firstSyncOffset + 377);
  bytes[firstSyncOffset] = 0x47;
  bytes[firstSyncOffset + 188] = 0x47;
  bytes[firstSyncOffset + 376] = 0x47;
  return bytes;
}

function makeFolderFile(
  contents: Uint8Array,
  name: string,
  webkitRelativePath: string,
): File {
  const file = new File([standaloneBuffer(contents)], name);
  Object.defineProperty(file, "webkitRelativePath", {
    configurable: true,
    value: webkitRelativePath,
  });
  return file;
}

describe("detección por contenido", () => {
  it.each([
    ["wav", makeWav(1)],
    ["ogg", new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 0, 0, 0])],
    [
      "opus",
      (() => {
        const bytes = new Uint8Array(64);
        writeAscii(bytes, 0, "OggS");
        writeAscii(bytes, 28, "OpusHead");
        return bytes;
      })(),
    ],
    ["mp3", new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0])],
    [
      "m4a",
      makeFtyp("M4A ", ["isom"]),
    ],
    ["aac", new Uint8Array([0xff, 0xf1, 0x50, 0x80])],
    ["jpeg", makeJpeg()],
    ["png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    [
      "webp",
      new Uint8Array([
        0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
      ]),
    ],
    [
      "heic",
      makeFtyp("heic", ["mif1", "isom"]),
    ],
  ] as const)("detecta %s por magic bytes", (expected, bytes) => {
    expect(detectFormat(bytes)).toBe(expected);
    expect(classifyFormat(expected)).not.toBe("unknown");
  });

  it.each([
    ["mp4", makeFtyp("isom", ["mp42"])],
    ["m4v", makeFtyp("M4V ", ["isom"])],
    ["mov", makeFtyp("qt  ")],
    ["3gp", makeFtyp("3gp6", ["isom"])],
    ["3g2", makeFtyp("3g2a", ["isom"])],
    ["webm", makeEbml("webm")],
    ["mkv", makeEbml("matroska")],
    [
      "avi",
      (() => {
        const bytes = new Uint8Array(12);
        writeAscii(bytes, 0, "RIFF");
        writeAscii(bytes, 8, "AVI ");
        return bytes;
      })(),
    ],
    [
      "ogv",
      (() => {
        const bytes = new Uint8Array(64);
        writeAscii(bytes, 0, "OggS");
        writeAscii(bytes, 28, "theora");
        return bytes;
      })(),
    ],
    ["mpeg", new Uint8Array([0x00, 0x00, 0x01, 0xba])],
    ["mpegts", makeMpegTransportStream()],
    ["mpegts", makeMpegTransportStream(4)],
    [
      "wmv",
      new Uint8Array([
        0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00,
        0xaa, 0x00, 0x62, 0xce, 0x6c,
      ]),
    ],
    ["flv", new Uint8Array([0x46, 0x4c, 0x56, 0x01])],
  ] as const)("detecta el contenedor de video %s por su firma", (expected, bytes) => {
    expect(detectFormat(bytes)).toBe(expected);
    expect(classifyFormat(expected)).toBe("video");
  });

  it("prioriza las marcas de imagen y audio sobre una marca compatible MP4", () => {
    expect(detectFormat(makeFtyp("heic", ["mif1", "isom"]))).toBe("heic");
    expect(detectFormat(makeFtyp("M4A ", ["isom", "mp42"]))).toBe("m4a");
    expect(classifyFormat("heic")).toBe("image");
    expect(classifyFormat("m4a")).toBe("audio");
  });

  it("no atribuye un tipo EBML si el DocType no está presente", () => {
    expect(detectFormat(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]))).toBe(
      "unknown",
    );
  });

  it("detecta un .ogg cuyo contenido real es WAV y genera advertencia", async () => {
    const wav = makeWav(1_250, true);
    const file = new File([standaloneBuffer(wav)], "Audio real.ogg");
    const loaded = await loadEvidenceFiles([file]);

    expect(loaded.files).toHaveLength(1);
    expect(loaded.files[0]).toMatchObject({
      name: "Audio real.ogg",
      extension: ".ogg",
      detectedFormat: "wav",
      kind: "audio",
      duration: "00:01.250",
    });
    expect(loaded.files[0].warning).toContain(
      "no coincide con el contenido detectado (WAV)",
    );
    expect(loaded.files[0].file.name).toBe("Audio real.ogg");
  });

  it("valida las extensiones de video contra el contenido, no a la inversa", async () => {
    const correct = new File(
      [standaloneBuffer(makeFtyp("qt  "))],
      "Audiencia.mov",
    );
    const disguised = new File(
      [standaloneBuffer(makeFtyp("isom"))],
      "Audiencia.avi",
    );
    const loaded = await loadEvidenceFiles([correct, disguised]);

    expect(loaded.files.find((file) => file.name === correct.name)?.warning).toBe(
      undefined,
    );
    expect(
      loaded.files.find((file) => file.name === disguised.name)?.warning,
    ).toContain("contenido detectado (MP4)");
  });
});

describe("duración WAV", () => {
  it("recorre chunks variables y devuelve mm:ss.mmm", () => {
    const duration = readWavDuration(makeWav(58_283, true));

    expect(duration).toEqual({
      milliseconds: 58_283,
      formatted: "00:58.283",
    });
    expect(formatDuration(71_851)).toBe("01:11.851");
  });

  it("rechaza un WAV truncado", () => {
    const wav = makeWav(1_000);
    expect(readWavDuration(wav.slice(0, wav.length - 1))).toBeNull();
  });
});

describe("nombres y basura de macOS", () => {
  it.each([
    ".DS_Store",
    "A/.DS_Store",
    "__MACOSX/A/audio.ogg",
    "A/__MACOSX/audio.ogg",
    "A/._audio.ogg",
    ".carpeta-oculta/audio.ogg",
    "Raíz/.temporal/captura.jpg",
    "Raíz/.captura.jpg",
  ])("ignora %s", (path) => {
    expect(isMacOSJunk(path)).toBe(true);
  });

  it("preserva espacios, Unicode y errores aparentes del nombre", () => {
    const decomposedName = "1HOTO Cafe\u0301 con espacios y ñ 2026-07-21.jpg";
    expect(safeBasename(`Grupo Á/${decomposedName}`)).toBe(decomposedName);
    expect(Array.from(safeBasename(`Grupo Á/${decomposedName}`))).toEqual(
      Array.from(decomposedName),
    );
  });

  it("preserva una barra invertida literal en un nombre de macOS", async () => {
    const exactName = "evidencia\\original.wav";
    const file = new File([standaloneBuffer(makeWav(250))], exactName);
    const loaded = await loadEvidenceFiles([file]);

    expect(safeBasename(exactName)).toBe(exactName);
    expect(loaded.files[0].name).toBe(exactName);
    expect(loaded.files[0].file.name).toBe(exactName);
  });

  it("filtra basura, conserva el grupo ZIP y asocia su única captura", async () => {
    const zip = new JSZip();
    zip.file("__MACOSX/._Audio.wav", new Uint8Array([1]));
    zip.file(".DS_Store", new Uint8Array([1]));
    zip.file("Carpeta/._Audio.wav", new Uint8Array([1]));
    zip.file("Carpeta/Audio con ñ.wav", standaloneBuffer(makeWav(2_000, true)));
    zip.file("Carpeta/1HOTO única.jpg", standaloneBuffer(makeJpeg()));
    const zipBytes = await zip.generateAsync({ type: "uint8array" });
    const zipFile = new File(
      [standaloneBuffer(zipBytes)],
      "Grupo Á con espacios.zip",
    );

    const loaded = await loadEvidenceFiles([zipFile]);

    expect(loaded.groups).toHaveLength(1);
    expect(loaded.groups[0].name).toBe("Grupo Á con espacios");
    expect(loaded.ignored).toHaveLength(3);
    expect(loaded.groups[0].audios).toHaveLength(1);
    expect(loaded.groups[0].images).toHaveLength(1);
    expect(loaded.groups[0].audios[0].name).toBe("Audio con ñ.wav");
    expect(loaded.groups[0].audios[0].associatedCaptureId).toBe(
      loaded.groups[0].images[0].id,
    );
    expect(loaded.groups[0].audios[0].associatedCaptureIds).toEqual([
      loaded.groups[0].images[0].id,
    ]);
  });

  it("mantiene identidades distintas para ZIP homónimos", async () => {
    const makeGroupZip = async (
      audioName: string,
      captureName: string,
    ): Promise<File> => {
      const zip = new JSZip();
      zip.file(audioName, standaloneBuffer(makeWav(100)));
      zip.file(captureName, standaloneBuffer(makeJpeg()));
      const bytes = await zip.generateAsync({ type: "uint8array" });
      return new File([standaloneBuffer(bytes)], "A.zip");
    };
    const loaded = await loadEvidenceFiles([
      await makeGroupZip("uno.wav", "uno.jpg"),
      await makeGroupZip("dos.wav", "dos.jpg"),
    ]);

    expect(loaded.groups.map((group) => group.name)).toEqual(["A", "A"]);
    expect(loaded.groups[0].id).not.toBe(loaded.groups[1].id);
    expect(loaded.groups[0].audios[0].groupId).toBe(loaded.groups[0].id);
    expect(loaded.groups[1].audios[0].groupId).toBe(loaded.groups[1].id);
    expect(loaded.groups[0].audios[0].associatedCaptureId).toBe(
      loaded.groups[0].images[0].id,
    );
    expect(loaded.groups[1].audios[0].associatedCaptureId).toBe(
      loaded.groups[1].images[0].id,
    );
  });

  it("conserva la estructura de webkitRelativePath sin la carpeta raíz común", async () => {
    const audioA = makeFolderFile(
      makeWav(400),
      "Audio A.wav",
      "Carpeta contenedora/A/Conversación/Audio A.wav",
    );
    const captureA = makeFolderFile(
      makeJpeg(),
      "Captura A.jpg",
      "Carpeta contenedora/A/Conversación/Captura A.jpg",
    );
    const audioD = makeFolderFile(
      makeWav(500),
      "Audio D.wav",
      "Carpeta contenedora/D/Audio D.wav",
    );
    const dsStore = makeFolderFile(
      new Uint8Array([1]),
      ".DS_Store",
      "Carpeta contenedora/.DS_Store",
    );
    const resourceFork = makeFolderFile(
      new Uint8Array([1]),
      "._Audio A.wav",
      "Carpeta contenedora/A/Conversación/._Audio A.wav",
    );
    const hiddenAudio = makeFolderFile(
      makeWav(600),
      "secreto.wav",
      "Carpeta contenedora/.oculta/secreto.wav",
    );

    const loaded = await loadEvidenceFiles([
      audioA,
      captureA,
      audioD,
      dsStore,
      resourceFork,
      hiddenAudio,
    ]);

    expect(loaded.groups.map((group) => group.name)).toEqual(["A", "D"]);
    expect(loaded.files.map((file) => file.path)).toEqual([
      "A/Conversación/Audio A.wav",
      "A/Conversación/Captura A.jpg",
      "D/Audio D.wav",
    ]);
    expect(loaded.files.every((file) => file.source === "folder")).toBe(true);
    expect(loaded.groups[0].audios[0].associatedCaptureId).toBe(
      loaded.groups[0].images[0].id,
    );
    expect(audioA.webkitRelativePath).toBe(
      "Carpeta contenedora/A/Conversación/Audio A.wav",
    );
    expect(loaded.ignored).toEqual([
      "Carpeta contenedora/.DS_Store",
      "Carpeta contenedora/A/Conversación/._Audio A.wav",
      "Carpeta contenedora/.oculta/secreto.wav",
    ]);
  });

  it("mantiene el nombre de la carpeta elegida como grupo si no hay subcarpetas", async () => {
    const audio = makeFolderFile(
      makeWav(300),
      "Audio.wav",
      "Material de audiencia/Audio.wav",
    );
    const capture = makeFolderFile(
      makeJpeg(),
      "Captura.jpg",
      "Material de audiencia/Captura.jpg",
    );

    const loaded = await loadEvidenceFiles([audio, capture]);

    expect(loaded.groups).toHaveLength(1);
    expect(loaded.groups[0].name).toBe("Material de audiencia");
    expect(loaded.files.map((file) => file.path)).toEqual([
      "Audio.wav",
      "Captura.jpg",
    ]);
    expect(loaded.groups[0].audios[0].associatedCaptureId).toBe(
      loaded.groups[0].images[0].id,
    );
  });

  it("mantiene separadas dos carpetas raíz y asocia su captura sólo a los tres audios propios", async () => {
    const captureA = makeFolderFile(
      makeJpeg(),
      "Captura A.jpg",
      "A/Captura A.jpg",
    );
    const captureB = makeFolderFile(
      makeJpeg(),
      "Captura B.jpg",
      "B/Captura B.jpg",
    );
    const inputs = [
      makeFolderFile(makeWav(101), "Audio A 1.wav", "A/Audio A 1.wav"),
      makeFolderFile(makeWav(201), "Audio B 1.wav", "B/Audio B 1.wav"),
      captureA,
      makeFolderFile(makeWav(102), "Audio A 2.wav", "A/Audio A 2.wav"),
      captureB,
      makeFolderFile(makeWav(202), "Audio B 2.wav", "B/Audio B 2.wav"),
      makeFolderFile(makeWav(103), "Audio A 3.wav", "A/Audio A 3.wav"),
      makeFolderFile(makeWav(203), "Audio B 3.wav", "B/Audio B 3.wav"),
    ];

    const loaded = await loadEvidenceFiles(inputs);
    const [groupA, groupB] = loaded.groups;

    expect(loaded.groups.map((group) => group.name)).toEqual(["A", "B"]);
    expect(groupA.images).toHaveLength(1);
    expect(groupA.audios).toHaveLength(3);
    expect(groupB.images).toHaveLength(1);
    expect(groupB.audios).toHaveLength(3);

    expect(
      groupA.audios.every(
        (audio) =>
          audio.associatedCaptureId === groupA.images[0].id &&
          audio.associatedCaptureIds.length === 1 &&
          audio.associatedCaptureIds[0] === groupA.images[0].id,
      ),
    ).toBe(true);
    expect(
      groupB.audios.every(
        (audio) =>
          audio.associatedCaptureId === groupB.images[0].id &&
          audio.associatedCaptureIds.length === 1 &&
          audio.associatedCaptureIds[0] === groupB.images[0].id,
      ),
    ).toBe(true);
    expect(groupA.audios.map((audio) => audio.associatedCaptureId)).not.toContain(
      groupB.images[0].id,
    );
    expect(groupB.audios.map((audio) => audio.associatedCaptureId)).not.toContain(
      groupA.images[0].id,
    );
  });
});

describe("medios audiovisuales y asociaciones", () => {
  it("clasifica y calcula SHA-256 para un grupo que sólo contiene video", async () => {
    const contents = makeFtyp("isom", ["mp42"]);
    const loaded = await loadEvidenceFiles([
      new File([standaloneBuffer(contents)], "video.mp4"),
    ]);
    const [group] = loaded.groups;
    const [video] = group.videos;

    expect(video).toMatchObject({
      kind: "video",
      detectedFormat: "mp4",
      sha256: await sha256(contents),
    });
    expect(isValidSha256(video.sha256 ?? "")).toBe(true);
    expect(group.media).toEqual([video]);
    expect(group.audios).toHaveLength(0);
    expect(group.images).toHaveLength(0);
  });

  it("permite omitir el hash de todos los medios con la opción nueva o su alias", async () => {
    const file = new File(
      [standaloneBuffer(makeFtyp("isom"))],
      "video.mp4",
    );
    const withNewOption = await loadEvidenceFiles([file], {
      hashMedia: false,
    });
    const withLegacyAlias = await loadEvidenceFiles([file], {
      hashAudio: false,
    });

    expect(withNewOption.groups[0].videos[0].sha256).toBeUndefined();
    expect(withLegacyAlias.groups[0].videos[0].sha256).toBeUndefined();
  });

  it("asocia la única captura del grupo a su audio y su video", async () => {
    const loaded = await loadEvidenceFiles([
      makeFolderFile(makeWav(250), "audio.wav", "A/audio.wav"),
      makeFolderFile(makeFtyp("isom"), "video.mp4", "A/video.mp4"),
      makeFolderFile(makeJpeg(), "captura.jpg", "A/captura.jpg"),
    ]);
    const [group] = loaded.groups;
    const captureId = group.images[0].id;

    expect(group.media).toHaveLength(2);
    expect(group.audios).toHaveLength(1);
    expect(group.videos).toHaveLength(1);
    expect(
      group.media.every(
        (media) =>
          media.associatedCaptureId === captureId &&
          media.associatedCaptureIds[0] === captureId,
      ),
    ).toBe(true);
  });

  it("no inventa una asociación cuando el grupo tiene varias capturas", async () => {
    const loaded = await loadEvidenceFiles([
      makeFolderFile(makeWav(250), "audio.wav", "A/audio.wav"),
      makeFolderFile(makeFtyp("isom"), "video.mp4", "A/video.mp4"),
      makeFolderFile(makeJpeg(), "captura 1.jpg", "A/captura 1.jpg"),
      makeFolderFile(makeJpeg(), "captura 2.jpg", "A/captura 2.jpg"),
    ]);
    const [group] = loaded.groups;

    expect(group.images).toHaveLength(2);
    expect(
      group.media.every(
        (media) =>
          media.associatedCaptureId === undefined &&
          media.associatedCaptureIds.length === 0,
      ),
    ).toBe(true);
  });

  it("mantiene separados los medios y las capturas de carpetas distintas", async () => {
    const loaded = await loadEvidenceFiles([
      makeFolderFile(makeFtyp("isom"), "video A.mp4", "A/video A.mp4"),
      makeFolderFile(makeJpeg(), "captura A.jpg", "A/captura A.jpg"),
      makeFolderFile(makeWav(250), "audio B.wav", "B/audio B.wav"),
      makeFolderFile(makeFtyp("qt  "), "video B.mov", "B/video B.mov"),
      makeFolderFile(makeJpeg(), "captura B.jpg", "B/captura B.jpg"),
    ]);
    const [groupA, groupB] = loaded.groups;

    expect(loaded.groups.map((group) => group.name)).toEqual(["A", "B"]);
    expect(groupA.media.map((media) => media.name)).toEqual(["video A.mp4"]);
    expect(groupB.media.map((media) => media.name)).toEqual([
      "audio B.wav",
      "video B.mov",
    ]);
    expect(
      groupA.media.every(
        (media) => media.associatedCaptureId === groupA.images[0].id,
      ),
    ).toBe(true);
    expect(
      groupB.media.every(
        (media) => media.associatedCaptureId === groupB.images[0].id,
      ),
    ).toBe(true);
    expect(groupA.media[0].associatedCaptureId).not.toBe(groupB.images[0].id);
  });
});

describe("SHA-256", () => {
  it("produce el vector conocido en hexadecimal minúsculo", async () => {
    const bytes = new TextEncoder().encode("abc");
    const hash = await sha256(bytes);

    expect(hash).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(isValidSha256(hash)).toBe(true);
    expect(isValidSha256(hash.toUpperCase())).toBe(false);
    expect(await verifySha256(bytes, hash)).toBe(true);
  });

  it("cambia al modificar un solo byte", async () => {
    const original = new Uint8Array([0, 1, 2, 3, 4]);
    const changed = original.slice();
    changed[3] ^= 0x01;

    const originalHash = await sha256(original);
    const changedHash = await sha256(changed);

    expect(changedHash).not.toBe(originalHash);
    expect(await verifySha256(changed, originalHash)).toBe(false);
  });
});

describe("seguridad ZIP", () => {
  it("rechaza entradas con path traversal sin alterar nombres seguros", async () => {
    const zip = new JSZip();
    zip.file("../escape.mp3", new Uint8Array([0x49, 0x44, 0x33]));
    zip.file("seguro.jpg", standaloneBuffer(makeJpeg()));
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const file = new File([standaloneBuffer(bytes)], "A.zip");

    const loaded = await loadEvidenceFiles([file]);

    expect(loaded.rejected).toEqual([
      expect.objectContaining({ path: "../escape.mp3" }),
    ]);
    expect(loaded.files.map((item) => item.name)).toEqual(["seguro.jpg"]);
  });

  it("rechaza ZIP corruptos y relaciones de compresión sospechosas", async () => {
    const corrupt = new File(
      [new TextEncoder().encode("no es un zip").buffer],
      "dañado.zip",
    );
    const corruptResult = await loadEvidenceFiles([corrupt]);
    expect(corruptResult.rejected[0].reason).toContain("válido");

    const zip = new JSZip();
    zip.file("ceros.wav", new Uint8Array(20_000));
    const bytes = await zip.generateAsync({
      type: "uint8array",
      compression: "DEFLATE",
      compressionOptions: { level: 9 },
    });
    const suspicious = new File([standaloneBuffer(bytes)], "sospechoso.zip");
    const suspiciousResult = await loadEvidenceFiles([suspicious], {
      limits: { maxCompressionRatio: 2 },
    });

    expect(suspiciousResult.groups).toHaveLength(0);
    expect(suspiciousResult.rejected[0].reason).toContain(
      "relación de compresión sospechosa",
    );
  });

  it("rechaza una entrada cuyo contenido no coincide con su CRC", async () => {
    const originalPayload = new Uint8Array([
      0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x11, 0x22, 0x33, 0x44,
    ]);
    const zip = new JSZip();
    zip.file("audio.mp3", standaloneBuffer(originalPayload), {
      compression: "STORE",
    });
    const generated = await zip.generateAsync({
      type: "uint8array",
      compression: "STORE",
    });
    const tampered = generated.slice();
    let payloadOffset = -1;
    for (
      let offset = 0;
      offset <= tampered.length - originalPayload.length;
      offset += 1
    ) {
      if (
        originalPayload.every(
          (byte, index) => tampered[offset + index] === byte,
        )
      ) {
        payloadOffset = offset;
        break;
      }
    }
    expect(payloadOffset).toBeGreaterThanOrEqual(0);
    tampered[payloadOffset + originalPayload.length - 1] ^= 0x01;

    const result = await loadEvidenceFiles([
      new File([standaloneBuffer(tampered)], "alterado.zip"),
    ]);

    expect(result.files).toHaveLength(0);
    expect(result.rejected[0].reason).toContain("CRC");
  });

  it("interrumpe una entrada que se expande más de lo declarado", async () => {
    const zip = new JSZip();
    zip.file("bomba.wav", new Uint8Array(2_000_000));
    const generated = await zip.generateAsync({
      type: "uint8array",
      compression: "DEFLATE",
      compressionOptions: { level: 9 },
    });
    const forged = generated.slice();
    const view = new DataView(
      forged.buffer,
      forged.byteOffset,
      forged.byteLength,
    );
    for (let offset = 0; offset + 28 <= forged.length; offset += 1) {
      if (view.getUint32(offset, true) === 0x04034b50) {
        view.setUint32(offset + 22, 1, true);
      } else if (view.getUint32(offset, true) === 0x02014b50) {
        view.setUint32(offset + 24, 1, true);
      }
    }

    const result = await loadEvidenceFiles(
      [new File([standaloneBuffer(forged)], "bomba.zip")],
      {
        limits: {
          maxEntryUncompressedBytes: 1_024,
          maxTotalUncompressedBytes: 2_048,
        },
      },
    );

    expect(result.files).toHaveLength(0);
    expect(result.rejected[0].reason).toContain("más que el tamaño declarado");
  });

  it("cuenta entradas centrales aunque JSZip colapse nombres duplicados", async () => {
    const zip = new JSZip();
    zip.file("a.txt", "uno");
    zip.file("b.txt", "dos");
    const generated = await zip.generateAsync({
      type: "uint8array",
      compression: "STORE",
    });
    const forged = generated.slice();
    const view = new DataView(
      forged.buffer,
      forged.byteOffset,
      forged.byteLength,
    );
    for (let offset = 0; offset + 51 <= forged.length; offset += 1) {
      if (
        view.getUint32(offset, true) === 0x04034b50 &&
        String.fromCharCode(...forged.slice(offset + 30, offset + 35)) ===
          "b.txt"
      ) {
        writeAscii(forged, offset + 30, "a.txt");
      } else if (
        view.getUint32(offset, true) === 0x02014b50 &&
        String.fromCharCode(...forged.slice(offset + 46, offset + 51)) ===
          "b.txt"
      ) {
        writeAscii(forged, offset + 46, "a.txt");
      }
    }

    const result = await loadEvidenceFiles([
      new File([standaloneBuffer(forged)], "duplicados.zip"),
    ]);

    expect(result.groups).toHaveLength(0);
    expect(result.rejected[0].reason).toContain("duplicados");
  });
});
