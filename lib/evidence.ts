import JSZip, { type JSZipObject } from "jszip";

export type DetectedFormat =
  | "wav"
  | "ogg"
  | "opus"
  | "mp3"
  | "m4a"
  | "aac"
  | "jpeg"
  | "png"
  | "webp"
  | "heic"
  | "unknown";

export type EvidenceKind = "audio" | "image" | "unknown";
export type EvidenceSource = "zip" | "folder" | "loose";

export interface WavDuration {
  milliseconds: number;
  formatted: string;
}

export interface EvidenceFile {
  id: string;
  file: File;
  name: string;
  path: string;
  groupId: string;
  group: string;
  source: EvidenceSource;
  size: number;
  /** Original extension, including its dot and original casing. */
  extension: string;
  detectedFormat: DetectedFormat;
  kind: EvidenceKind;
  warning?: string;
  durationMs?: number;
  duration?: string;
  sha256?: string;
  associatedCaptureId?: string;
  associatedCaptureIds: string[];
}

export interface EvidenceGroup {
  id: string;
  name: string;
  sourceFile?: File;
  files: EvidenceFile[];
  audios: EvidenceFile[];
  images: EvidenceFile[];
}

export interface EvidenceRejection {
  path: string;
  sourceFile?: string;
  reason: string;
}

export interface EvidenceLimits {
  maxInputFiles: number;
  maxTotalInputBytes: number;
  maxZipCompressedBytes: number;
  maxZipEntries: number;
  maxEntryUncompressedBytes: number;
  maxTotalUncompressedBytes: number;
  maxCompressionRatio: number;
}

export interface EvidenceLoadOptions {
  limits?: Partial<EvidenceLimits>;
  /** Hash detected audio files during loading. Defaults to true. */
  hashAudio?: boolean;
}

export interface EvidenceLoadResult {
  groups: EvidenceGroup[];
  files: EvidenceFile[];
  ignored: string[];
  rejected: EvidenceRejection[];
  warnings: string[];
}

export const DEFAULT_EVIDENCE_LIMITS: Readonly<EvidenceLimits> = {
  maxInputFiles: 500,
  maxTotalInputBytes: 1024 * 1024 * 1024,
  maxZipCompressedBytes: 256 * 1024 * 1024,
  maxZipEntries: 2_000,
  maxEntryUncompressedBytes: 256 * 1024 * 1024,
  maxTotalUncompressedBytes: 1024 * 1024 * 1024,
  maxCompressionRatio: 2_000,
};

const AUDIO_FORMATS: ReadonlySet<DetectedFormat> = new Set([
  "wav",
  "ogg",
  "opus",
  "mp3",
  "m4a",
  "aac",
]);

const IMAGE_FORMATS: ReadonlySet<DetectedFormat> = new Set([
  "jpeg",
  "png",
  "webp",
  "heic",
]);

const EXPECTED_FORMATS_BY_EXTENSION: Readonly<
  Record<string, readonly DetectedFormat[]>
> = {
  wav: ["wav"],
  ogg: ["ogg", "opus"],
  opus: ["opus"],
  mp3: ["mp3"],
  m4a: ["m4a"],
  aac: ["aac"],
  jpg: ["jpeg"],
  jpeg: ["jpeg"],
  png: ["png"],
  webp: ["webp"],
  heic: ["heic"],
  heif: ["heic"],
};

const FORMAT_LABELS: Readonly<Record<DetectedFormat, string>> = {
  wav: "WAV",
  ogg: "OGG",
  opus: "Opus",
  mp3: "MP3",
  m4a: "M4A",
  aac: "AAC",
  jpeg: "JPEG",
  png: "PNG",
  webp: "WebP",
  heic: "HEIC/HEIF",
  unknown: "desconocido",
};

const HEADER_BYTES = 4_096;
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

type BinaryInput = Blob | ArrayBuffer | Uint8Array;

type ZipObjectWithMetadata = JSZipObject & {
  unsafeOriginalName?: string;
  internalStream?: (type: "uint8array") => JSZip.JSZipStreamHelper<Uint8Array>;
  _data?: {
    compressedSize?: number;
    uncompressedSize?: number;
    crc32?: number;
  };
};

interface MutableGroup extends EvidenceGroup {
  files: EvidenceFile[];
  audios: EvidenceFile[];
  images: EvidenceFile[];
}

interface ZipCentralDirectorySummary {
  entryCount: number;
}

