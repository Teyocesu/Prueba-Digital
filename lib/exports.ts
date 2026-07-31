import JSZip from "jszip";
import {
  PDFDocument,
  PDFFont,
  PDFPage,
  PageSizes,
  StandardFonts,
  grayscale,
  rgb,
} from "pdf-lib";

/** Nombre neutro sugerido para descargar el paquete destinado a Drive. */
export const EVIDENCE_ZIP_FILENAME = "EVIDENCIA_AUDIO_SHA256.zip";
export const MANIFEST_PDF_FILENAME = "MANIFIESTO_SHA256_AUDIOS.pdf";
export const INVENTORY_CSV_FILENAME = "INVENTARIO_AUDIOS_SHA256.csv";
export const MANIFEST_TXT_FILENAME = "MANIFIESTO_SHA256_AUDIOS.txt";
export const FILING_TEXT_FILENAME = "TEXTO_PARA_INCORPORAR_AL_ESCRITO.txt";

export type ExportBinary = Uint8Array | ArrayBuffer | Blob;
export type ExportMediaKind = "audio" | "video";

interface ExportMediaBase {
  /** Nombre original exacto, incluida su extensión. */
  name: string;
  /** Carpeta o ZIP superior del que provino el archivo. */
  group: string;
  /** Bytes originales. Nunca se convierten ni se recomprimen. */
  bytes: ExportBinary;
  /** Duración técnica ya formateada, por ejemplo "00:58.283". */
  duration: string;
  /** Tamaño registrado durante el análisis del archivo. */
  byteLength: number;
  /** Tipo determinado por contenido/magic bytes, no por la extensión. */
  detectedType: string;
  /** Extensión original, por ejemplo ".ogg". */
  originalExtension: string;
  /** SHA-256 esperado, hexadecimal de 64 caracteres. */
  sha256: string;
  /** Nombres originales exactos de las capturas asociadas. */
  captureNames?: readonly string[];
}

export interface ExportMedia extends ExportMediaBase {
  /** Clase probatoria del archivo. Nunca se infiere de `detectedType`. */
  kind: ExportMediaKind;
}

/**
 * Compatibilidad con el contrato original. La ausencia de `kind` representa
 * audio, de modo que las integraciones existentes mantienen su salida exacta.
 */
export type ExportAudio = ExportMediaBase & { kind?: "audio" };

export type ExportableMedia = ExportMedia | ExportAudio;

export type EvidenceComposition = "audio" | "video" | "mixed";

export interface EvidenceExportNaming {
  composition: EvidenceComposition;
  zipFilename: string;
  pdfFilename: string;
  csvFilename: string;
  txtFilename: string;
  primaryFolder: string;
  secondaryFolder: string;
  title: string;
}

export interface ExportCapture {
  name: string;
  group: string;
  bytes: ExportBinary;
}

export interface ManifestSettings {
  calculationDate: string;
  timeZone?: string;
  caseReference?: string;
  observations?: string;
  appVersion?: string;
  title?: string;
  introduction?: string;
  conclusion?: string;
  publicUrl?: string;
}

export interface IntegrityEntry {
  path: string;
  name: string;
  kind: ExportMediaKind;
  expectedSha256: string;
  actualSha256: string;
  byteLength: number;
  matches: boolean;
}

export interface ZipIntegrityReport {
  ok: boolean;
  mediaCount: number;
  audioCount: number;
  videoCount: number;
  entries: IntegrityEntry[];
}

export interface GenerateEvidenceZipOptions {
  /** Contrato principal para audio, video o una combinación de ambos. */
  media?: readonly ExportableMedia[];
  /** @deprecated Usar `media`. Se conserva para integraciones audio-only. */
  audios?: readonly ExportAudio[];
  captures?: readonly ExportCapture[];
  manifestPdf: ExportBinary;
  naming?: EvidenceExportNaming;
  inventoryCsv?: string | ExportBinary;
  manifestTxt?: string | ExportBinary;
  filingText?: string | ExportBinary;
}

export interface GenerateEvidenceZipResult {
  zipBytes: Uint8Array;
  integrityReport: ZipIntegrityReport;
  naming: EvidenceExportNaming;
}

export interface BuildEvidencePackageOptions {
  media?: readonly ExportableMedia[];
  /** @deprecated Usar `media`. */
  audios?: readonly ExportAudio[];
  captures?: readonly ExportCapture[];
  settings: ManifestSettings;
  includeCsv?: boolean;
  includeManifestTxt?: boolean;
  includeFilingText?: boolean;
}

export interface EvidencePackageResult extends GenerateEvidenceZipResult {
  manifestPdf: Uint8Array;
  inventoryCsv?: string;
  manifestTxt?: string;
  filingText?: string;
}

export class EvidenceIntegrityError extends Error {
  readonly report: ZipIntegrityReport;

  constructor(report: ZipIntegrityReport) {
    const failures = report.entries
      .filter((entry) => !entry.matches)
      .map((entry) => entry.path)
      .join(", ");
    super(
      failures
        ? `Falló la verificación de integridad del ZIP: ${failures}`
        : "Falló la verificación de integridad del ZIP",
    );
    this.name = "EvidenceIntegrityError";
    this.report = report;
  }
}

const AUDIO_ONLY_NAMING: EvidenceExportNaming = {
  composition: "audio",
  zipFilename: EVIDENCE_ZIP_FILENAME,
  pdfFilename: MANIFEST_PDF_FILENAME,
  csvFilename: INVENTORY_CSV_FILENAME,
  txtFilename: MANIFEST_TXT_FILENAME,
  primaryFolder: "01_Audios_con_capturas",
  secondaryFolder: "02_Capturas_sin_audio",
  title: "MANIFIESTO DE IDENTIFICACIÓN Y HASH SHA-256 DE ARCHIVOS DE AUDIO",
};

const VIDEO_ONLY_NAMING: EvidenceExportNaming = {
  composition: "video",
  zipFilename: "EVIDENCIA_VIDEO_SHA256.zip",
  pdfFilename: "MANIFIESTO_SHA256_VIDEOS.pdf",
  csvFilename: "INVENTARIO_VIDEOS_SHA256.csv",
  txtFilename: "MANIFIESTO_SHA256_VIDEOS.txt",
  primaryFolder: "01_Videos_con_capturas",
  secondaryFolder: "02_Capturas_sin_video",
  title: "MANIFIESTO DE IDENTIFICACIÓN Y HASH SHA-256 DE ARCHIVOS DE VIDEO",
};

const MIXED_MEDIA_NAMING: EvidenceExportNaming = {
  composition: "mixed",
  zipFilename: "EVIDENCIA_MULTIMEDIA_SHA256.zip",
  pdfFilename: "MANIFIESTO_SHA256_MULTIMEDIA.pdf",
  csvFilename: "INVENTARIO_MULTIMEDIA_SHA256.csv",
  txtFilename: "MANIFIESTO_SHA256_MULTIMEDIA.txt",
  primaryFolder: "01_Archivos_multimedia_con_capturas",
  secondaryFolder: "02_Capturas_sin_multimedia",
  title:
    "MANIFIESTO DE IDENTIFICACIÓN Y HASH SHA-256 DE ARCHIVOS DE AUDIO Y VIDEO",
};

type MediaKindCarrier = { kind?: ExportMediaKind };

function mediaKind(media: MediaKindCarrier): ExportMediaKind {
  return media.kind ?? "audio";
}

export function evidenceNamingForMedia(
  media: readonly MediaKindCarrier[],
): EvidenceExportNaming {
  const hasAudio = media.some((item) => mediaKind(item) === "audio");
  const hasVideo = media.some((item) => mediaKind(item) === "video");
  const naming = hasVideo
    ? hasAudio
      ? MIXED_MEDIA_NAMING
      : VIDEO_ONLY_NAMING
    : AUDIO_ONLY_NAMING;
  return { ...naming };
}

function mediaKindLabel(media: ExportableMedia): "Audio" | "Video" {
  return mediaKind(media) === "video" ? "Video" : "Audio";
}

function mediaNoun(
  composition: EvidenceComposition,
  options: { plural?: boolean } = {},
): string {
  const plural = options.plural ?? true;
  if (composition === "video") {
    return plural ? "archivos de video" : "archivo de video";
  }
  if (composition === "mixed") {
    return plural ? "archivos de audio y video" : "archivo multimedia";
  }
  return plural ? "archivos de audio" : "archivo de audio";
}

function defaultManifestTextIntroduction(
  naming: EvidenceExportNaming,
): string {
  return `Se deja expresa constancia de que los valores hash SHA-256 consignados a continuación fueron calculados por esta parte respecto de cada uno de los ${mediaNoun(
    naming.composition,
  )} individualizados, con anterioridad a su carga en el enlace público de solo lectura denunciado en autos.\n\nCada valor hash corresponde al contenido exacto del respectivo archivo y permite verificar posteriormente su integridad y detectar cualquier eventual modificación, sustitución, conversión o alteración.`;
}