class ZipSafetyError extends Error {}

function asBytes(input: ArrayBuffer | Uint8Array): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

function asciiEquals(
  bytes: Uint8Array,
  offset: number,
  expected: string,
): boolean {
  if (offset < 0 || offset + expected.length > bytes.length) {
    return false;
  }

  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[offset + index] !== expected.charCodeAt(index)) {
      return false;
    }
  }

  return true;
}

function findAscii(
  bytes: Uint8Array,
  expected: string,
  start = 0,
  end = bytes.length,
): boolean {
  const lastStart = Math.min(end, bytes.length) - expected.length;
  for (let offset = Math.max(0, start); offset <= lastStart; offset += 1) {
    if (asciiEquals(bytes, offset, expected)) {
      return true;
    }
  }
  return false;
}

function readUint32BigEndian(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 0x1000000 +
    bytes[offset + 1] * 0x10000 +
    bytes[offset + 2] * 0x100 +
    bytes[offset + 3]
  );
}

function originalExtension(name: string): string {
  const dotIndex = name.lastIndexOf(".");
  return dotIndex > 0 ? name.slice(dotIndex) : "";
}

function extensionKey(name: string): string {
  return originalExtension(name).slice(1).toLocaleLowerCase("en-US");
}

function isZipSignature(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) ||
      (bytes[2] === 0x05 && bytes[3] === 0x06) ||
      (bytes[2] === 0x07 && bytes[3] === 0x08))
  );
}

function validateLimits(limits: EvidenceLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`El límite ${name} debe ser un número positivo.`);
    }
  }
}