const DEFAULT_CONCLUSION =
  "Se deja constancia de que los archivos alojados en el enlace público de solo lectura son los mismos respecto de los cuales se calcularon los valores SHA-256 precedentemente consignados.\n\nAsimismo, esta parte asume el compromiso de no modificar, sustituir ni eliminar dichos archivos durante la tramitación de las presentes actuaciones, y pone a disposición del Tribunal y del perito que eventualmente se designe el dispositivo móvil original para su correspondiente examen técnico.";

const A4_WIDTH = PageSizes.A4[0];
const A4_HEIGHT = PageSizes.A4[1];
const PAGE_MARGIN_X = 48;
const PAGE_TOP = A4_HEIGHT - 48;
const PAGE_CONTENT_BOTTOM = 54;
const PAGE_TEXT_WIDTH = A4_WIDTH - PAGE_MARGIN_X * 2;

function normalizeHash(hash: string): string {
  const normalized = hash.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(
      `SHA-256 inválido: se esperaban 64 caracteres hexadecimales y se recibió "${hash}"`,
    );
  }
  return normalized;
}

function assertSafePathSegment(value: string, label: string): void {
  if (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    /[/\\\0]/u.test(value)
  ) {
    throw new Error(
      `${label} no puede representarse como un único segmento seguro del ZIP: "${value}"`,
    );
  }
}

async function toOwnedBytes(
  value: ExportBinary,
): Promise<Uint8Array<ArrayBuffer>> {
  if (value instanceof Uint8Array) {
    return Uint8Array.from(value);
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value.slice(0));
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return new Uint8Array(await value.arrayBuffer());
  }
  throw new TypeError(
    "Los datos binarios deben ser Uint8Array, ArrayBuffer o Blob",
  );
}

export async function sha256Hex(value: ExportBinary): Promise<string> {
  const bytes = await toOwnedBytes(value);
  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto API no está disponible en este entorno");
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function replacementForUnsupportedCharacter(character: string): string {
  const replacements: Record<string, string> = {
    "\u00a0": " ",
    "\u2010": "-",
    "\u2011": "-",
    "\u2012": "-",
    "\u2013": "-",
    "\u2014": "-",
    "\u2018": "'",
    "\u2019": "'",
    "\u201a": "'",
    "\u201c": '"',
    "\u201d": '"',
    "\u201e": '"',
    "\u2022": "-",
    "\u2026": "...",
    "\u2212": "-",
  };
  return replacements[character] ?? "?";
}

/**
 * Las fuentes estándar de PDF usan WinAnsi. Esta función conserva los
 * caracteres españoles admitidos y sustituye de forma explícita cualquier
 * carácter no representable, evitando que pdf-lib aborte toda la exportación.
 */
function toWinAnsiSafe(text: string, font: PDFFont): string {
  let safe = "";
  for (const character of text) {
    if (character === "\n" || character === "\r") {
      safe += character;
      continue;
    }
    if (character === "\t") {
      safe += "    ";
      continue;
    }
    try {
      font.encodeText(character);
      safe += character;
    } catch {
      const replacement = replacementForUnsupportedCharacter(character);
      for (const replacementCharacter of replacement) {
        try {
          font.encodeText(replacementCharacter);
          safe += replacementCharacter;
        } catch {
          safe += "?";
        }
      }
    }
  }
  return safe;
}

function splitTokenToWidth(
  token: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
): string[] {
  const pieces: string[] = [];
  let current = "";
  for (const character of token) {
    const candidate = current + character;
    if (
      current.length > 0 &&
      font.widthOfTextAtSize(candidate, size) > maxWidth
    ) {
      pieces.push(current);
      current = character;
    } else {
      current = candidate;
    }
  }
  if (current || pieces.length === 0) {
    pieces.push(current);
  }
  return pieces;
}

function wrapSingleLine(
  line: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
): string[] {
  if (line.length === 0) {
    return [""];
  }

  const tokens = line.match(/\S+|\s+/gu) ?? [line];
  const lines: string[] = [];
  let current = "";

  const pushCurrent = () => {
    if (current.length > 0) {
      lines.push(current);
      current = "";
    }
  };

  for (const token of tokens) {
    const candidate = current + token;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
      continue;
    }

    pushCurrent();
    if (font.widthOfTextAtSize(token, size) <= maxWidth) {
      current = token;
      continue;
    }

    const pieces = splitTokenToWidth(token, font, size, maxWidth);
    for (let index = 0; index < pieces.length - 1; index += 1) {
      lines.push(pieces[index]);
    }
    current = pieces.at(-1) ?? "";
  }

  pushCurrent();
  return lines.length > 0 ? lines : [""];
}

function wrapText(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
): string[] {
  const safeText = toWinAnsiSafe(text, font).replace(/\r\n?/gu, "\n");
  return safeText
    .split("\n")
    .flatMap((line) => wrapSingleLine(line, font, size, maxWidth));
}

function captureDescription(media: ExportableMedia): string {
  const captures = media.captureNames ?? [];
  return captures.length > 0
    ? `${media.group} / ${captures.join(", ")}`
    : `${media.group} / Sin captura asociada`;
}

interface MediaSectionLine {
  text: string;
  font: PDFFont;
  size: number;
  lineHeight: number;
  color?: ReturnType<typeof rgb> | ReturnType<typeof grayscale>;
}

function makeMediaSectionLines(
  media: ExportableMedia,
  position: number,
  fonts: { regular: PDFFont; bold: PDFFont; mono: PDFFont },
  maxWidth: number,
): MediaSectionLine[] {
  const lines: MediaSectionLine[] = [
    {
      text: toWinAnsiSafe(`Archivo ${position}`, fonts.bold),
      font: fonts.bold,
      size: 11.5,
      lineHeight: 16,
      color: rgb(0.07, 0.22, 0.38),
    },
  ];

  const fields = [
    `Nombre exacto: ${media.name}`,
    `Tipo de archivo: ${mediaKindLabel(media)}`,
    `Grupo/captura asociada: ${captureDescription(media)}`,
    `Duración técnica: ${media.duration}`,
    `Tamaño: ${media.byteLength} bytes`,
    `Extensión original: ${media.originalExtension}`,
  ];

  for (const field of fields) {
    for (const wrappedLine of wrapText(field, fonts.regular, 9.2, maxWidth)) {
      lines.push({
        text: wrappedLine,
        font: fonts.regular,
        size: 9.2,
        lineHeight: 12.2,
      });
    }
  }

  lines.push({
    text: "SHA-256:",
    font: fonts.bold,
    size: 9.2,
    lineHeight: 12.2,
  });
  for (const hashLine of wrapText(
    normalizeHash(media.sha256),
    fonts.mono,
    8.3,
    maxWidth,
  )) {
    lines.push({
      text: hashLine,
      font: fonts.mono,
      size: 8.3,
      lineHeight: 11.2,
    });
  }
  return lines;
}