function zipMetadataNumber(
  entry: ZipObjectWithMetadata,
  key: "compressedSize" | "uncompressedSize",
): number | undefined {
  const value = entry._data?.[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function zipExpectedCrc32(entry: ZipObjectWithMetadata): number | undefined {
  const value = entry._data?.crc32;
  return typeof value === "number" && Number.isInteger(value)
    ? value >>> 0
    : undefined;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} bytes`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function inspectZipCentralDirectory(
  input: ArrayBuffer,
  limits: EvidenceLimits,
): ZipCentralDirectorySummary {
  const bytes = new Uint8Array(input);
  if (bytes.length < 22) {
    throw new ZipSafetyError(
      "El ZIP no contiene un directorio central válido.",
    );
  }

  const view = new DataView(input);
  const earliestEocd = Math.max(0, bytes.length - 22 - 0xffff);
  let eocdOffset = -1;

  for (let offset = bytes.length - 22; offset >= earliestEocd; offset -= 1) {
    if (
      view.getUint32(offset, true) === 0x06054b50 &&
      offset + 22 + view.getUint16(offset + 20, true) === bytes.length
    ) {
      eocdOffset = offset;
      break;
    }
  }

  if (eocdOffset < 0) {
    throw new ZipSafetyError("El ZIP no contiene un cierre válido.");
  }

  const diskNumber = view.getUint16(eocdOffset + 4, true);
  const centralDirectoryDisk = view.getUint16(eocdOffset + 6, true);
  const entriesOnDisk = view.getUint16(eocdOffset + 8, true);
  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralDirectorySize = view.getUint32(eocdOffset + 12, true);
  const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true);

  if (
    diskNumber !== 0 ||
    centralDirectoryDisk !== 0 ||
    entriesOnDisk !== entryCount
  ) {
    throw new ZipSafetyError(
      "Los ZIP divididos en varios volúmenes no están admitidos.",
    );
  }
  if (
    entryCount === 0xffff ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff
  ) {
    throw new ZipSafetyError(
      "ZIP64 no es necesario dentro de los límites preventivos y fue rechazado.",
    );
  }
  if (entryCount > limits.maxZipEntries) {
    throw new ZipSafetyError(
      `El ZIP contiene ${entryCount} entradas; el máximo preventivo es ${limits.maxZipEntries}.`,
    );
  }

  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;
  if (
    centralDirectoryEnd < centralDirectoryOffset ||
    centralDirectoryEnd > eocdOffset
  ) {
    throw new ZipSafetyError(
      "El directorio central del ZIP declara límites inválidos.",
    );
  }

  let cursor = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (
      cursor + 46 > centralDirectoryEnd ||
      view.getUint32(cursor, true) !== 0x02014b50
    ) {
      throw new ZipSafetyError(
        "El directorio central del ZIP está truncado o dañado.",
      );
    }

    const flags = view.getUint16(cursor + 8, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);
    const nextCursor = cursor + 46 + nameLength + extraLength + commentLength;

    if (flags & 0x0001) {
      throw new ZipSafetyError(
        "El ZIP contiene entradas cifradas, que no pueden auditarse de forma local.",
      );
    }
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      throw new ZipSafetyError(
        "El ZIP usa metadatos ZIP64 fuera de los límites admitidos.",
      );
    }
    if (nameLength === 0 || nextCursor > centralDirectoryEnd) {
      throw new ZipSafetyError(
        "Una entrada del ZIP tiene un encabezado inválido.",
      );
    }

    cursor = nextCursor;
  }

  if (cursor !== centralDirectoryEnd) {
    throw new ZipSafetyError(
      "El directorio central del ZIP contiene datos inesperados.",
    );
  }

  return { entryCount };
}

async function extractZipEntrySafely(
  entry: ZipObjectWithMetadata,
  expectedSize: number,
  expectedCrc32: number,
): Promise<Array<Uint8Array<ArrayBuffer>>> {
  const stream = entry.internalStream?.("uint8array");
  if (!stream) {
    throw new ZipSafetyError(
      "No fue posible abrir la entrada como flujo limitado.",
    );
  }

  return new Promise((resolve, reject) => {
    const parts: Array<Uint8Array<ArrayBuffer>> = [];
    let actualSize = 0;
    let checksum = 0xffffffff;
    let settled = false;

    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      stream.pause();
      reject(error);
    };

    stream
      .on("data", (chunk) => {
        if (settled) {
          return;
        }

        actualSize += chunk.byteLength;
        if (actualSize > expectedSize) {
          fail(
            new ZipSafetyError(
              "La entrada se expandió más que el tamaño declarado y fue interrumpida.",
            ),
          );
          return;
        }

        const copy = new Uint8Array(chunk.byteLength);
        copy.set(chunk);
        parts.push(copy);
        for (const byte of copy) {
          checksum = CRC32_TABLE[(checksum ^ byte) & 0xff] ^ (checksum >>> 8);
        }
      })
      .on("error", (error) => {
        fail(error);
      })
      .on("end", () => {
        if (settled) {
          return;
        }
        if (actualSize !== expectedSize) {
          fail(
            new ZipSafetyError(
              "La entrada no coincide con el tamaño declarado en el ZIP.",
            ),
          );
          return;
        }
        if ((checksum ^ 0xffffffff) >>> 0 !== expectedCrc32) {
          fail(
            new ZipSafetyError(
              "La entrada no superó la verificación CRC del ZIP y puede estar dañada.",
            ),
          );
          return;
        }

        settled = true;
        resolve(parts);
      })
      .resume();
  });
}

function pathSegments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

function getRelativeFilePath(file: File): string {
  const relativePath = file.webkitRelativePath;
  return relativePath && relativePath.length > 0 ? relativePath : file.name;
}

function isDangerousSelectedFilePath(file: File, path: string): boolean {
  if (!file.name || file.name.includes("\0") || file.name.includes("/")) {
    return true;
  }

  if (!file.webkitRelativePath) {
    return false;
  }

  return (
    path.startsWith("/") ||
    path.includes("\0") ||
    path.length > 4_096 ||
    path.split("/").some((segment) => segment === "..")
  );
}

function commonSelectedFolderRoot(files: readonly File[]): string | undefined {
  let root: string | undefined;
  let folderFileCount = 0;

  for (const file of files) {
    const path = getRelativeFilePath(file);
    if (
      !file.webkitRelativePath ||
      isDangerousSelectedFilePath(file, path) ||
      isMacOSJunk(path)
    ) {
      continue;
    }

    const segments = pathSegments(path);
    if (segments.length < 2) {
      continue;
    }

    const candidate = segments[0];
    if (root !== undefined && candidate !== root) {
      return undefined;
    }

    root = candidate;
    folderFileCount += 1;
  }

  return folderFileCount > 0 ? root : undefined;
}

function stripSelectedFolderRoot(
  path: string,
  commonRoot: string | undefined,
): string {
  if (!commonRoot || !path.startsWith(`${commonRoot}/`)) {
    return path;
  }

  const relativePath = path.slice(commonRoot.length + 1);
  return relativePath.length > 0 ? relativePath : path;
}

function groupNameForZip(fileName: string): string {
  const basename = safeBasename(fileName);
  if (basename.toLocaleLowerCase("en-US").endsWith(".zip")) {
    const withoutExtension = basename.slice(0, -4);
    return withoutExtension || basename;
  }
  return basename;
}

function getOrCreateGroup(
  groupMap: Map<string, MutableGroup>,
  groups: MutableGroup[],
  key: string,
  name: string,
  sourceFile?: File,
): MutableGroup {
  const existing = groupMap.get(key);
  if (existing) {
    return existing;
  }

  const group: MutableGroup = {
    id: `group-${groups.length + 1}`,
    name,
    sourceFile,
    files: [],
    audios: [],
    images: [],
  };
  groupMap.set(key, group);
  groups.push(group);
  return group;
}

function addFileToGroup(group: MutableGroup, evidence: EvidenceFile): void {
  group.files.push(evidence);
  if (evidence.kind === "audio") {
    group.audios.push(evidence);
  } else if (evidence.kind === "image") {
    group.images.push(evidence);
  }
}

async function toArrayBuffer(input: BinaryInput): Promise<ArrayBuffer> {
  if (input instanceof Blob) {
    return input.arrayBuffer();
  }

  if (input instanceof Uint8Array) {
    const copy = new Uint8Array(input.byteLength);
    copy.set(input);
    return copy.buffer;
  }

  return input;
}

async function processEvidenceFile(
  file: File,
  path: string,
  group: MutableGroup,
  source: EvidenceSource,
  id: string,
  hashAudio: boolean,
): Promise<EvidenceFile> {
  const name = file.name;
  const header = await file.slice(0, HEADER_BYTES).arrayBuffer();
  const detectedFormat = detectFormat(header);
  const kind = classifyFormat(detectedFormat);
  const warning = getFormatWarning(name, detectedFormat);

  const evidence: EvidenceFile = {
    id,
    file,
    name,
    path,
    groupId: group.id,
    group: group.name,
    source,
    size: file.size,
    extension: originalExtension(name),
    detectedFormat,
    kind,
    warning,
    associatedCaptureIds: [],
  };

  if (kind === "audio" && (hashAudio || detectedFormat === "wav")) {
    const contents = await file.arrayBuffer();

    if (hashAudio) {
      evidence.sha256 = await sha256(contents);
    }

    if (detectedFormat === "wav") {
      const wavDuration = readWavDuration(contents);
      if (wavDuration) {
        evidence.durationMs = wavDuration.milliseconds;
        evidence.duration = wavDuration.formatted;
      }
    }
  }

  return evidence;
}

/**
 * Returns a path's final component without changing its Unicode normalization,
 * spacing, capitalization, or apparent spelling mistakes.
 */
export function safeBasename(path: string): string {
  if (typeof path !== "string" || path.length === 0) {
    throw new TypeError("La ruta del archivo no puede estar vacía.");
  }
  if (path.includes("\0")) {
    throw new TypeError("La ruta contiene un carácter nulo.");
  }

  const segments = pathSegments(path);
  const basename = segments.at(-1);
  if (!basename || basename === "." || basename === "..") {
    throw new TypeError("La ruta no contiene un nombre de archivo seguro.");
  }
  return basename;
}

export function isDangerousPath(path: string): boolean {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.length > 4_096 ||
    path.includes("\0")
  ) {
    return true;
  }

  const slashPath = path.replaceAll("\\", "/");
  if (
    slashPath.startsWith("/") ||
    /^[A-Za-z]:/.test(slashPath) ||
    slashPath.startsWith("//")
  ) {
    return true;
  }

  const segments = slashPath.split("/");
  return (
    segments.some((segment) => segment === "..") ||
    pathSegments(slashPath).at(-1) === "."
  );
}

export function isMacOSJunk(path: string): boolean {
  const segments = pathSegments(path);
  if (segments.includes("__MACOSX")) {
    return true;
  }

  const basename = segments.at(-1) ?? "";
  return (
    basename === ".DS_Store" ||
    basename.startsWith("._") ||
    segments.some((segment) => segment.startsWith("."))
  );
}

/**
 * Detects content from magic bytes. File names and MIME declarations are
 * intentionally not considered.
 */
export function detectFormat(input: ArrayBuffer | Uint8Array): DetectedFormat {
  const bytes = asBytes(input);

  if (asciiEquals(bytes, 0, "RIFF") && asciiEquals(bytes, 8, "WAVE")) {
    return "wav";
  }

  if (asciiEquals(bytes, 0, "RIFF") && asciiEquals(bytes, 8, "WEBP")) {
    return "webp";
  }

  if (asciiEquals(bytes, 0, "OggS")) {
    if (findAscii(bytes, "theora", 4, HEADER_BYTES)) {
      return "unknown";
    }
    return findAscii(bytes, "OpusHead", 4, HEADER_BYTES) ? "opus" : "ogg";
  }

  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "jpeg";
  }

  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    asciiEquals(bytes, 1, "PNG") &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "png";
  }

  if (bytes.length >= 12 && asciiEquals(bytes, 4, "ftyp")) {
    const declaredBoxSize = readUint32BigEndian(bytes, 0);
    const boxEnd =
      declaredBoxSize >= 12
        ? Math.min(declaredBoxSize, bytes.length)
        : Math.min(bytes.length, HEADER_BYTES);
    const brands: string[] = [];

    for (let offset = 8; offset + 4 <= boxEnd; offset += 4) {
      brands.push(
        String.fromCharCode(
          bytes[offset],
          bytes[offset + 1],
          bytes[offset + 2],
          bytes[offset + 3],
        ),
      );
    }

    const heicBrands = new Set([
      "heic",
      "heix",
      "hevc",
      "hevx",
      "heim",
      "heis",
    ]);
    if (brands.some((brand) => heicBrands.has(brand))) {
      return "heic";
    }

    const m4aBrands = new Set(["M4A ", "M4B ", "M4P "]);
    if (brands.some((brand) => m4aBrands.has(brand))) {
      return "m4a";
    }
  }

  // ADTS AAC has a 12-bit sync word and a zero MPEG layer.
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) {
    return "aac";
  }

  if (
    asciiEquals(bytes, 0, "ID3") ||
    (bytes.length >= 2 &&
      bytes[0] === 0xff &&
      (bytes[1] & 0xe0) === 0xe0 &&
      (bytes[1] & 0x06) !== 0)
  ) {
    return "mp3";
  }

  if (asciiEquals(bytes, 0, "ADIF")) {
    return "aac";
  }

  return "unknown";
}

export async function detectFileFormat(file: Blob): Promise<DetectedFormat> {
  return detectFormat(await file.slice(0, HEADER_BYTES).arrayBuffer());
}

export function classifyFormat(format: DetectedFormat): EvidenceKind {
  if (AUDIO_FORMATS.has(format)) {
    return "audio";
  }
  if (IMAGE_FORMATS.has(format)) {
    return "image";
  }
  return "unknown";
}

export function getFormatWarning(
  fileName: string,
  detectedFormat: DetectedFormat,
): string | undefined {
  const extension = extensionKey(fileName);
  const expected = EXPECTED_FORMATS_BY_EXTENSION[extension];

  if (!expected && detectedFormat === "unknown") {
    return undefined;
  }

  if (expected?.includes(detectedFormat)) {
    return undefined;
  }

  const shownExtension = originalExtension(fileName) || "(sin extensión)";
  if (detectedFormat === "unknown") {
    return `La extensión ${shownExtension} no coincide con un formato reconocido por el contenido. El archivo no fue modificado.`;
  }

  return `La extensión ${shownExtension} no coincide con el contenido detectado (${FORMAT_LABELS[detectedFormat]}). El archivo no fue modificado.`;
}

export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new RangeError("La duración debe ser un número no negativo.");
  }

  const roundedMilliseconds = Math.round(milliseconds);
  const minutes = Math.floor(roundedMilliseconds / 60_000);
  const seconds = Math.floor((roundedMilliseconds % 60_000) / 1_000);
  const millis = roundedMilliseconds % 1_000;

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

/**
 * Reads RIFF chunks instead of assuming a fixed 44-byte WAV header.
 */
export function readWavDuration(
  input: ArrayBuffer | Uint8Array,
): WavDuration | null {
  const bytes = asBytes(input);
  if (detectFormat(bytes) !== "wav" || bytes.length < 12) {
    return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let byteRate: number | undefined;
  let dataBytes = 0;
  let foundData = false;

  while (offset + 8 <= bytes.length) {
    const chunkId = String.fromCharCode(
      bytes[offset],
      bytes[offset + 1],
      bytes[offset + 2],
      bytes[offset + 3],
    );
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkDataStart = offset + 8;
    const chunkDataEnd = chunkDataStart + chunkSize;

    if (chunkDataEnd < chunkDataStart || chunkDataEnd > bytes.length) {
      return null;
    }

    if (chunkId === "fmt " && chunkSize >= 16) {
      const declaredByteRate = view.getUint32(chunkDataStart + 8, true);
      const sampleRate = view.getUint32(chunkDataStart + 4, true);
      const blockAlign = view.getUint16(chunkDataStart + 12, true);
      const derivedByteRate = sampleRate * blockAlign;
      byteRate =
        declaredByteRate > 0
          ? declaredByteRate
          : derivedByteRate > 0
            ? derivedByteRate
            : undefined;
    } else if (chunkId === "data") {
      dataBytes += chunkSize;
      foundData = true;
    }

    offset = chunkDataEnd + (chunkSize % 2);
  }

  if (!foundData || !byteRate || byteRate <= 0) {
    return null;
  }

  const milliseconds = Math.round((dataBytes / byteRate) * 1_000);
  return {
    milliseconds,
    formatted: formatDuration(milliseconds),
  };
}

export async function sha256(input: BinaryInput): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("Web Crypto API no está disponible en este navegador.");
  }

  const digest = await subtle.digest("SHA-256", await toArrayBuffer(input));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function isValidSha256(hash: string): boolean {
  return /^[0-9a-f]{64}$/.test(hash);
}

export async function verifySha256(
  input: BinaryInput,
  expectedHash: string,
): Promise<boolean> {
  if (!isValidSha256(expectedHash)) {
    return false;
  }
  return (await sha256(input)) === expectedHash;
}

export async function loadEvidenceFiles(
  inputs: Iterable<File> | ArrayLike<File>,
  options: EvidenceLoadOptions = {},
): Promise<EvidenceLoadResult> {
  const inputFiles = Array.from(inputs);
  const limits: EvidenceLimits = {
    ...DEFAULT_EVIDENCE_LIMITS,
    ...options.limits,
  };
  validateLimits(limits);

  if (inputFiles.length > limits.maxInputFiles) {
    throw new RangeError(
      `Se seleccionaron ${inputFiles.length} archivos; el máximo preventivo es ${limits.maxInputFiles}.`,
    );
  }
  const totalInputBytes = inputFiles.reduce(
    (total, file) => total + file.size,
    0,
  );
  if (totalInputBytes > limits.maxTotalInputBytes) {
    throw new RangeError(
      `La selección ocupa ${formatBytes(totalInputBytes)}; el máximo preventivo de entrada es ${formatBytes(limits.maxTotalInputBytes)}.`,
    );
  }

  const hashAudio = options.hashAudio ?? true;
  const groups: MutableGroup[] = [];
  const groupMap = new Map<string, MutableGroup>();
  const ignored: string[] = [];
  const rejected: EvidenceRejection[] = [];
  const warnings: string[] = [];
  let fileSequence = 0;
  let acceptedUncompressedBytes = 0;
  const selectedFolderRoot = commonSelectedFolderRoot(inputFiles);

  const nextFileId = (): string => {
    fileSequence += 1;
    return `evidence-${fileSequence}`;
  };

  for (let inputIndex = 0; inputIndex < inputFiles.length; inputIndex += 1) {
    const inputFile = inputFiles[inputIndex];
    const inputPath = getRelativeFilePath(inputFile);

    if (isMacOSJunk(inputPath)) {
      ignored.push(inputPath);
      continue;
    }

    if (isDangerousSelectedFilePath(inputFile, inputPath)) {
      rejected.push({
        path: inputPath,
        reason:
          "La ruta es absoluta o contiene segmentos de navegación peligrosos.",
      });
      continue;
    }

    const signature = new Uint8Array(await inputFile.slice(0, 4).arrayBuffer());
    const isZip =
      extensionKey(inputFile.name) === "zip" || isZipSignature(signature);

    if (isZip) {
      if (inputFile.size > limits.maxZipCompressedBytes) {
        rejected.push({
          path: inputFile.name,
          sourceFile: inputFile.name,
          reason: `El ZIP supera el máximo comprimido de ${formatBytes(limits.maxZipCompressedBytes)}.`,
        });
        continue;
      }

      let zipData: ArrayBuffer;
      let centralDirectory: ZipCentralDirectorySummary;
      try {
        zipData = await inputFile.arrayBuffer();
        centralDirectory = inspectZipCentralDirectory(zipData, limits);
      } catch (error) {
        rejected.push({
          path: inputFile.name,
          sourceFile: inputFile.name,
          reason:
            error instanceof ZipSafetyError
              ? error.message
              : "El ZIP está dañado o no tiene una estructura válida.",
        });
        continue;
      }

      let zip: JSZip;
      try {
        zip = await JSZip.loadAsync(zipData);
      } catch {
        rejected.push({
          path: inputFile.name,
          sourceFile: inputFile.name,
          reason: "El ZIP está dañado o no tiene una estructura válida.",
        });
        continue;
      }

      const entries = Object.values(zip.files) as ZipObjectWithMetadata[];
      if (entries.length !== centralDirectory.entryCount) {
        rejected.push({
          path: inputFile.name,
          sourceFile: inputFile.name,
          reason:
            "El ZIP contiene nombres de entrada duplicados o incompatibles y fue rechazado.",
        });
        continue;
      }

      let archiveUncompressedBytes = 0;
      let archiveUnsafeReason: string | undefined;
      for (const entry of entries) {
        if (entry.dir) {
          continue;
        }

        const originalPath = entry.unsafeOriginalName ?? entry.name;
        if (
          isDangerousPath(originalPath) ||
          isMacOSJunk(originalPath.replaceAll("\\", "/"))
        ) {
          continue;
        }

        const uncompressedSize = zipMetadataNumber(entry, "uncompressedSize");
        const compressedSize = zipMetadataNumber(entry, "compressedSize");
        const expectedCrc32 = zipExpectedCrc32(entry);
        if (
          uncompressedSize === undefined ||
          compressedSize === undefined ||
          expectedCrc32 === undefined
        ) {
          archiveUnsafeReason =
            "No fue posible comprobar de forma segura los tamaños declarados del ZIP.";
          break;
        }
        if (uncompressedSize > limits.maxEntryUncompressedBytes) {
          archiveUnsafeReason = `Una entrada supera el máximo descomprimido de ${formatBytes(limits.maxEntryUncompressedBytes)}.`;
          break;
        }

        const compressionRatio =
          compressedSize === 0
            ? uncompressedSize === 0
              ? 1
              : Number.POSITIVE_INFINITY
            : uncompressedSize / compressedSize;
        if (compressionRatio > limits.maxCompressionRatio) {
          archiveUnsafeReason = `Una entrada tiene una relación de compresión sospechosa (superior a ${limits.maxCompressionRatio}:1).`;
          break;
        }

        archiveUncompressedBytes += uncompressedSize;
        if (archiveUncompressedBytes > limits.maxTotalUncompressedBytes) {
          archiveUnsafeReason = `El ZIP supera el máximo total descomprimido de ${formatBytes(limits.maxTotalUncompressedBytes)}.`;
          break;
        }
      }

      if (
        !archiveUnsafeReason &&
        acceptedUncompressedBytes + archiveUncompressedBytes >
          limits.maxTotalUncompressedBytes
      ) {
        archiveUnsafeReason = `La selección supera el máximo total descomprimido de ${formatBytes(limits.maxTotalUncompressedBytes)}.`;
      }

      if (archiveUnsafeReason) {
        rejected.push({
          path: inputFile.name,
          sourceFile: inputFile.name,
          reason: archiveUnsafeReason,
        });
        continue;
      }

      acceptedUncompressedBytes += archiveUncompressedBytes;
      const group = getOrCreateGroup(
        groupMap,
        groups,
        `zip:${inputIndex}`,
        groupNameForZip(inputFile.name),
        inputFile,
      );

      const candidates = entries
        .filter((entry) => !entry.dir)
        .map((entry) => ({
          entry,
          originalPath: entry.unsafeOriginalName ?? entry.name,
        }))
        .sort((left, right) =>
          left.originalPath < right.originalPath
            ? -1
            : left.originalPath > right.originalPath
              ? 1
              : 0,
        );

      let extractionUnsafeReason: string | undefined;
      for (const { entry, originalPath } of candidates) {
        if (isDangerousPath(originalPath)) {
          rejected.push({
            path: originalPath,
            sourceFile: inputFile.name,
            reason:
              "La entrada del ZIP contiene una ruta absoluta o segmentos de navegación peligrosos.",
          });
          continue;
        }
        let name: string;
        try {
          name = safeBasename(originalPath.replaceAll("\\", "/"));
        } catch {
          rejected.push({
            path: originalPath,
            sourceFile: inputFile.name,
            reason:
              "La entrada del ZIP no contiene un nombre de archivo seguro.",
          });
          continue;
        }
        if (isMacOSJunk(originalPath.replaceAll("\\", "/"))) {
          ignored.push(`${inputFile.name}/${originalPath}`);
          continue;
        }

        const expectedSize = zipMetadataNumber(entry, "uncompressedSize");
        const expectedCrc32 = zipExpectedCrc32(entry);
        if (expectedSize === undefined || expectedCrc32 === undefined) {
          rejected.push({
            path: originalPath,
            sourceFile: inputFile.name,
            reason:
              "No fue posible comprobar el tamaño o CRC declarado de esta entrada.",
          });
          continue;
        }

        let parts: Array<Uint8Array<ArrayBuffer>>;
        try {
          parts = await extractZipEntrySafely(
            entry,
            expectedSize,
            expectedCrc32,
          );
        } catch (error) {
          const reason =
            error instanceof ZipSafetyError
              ? error.message
              : "No se pudo descomprimir esta entrada del ZIP.";
          rejected.push({
            path: originalPath,
            sourceFile: inputFile.name,
            reason,
          });
          extractionUnsafeReason = reason;
          break;
        }

        const extractedFile = new File(parts, name, {
          lastModified: entry.date?.getTime(),
        });
        const evidence = await processEvidenceFile(
          extractedFile,
          originalPath,
          group,
          "zip",
          nextFileId(),
          hashAudio,
        );
        addFileToGroup(group, evidence);
        if (evidence.warning) {
          warnings.push(
            `${group.name} / ${evidence.name}: ${evidence.warning}`,
          );
        }
      }

      if (extractionUnsafeReason) {
        group.files.length = 0;
        group.audios.length = 0;
        group.images.length = 0;
        const groupIndex = groups.indexOf(group);
        if (groupIndex >= 0) {
          groups.splice(groupIndex, 1);
        }
        groupMap.delete(`zip:${inputIndex}`);
        acceptedUncompressedBytes -= archiveUncompressedBytes;
        rejected.push({
          path: inputFile.name,
          sourceFile: inputFile.name,
          reason: `Se rechazó el ZIP completo porque una entrada no pudo verificarse de forma segura: ${extractionUnsafeReason}`,
        });
      }

      continue;
    }

    if (inputFile.size > limits.maxEntryUncompressedBytes) {
      rejected.push({
        path: inputPath,
        reason: `El archivo supera el máximo de ${formatBytes(limits.maxEntryUncompressedBytes)}.`,
      });
      continue;
    }
    if (
      acceptedUncompressedBytes + inputFile.size >
      limits.maxTotalUncompressedBytes
    ) {
      rejected.push({
        path: inputPath,
        reason: `La selección supera el máximo total de ${formatBytes(limits.maxTotalUncompressedBytes)}.`,
      });
      continue;
    }
    acceptedUncompressedBytes += inputFile.size;

    const folderPath = stripSelectedFolderRoot(inputPath, selectedFolderRoot);
    const segments = pathSegments(folderPath);
    const isFolderFile =
      Boolean(inputFile.webkitRelativePath) &&
      pathSegments(inputPath).length > 1;
    const groupName = isFolderFile
      ? segments.length > 1
        ? segments[0]
        : (selectedFolderRoot ?? pathSegments(inputPath)[0])
      : "Archivos sueltos";
    const groupKey = isFolderFile ? `folder:${groupName}` : "loose";
    const group = getOrCreateGroup(groupMap, groups, groupKey, groupName);
    const evidence = await processEvidenceFile(
      inputFile,
      isFolderFile ? folderPath : inputPath,
      group,
      isFolderFile ? "folder" : "loose",
      nextFileId(),
      hashAudio,
    );
    addFileToGroup(group, evidence);
    if (evidence.warning) {
      warnings.push(`${group.name} / ${evidence.name}: ${evidence.warning}`);
    }
  }

  for (const group of groups) {
    const byPath = (left: EvidenceFile, right: EvidenceFile): number =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
    group.files.sort(byPath);
    group.audios.sort(byPath);
    group.images.sort(byPath);

    if (group.images.length === 1) {
      const captureId = group.images[0].id;
      for (const audio of group.audios) {
        audio.associatedCaptureId = captureId;
        audio.associatedCaptureIds = [captureId];
      }
    }
  }

  return {
    groups,
    files: groups.flatMap((group) => group.files),
    ignored,
    rejected,
    warnings,
  };
}