export async function generateManifestPdf(
  media: readonly ExportableMedia[],
  settings: ManifestSettings,
): Promise<Uint8Array> {
  // Desactiva los metadatos automáticos de pdf-lib para que el documento no
  // identifique la herramienta o aplicación con la que fue preparado.
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const mono = await pdf.embedFont(StandardFonts.Courier);
  const fonts = { regular, bold, mono };

  const naming = evidenceNamingForMedia(media);
  const title = settings.title?.trim() || naming.title;
  pdf.setTitle(toWinAnsiSafe(title, regular));
  pdf.setSubject(
    toWinAnsiSafe(
      `Individualización de ${mediaNoun(naming.composition)} y valores hash SHA-256`,
      regular,
    ),
  );

  let page = pdf.addPage(PageSizes.A4);
  let y = PAGE_TOP;

  const addPage = (): PDFPage => {
    page = pdf.addPage(PageSizes.A4);
    y = PAGE_TOP;
    return page;
  };

  const ensureSpace = (height: number): void => {
    if (y - height < PAGE_CONTENT_BOTTOM) {
      addPage();
    }
  };

  const drawFlowingText = (
    text: string,
    font: PDFFont,
    size: number,
    lineHeight: number,
    options?: {
      indent?: number;
      after?: number;
      color?: ReturnType<typeof rgb> | ReturnType<typeof grayscale>;
    },
  ): void => {
    const indent = options?.indent ?? 0;
    const lines = wrapText(text, font, size, PAGE_TEXT_WIDTH - indent);
    for (const line of lines) {
      if (y - lineHeight < PAGE_CONTENT_BOTTOM) {
        addPage();
      }
      if (line.length > 0) {
        page.drawText(line, {
          x: PAGE_MARGIN_X + indent,
          y,
          font,
          size,
          color: options?.color ?? grayscale(0.12),
        });
      }
      y -= lineHeight;
    }
    y -= options?.after ?? 0;
  };

  const titleLines = wrapText(title, bold, 15.5, PAGE_TEXT_WIDTH);
  for (const titleLine of titleLines) {
    const width = bold.widthOfTextAtSize(titleLine, 15.5);
    page.drawText(titleLine, {
      x: Math.max(PAGE_MARGIN_X, (A4_WIDTH - width) / 2),
      y,
      font: bold,
      size: 15.5,
      color: rgb(0.05, 0.18, 0.31),
    });
    y -= 20;
  }
  y -= 8;

  page.drawLine({
    start: { x: PAGE_MARGIN_X, y },
    end: { x: A4_WIDTH - PAGE_MARGIN_X, y },
    thickness: 1,
    color: rgb(0.35, 0.55, 0.7),
  });
  y -= 19;

  drawFlowingText("DATOS GENERALES", bold, 10.5, 14, {
    after: 4,
    color: rgb(0.07, 0.22, 0.38),
  });
  const generalFields = [
    `Fecha de cálculo: ${settings.calculationDate}`,
    `Zona horaria: ${settings.timeZone?.trim() || "No informada"}`,
    "Algoritmo: SHA-256",
    settings.caseReference?.trim()
      ? `Expediente o carátula: ${settings.caseReference}`
      : undefined,
    settings.observations?.trim()
      ? `Observaciones: ${settings.observations}`
      : undefined,
    settings.publicUrl?.trim()
      ? `Enlace público de solo lectura: ${settings.publicUrl.trim()}`
      : undefined,
  ].filter((field): field is string => Boolean(field));
  for (const field of generalFields) {
    drawFlowingText(field, regular, 9.5, 12.5);
  }
  y -= 10;

  if (media.length === 0) {
    drawFlowingText(
      `No se incluyeron ${mediaNoun(naming.composition)} en este manifiesto.`,
      regular,
      9.5,
      13.2,
      { after: 12 },
    );
  }

  for (let index = 0; index < media.length; index += 1) {
    const sectionLines = makeMediaSectionLines(
      media[index],
      index + 1,
      fonts,
      PAGE_TEXT_WIDTH - 22,
    );
    const sectionHeight =
      13 + sectionLines.reduce((sum, line) => sum + line.lineHeight, 0) + 8;
    ensureSpace(sectionHeight + 10);

    const top = y;
    page.drawRectangle({
      x: PAGE_MARGIN_X,
      y: top - sectionHeight,
      width: PAGE_TEXT_WIDTH,
      height: sectionHeight,
      color: rgb(0.965, 0.975, 0.985),
      borderColor: rgb(0.77, 0.83, 0.88),
      borderWidth: 0.7,
    });

    let sectionY = top - 13;
    for (const line of sectionLines) {
      page.drawText(line.text, {
        x: PAGE_MARGIN_X + 11,
        y: sectionY,
        font: line.font,
        size: line.size,
        color: line.color ?? grayscale(0.12),
      });
      sectionY -= line.lineHeight;
    }
    y = top - sectionHeight - 10;
  }

  const finalHeadingLineHeight = 14;
  const finalHeadingAfter = 4;
  const finalHeadingHeight = finalHeadingLineHeight + finalHeadingAfter;
  const finalBodyLineHeight = 13.2;
  const finalBodyLines = wrapText(
    settings.conclusion?.trim() || DEFAULT_CONCLUSION,
    regular,
    9.5,
    PAGE_TEXT_WIDTH,
  );
  const fullFinalSectionHeight =
    finalHeadingHeight + finalBodyLines.length * finalBodyLineHeight;
  const freshPageCapacity = PAGE_TOP - PAGE_CONTENT_BOTTOM;

  const drawFinalHeading = (continuation: boolean): void => {
    page.drawText(
      continuation ? "CONSTANCIA FINAL (continuación)" : "CONSTANCIA FINAL",
      {
        x: PAGE_MARGIN_X,
        y,
        font: bold,
        size: 10.5,
        color: rgb(0.07, 0.22, 0.38),
      },
    );
    y -= finalHeadingHeight;
  };

  const drawFinalBodyLines = (lines: readonly string[]): void => {
    for (const line of lines) {
      if (line.length > 0) {
        page.drawText(line, {
          x: PAGE_MARGIN_X,
          y,
          font: regular,
          size: 9.5,
          color: grayscale(0.12),
        });
      }
      y -= finalBodyLineHeight;
    }
  };

  if (fullFinalSectionHeight <= freshPageCapacity) {
    // El cierre cabe entero en una página: se mueve como una unidad para
    // impedir que el encabezado o sus últimas líneas queden huérfanos.
    ensureSpace(fullFinalSectionHeight);
    drawFinalHeading(false);
    drawFinalBodyLines(finalBodyLines);
  } else {
    // Un cierre excepcionalmente largo puede ocupar varias páginas. Cada
    // página siguiente repite un encabezado explícito de continuación.
    let firstBodyLine = 0;
    let continuation = false;
    const minimumBodyLinesWithHeading = Math.min(3, finalBodyLines.length);

    while (firstBodyLine < finalBodyLines.length) {
      const minimumBlockHeight =
        finalHeadingHeight + minimumBodyLinesWithHeading * finalBodyLineHeight;
      if (y - minimumBlockHeight < PAGE_CONTENT_BOTTOM) {
        addPage();
      }

      drawFinalHeading(continuation);

      const availableBodyLines = Math.max(
        1,
        Math.floor((y - PAGE_CONTENT_BOTTOM) / finalBodyLineHeight),
      );
      const remainingBodyLines = finalBodyLines.length - firstBodyLine;
      let linesOnThisPage = Math.min(availableBodyLines, remainingBodyLines);
      const linesOnNextPage = remainingBodyLines - linesOnThisPage;

      // Si el corte dejaría una sola línea en la página siguiente, se
      // traslada también la línea anterior para conservar un cierre legible.
      if (linesOnNextPage === 1 && linesOnThisPage > 1) {
        linesOnThisPage -= 1;
      }

      drawFinalBodyLines(
        finalBodyLines.slice(firstBodyLine, firstBodyLine + linesOnThisPage),
      );
      firstBodyLine += linesOnThisPage;

      if (firstBodyLine < finalBodyLines.length) {
        addPage();
        continuation = true;
      }
    }
  }

  const pages = pdf.getPages();
  for (let index = 0; index < pages.length; index += 1) {
    const currentPage = pages[index];
    currentPage.drawLine({
      start: { x: PAGE_MARGIN_X, y: 36 },
      end: { x: A4_WIDTH - PAGE_MARGIN_X, y: 36 },
      thickness: 0.5,
      color: grayscale(0.72),
    });
    const label = `Página ${index + 1} de ${pages.length}`;
    const labelWidth = regular.widthOfTextAtSize(label, 8.3);
    currentPage.drawText(label, {
      x: (A4_WIDTH - labelWidth) / 2,
      y: 22,
      font: regular,
      size: 8.3,
      color: grayscale(0.42),
    });
  }

  return pdf.save({ useObjectStreams: false });
}

function csvCell(value: string | number): string {
  const text = String(value);
  return `"${text.replace(/"/gu, '""')}"`;
}

export function generateInventoryCsv(
  media: readonly ExportableMedia[],
): string {
  const headers = [
    "Número",
    "Nombre exacto",
    "Tipo de archivo",
    "Grupo",
    "Captura(s) asociada(s)",
    "Duración técnica",
    "Tamaño en bytes",
    "Extensión original",
    "SHA-256",
  ];
  const rows = media.map((item, index) => [
    index + 1,
    item.name,
    mediaKindLabel(item),
    item.group,
    (item.captureNames ?? []).join(" | "),
    item.duration,
    item.byteLength,
    item.originalExtension,
    normalizeHash(item.sha256),
  ]);
  return `\uFEFF${[headers, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n")}\r\n`;
}

function manifestGeneralLines(settings: ManifestSettings): string[] {
  return [
    `Fecha de cálculo: ${settings.calculationDate}`,
    `Zona horaria: ${settings.timeZone?.trim() || "No informada"}`,
    "Algoritmo: SHA-256",
    settings.caseReference?.trim()
      ? `Expediente o carátula: ${settings.caseReference}`
      : undefined,
    settings.observations?.trim()
      ? `Observaciones: ${settings.observations}`
      : undefined,
    settings.publicUrl?.trim()
      ? `Enlace público de solo lectura: ${settings.publicUrl.trim()}`
      : undefined,
  ].filter((line): line is string => Boolean(line));
}

export function generateManifestTxt(
  media: readonly ExportableMedia[],
  settings: ManifestSettings,
): string {
  const naming = evidenceNamingForMedia(media);
  const title = settings.title?.trim() || naming.title;
  const sections = media.map((item, index) =>
    [
      `ARCHIVO ${index + 1}`,
      `Nombre exacto: ${item.name}`,
      `Tipo de archivo: ${mediaKindLabel(item)}`,
      `Grupo/captura asociada: ${captureDescription(item)}`,
      `Duración técnica: ${item.duration}`,
      `Tamaño: ${item.byteLength} bytes`,
      `Extensión original: ${item.originalExtension}`,
      `SHA-256: ${normalizeHash(item.sha256)}`,
    ].join("\n"),
  );

  return [
    title,
    "=".repeat(title.length),
    "",
    ...manifestGeneralLines(settings),
    "",
    settings.introduction?.trim() || defaultManifestTextIntroduction(naming),
    "",
    ...(sections.length > 0
      ? sections.flatMap((section) => [section, ""])
      : [
          `No se incluyeron ${mediaNoun(naming.composition)} en este manifiesto.`,
          "",
        ]),
    "CONSTANCIA FINAL",
    "",
    settings.conclusion?.trim() || DEFAULT_CONCLUSION,
    "",
  ].join("\n");
}

export function generateFilingText(
  media: readonly ExportableMedia[],
  publicUrl?: string,
): string {
  const link = publicUrl?.trim() || "[ENLACE PÚBLICO DE SOLO LECTURA]";
  const naming = evidenceNamingForMedia(media);
  const mediaSections = media.map((item, index) =>
    [
      `Archivo ${index + 1} (${mediaKindLabel(item)}): “${item.name}”`,
      `SHA-256: ${normalizeHash(item.sha256)}`,
    ].join("\n"),
  );
  const hasAssociatedCaptures = media.some(
    (item) => (item.captureNames?.length ?? 0) > 0,
  );
  const materialDescription = `El material está integrado por los ${mediaNoun(
    naming.composition,
  )} individualizados a continuación${
    hasAssociatedCaptures
      ? " y las capturas de pantalla asociadas cuando corresponde"
      : ""
  }.`;

  return [
    "Se acompaña el material digital mediante enlace de acceso público de solo lectura disponible en:",
    link,
    "",
    materialDescription,
    "",
    "Esta parte asume el compromiso de mantener disponibles y sin modificaciones, sustituciones ni eliminaciones los archivos alojados en el enlace denunciado durante la tramitación de las presentes actuaciones. Asimismo, pone a disposición del Tribunal y del perito que eventualmente se designe el dispositivo móvil original del cual proviene el material, para su examen técnico o análisis forense, en caso de considerarse necesario.",
    "",
    ...mediaSections.flatMap((section) => [section, ""]),
    `Asimismo, dentro del enlace denunciado se encuentra incorporado el archivo denominado “${naming.pdfFilename}”, en el que se individualizan los archivos, las capturas asociadas cuando corresponde, la duración, el tamaño y el correspondiente valor hash SHA-256.`,
    "",
  ].join("\n");
}

interface MaterializedMedia {
  media: ExportableMedia;
  kind: ExportMediaKind;
  bytes: Uint8Array<ArrayBuffer>;
  path: string;
  expectedSha256: string;
}

function mediaZipPath(
  media: Pick<ExportableMedia, "group" | "name">,
  naming: EvidenceExportNaming,
): string {
  return `${naming.primaryFolder}/${media.group}/${media.name}`;
}

function captureZipPath(
  capture: Pick<ExportCapture, "group" | "name">,
  mediaGroups: ReadonlySet<string>,
  naming: EvidenceExportNaming,
): string {
  const area = mediaGroups.has(capture.group)
    ? naming.primaryFolder
    : naming.secondaryFolder;
  return `${area}/${capture.group}/${capture.name}`;
}

function registerUniquePath(paths: Set<string>, path: string): void {
  if (paths.has(path)) {
    throw new Error(
      `No se puede preservar el nombre porque el ZIP tendría una ruta duplicada: "${path}"`,
    );
  }
  paths.add(path);
}

async function addOptionalFile(
  zip: JSZip,
  path: string,
  value: string | ExportBinary | undefined,
): Promise<void> {
  if (value === undefined) {
    return;
  }
  if (typeof value === "string") {
    zip.file(path, value, {
      binary: false,
      compression: "STORE",
      createFolders: true,
    });
    return;
  }
  zip.file(path, await toOwnedBytes(value), {
    binary: true,
    compression: "STORE",
    createFolders: true,
  });
}

export async function generateEvidenceZip(
  options: GenerateEvidenceZipOptions,
): Promise<GenerateEvidenceZipResult> {
  const zip = new JSZip();
  const media = options.media ?? options.audios ?? [];
  const naming = options.naming ?? evidenceNamingForMedia(media);
  const captures = options.captures ?? [];
  const mediaGroups = new Set(media.map((item) => item.group));
  const registeredPaths = new Set<string>();
  const materializedMedia: MaterializedMedia[] = [];

  zip.folder(naming.primaryFolder);
  zip.folder(naming.secondaryFolder);

  for (const item of media) {
    const kind = mediaKind(item);
    const kindLabel = kind === "video" ? "video" : "audio";
    assertSafePathSegment(item.group, `El grupo del ${kindLabel}`);
    assertSafePathSegment(item.name, `El nombre del ${kindLabel}`);
    const expectedSha256 = normalizeHash(item.sha256);
    const path = mediaZipPath(item, naming);
    registerUniquePath(registeredPaths, path);
    const bytes = await toOwnedBytes(item.bytes);
    if (bytes.byteLength !== item.byteLength) {
      throw new Error(
        `El tamaño registrado de "${item.name}" (${item.byteLength} bytes) no coincide con sus bytes originales (${bytes.byteLength} bytes)`,
      );
    }
    zip.file(path, bytes, {
      binary: true,
      compression: "STORE",
      createFolders: true,
    });
    materializedMedia.push({
      media: item,
      kind,
      bytes,
      path,
      expectedSha256,
    });
  }

  for (const capture of captures) {
    assertSafePathSegment(capture.group, "El grupo de la captura");
    assertSafePathSegment(capture.name, "El nombre de la captura");
    const path = captureZipPath(capture, mediaGroups, naming);
    registerUniquePath(registeredPaths, path);
    zip.file(path, await toOwnedBytes(capture.bytes), {
      binary: true,
      compression: "STORE",
      createFolders: true,
    });
  }

  const manifestPath = naming.pdfFilename;
  registerUniquePath(registeredPaths, manifestPath);
  await addOptionalFile(zip, manifestPath, options.manifestPdf);

  const zipBytes = await zip.generateAsync({
    type: "uint8array",
    compression: "STORE",
    platform: "UNIX",
    streamFiles: false,
  });

  // No se confía en la instancia que construyó el ZIP: se vuelve a abrir el
  // resultado serializado y se calcula cada hash sobre la copia allí incluida.
  const reopened = await JSZip.loadAsync(zipBytes);
  const entries: IntegrityEntry[] = [];
  for (const materialized of materializedMedia) {
    const entry = reopened.file(materialized.path);
    if (!entry) {
      entries.push({
        path: materialized.path,
        name: materialized.media.name,
        kind: materialized.kind,
        expectedSha256: materialized.expectedSha256,
        actualSha256: "",
        byteLength: 0,
        matches: false,
      });
      continue;
    }
    const copiedBytes = await entry.async("uint8array");
    const actualSha256 = await sha256Hex(copiedBytes);
    entries.push({
      path: materialized.path,
      name: materialized.media.name,
      kind: materialized.kind,
      expectedSha256: materialized.expectedSha256,
      actualSha256,
      byteLength: copiedBytes.byteLength,
      matches:
        actualSha256 === materialized.expectedSha256 &&
        copiedBytes.byteLength === materialized.bytes.byteLength,
    });
  }

  const integrityReport: ZipIntegrityReport = {
    ok: entries.every((entry) => entry.matches),
    mediaCount: entries.length,
    audioCount: entries.filter((entry) => entry.kind === "audio").length,
    videoCount: entries.filter((entry) => entry.kind === "video").length,
    entries,
  };
  if (!integrityReport.ok) {
    throw new EvidenceIntegrityError(integrityReport);
  }

  return { zipBytes, integrityReport, naming };
}

export async function buildEvidencePackage(
  options: BuildEvidencePackageOptions,
): Promise<EvidencePackageResult> {
  const media = options.media ?? options.audios ?? [];
  const naming = evidenceNamingForMedia(media);
  const manifestPdf = await generateManifestPdf(media, options.settings);
  const inventoryCsv = options.includeCsv
    ? generateInventoryCsv(media)
    : undefined;
  const manifestTxt = options.includeManifestTxt
    ? generateManifestTxt(media, options.settings)
    : undefined;
  const filingText = options.includeFilingText
    ? generateFilingText(media, options.settings.publicUrl)
    : undefined;
  const { zipBytes, integrityReport } = await generateEvidenceZip({
    media,
    captures: options.captures,
    manifestPdf,
    naming,
    inventoryCsv,
    manifestTxt,
    filingText,
  });

  return {
    zipBytes,
    manifestPdf,
    inventoryCsv,
    manifestTxt,
    filingText,
    integrityReport,
    naming,
  };
}
