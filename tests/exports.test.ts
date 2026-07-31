import JSZip from "jszip";
import {
  PDFArray,
  PDFDocument,
  PDFRawStream,
  PageSizes,
  decodePDFRawStream,
} from "pdf-lib";
import { describe, expect, it } from "vitest";

import {
  EVIDENCE_ZIP_FILENAME,
  EvidenceIntegrityError,
  FILING_TEXT_FILENAME,
  INVENTORY_CSV_FILENAME,
  MANIFEST_PDF_FILENAME,
  MANIFEST_TXT_FILENAME,
  ExportAudio,
  generateEvidenceZip,
  generateFilingText,
  generateInventoryCsv,
  generateManifestPdf,
  generateManifestTxt,
  sha256Hex,
} from "../lib/exports";

const encoder = new TextEncoder();

async function makeAudio(
  overrides: Partial<ExportAudio> = {},
): Promise<ExportAudio> {
  const bytes =
    overrides.bytes ??
    Uint8Array.from([0, 1, 2, 3, 127, 128, 254, 255, 10, 13]);
  const materialized =
    bytes instanceof Blob
      ? new Uint8Array(await bytes.arrayBuffer())
      : bytes instanceof ArrayBuffer
        ? new Uint8Array(bytes)
        : bytes;
  return {
    name: "audio original.ogg",
    group: "A",
    bytes,
    duration: "00:01.250",
    byteLength: materialized.byteLength,
    detectedType: "audio/wav (RIFF/WAVE PCM)",
    originalExtension: ".ogg",
    sha256: await sha256Hex(materialized),
    captureNames: ["captura original.jpg"],
    ...overrides,
  };
}

function centralDirectoryCompressionMethods(bytes: Uint8Array): number[] {
  const methods: number[] = [];
  for (let index = 0; index <= bytes.length - 12; index += 1) {
    if (
      bytes[index] === 0x50 &&
      bytes[index + 1] === 0x4b &&
      bytes[index + 2] === 0x01 &&
      bytes[index + 3] === 0x02
    ) {
      methods.push(bytes[index + 10] | (bytes[index + 11] << 8));
    }
  }
  return methods;
}

function decodedPdfContent(pdf: PDFDocument): string {
  const chunks: string[] = [];
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) {
      continue;
    }
    try {
      const decoded = decodePDFRawStream(object).decode();
      chunks.push(new TextDecoder("latin1").decode(decoded));
    } catch {
      // No todos los streams indirectos de un PDF tienen que ser texto.
    }
  }
  return chunks.join("\n");
}

function decodedPdfPageContent(pdf: PDFDocument, pageIndex: number): string {
  const contents = pdf.getPage(pageIndex).node.Contents();
  if (!contents) {
    return "";
  }

  const streams =
    contents instanceof PDFArray
      ? Array.from({ length: contents.size() }, (_, index) =>
          contents.lookup(index),
        )
      : [contents];

  return streams
    .filter((stream): stream is PDFRawStream => stream instanceof PDFRawStream)
    .map((stream) =>
      new TextDecoder("latin1").decode(decodePDFRawStream(stream).decode()),
    )
    .join("\n");
}

function pdfHexString(value: string): string {
  return Array.from(encoder.encode(value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  )
    .join("")
    .toUpperCase();
}

describe("motor de exportación ZIP", () => {
  it("preserva bytes, hashes, nombres Unicode y la estructura judicial", async () => {
    const audioBytes = Uint8Array.from([
      82, 73, 70, 70, 0, 255, 128, 42, 1, 2, 3, 4,
    ]);
    const audioName = "áudio declaración ñandú 🚀.ogg";
    const captureName = "captura árbol 📷.png";
    const orphanCaptureName = "Sólo conversación escrita – 01.jpg";
    const audio = await makeAudio({
      name: audioName,
      group: "Grupo Á",
      bytes: audioBytes,
      byteLength: audioBytes.byteLength,
      sha256: await sha256Hex(audioBytes),
      captureNames: [captureName],
    });
    const csv = generateInventoryCsv([audio]);
    const manifestTxt = generateManifestTxt([audio], {
      calculationDate: "30/07/2026 18:45",
      timeZone: "America/Argentina/Buenos_Aires",
    });
    const filingText = generateFilingText(
      [audio],
      "https://drive.example.test/folder?id=á",
    );

    const { zipBytes, integrityReport } = await generateEvidenceZip({
      audios: [audio],
      captures: [
        {
          name: captureName,
          group: "Grupo Á",
          bytes: Uint8Array.from([137, 80, 78, 71, 1, 2, 3]),
        },
        {
          name: orphanCaptureName,
          group: "Sólo texto",
          bytes: Uint8Array.from([255, 216, 255, 1, 2]),
        },
      ],
      manifestPdf: encoder.encode("%PDF-1.7 manifiesto de prueba"),
      inventoryCsv: csv,
      manifestTxt,
      filingText,
    });

    expect(integrityReport).toEqual({
      ok: true,
      audioCount: 1,
      entries: [
        expect.objectContaining({
          name: audioName,
          expectedSha256: audio.sha256,
          actualSha256: audio.sha256,
          byteLength: audioBytes.byteLength,
          matches: true,
        }),
      ],
    });

    const reopened = await JSZip.loadAsync(zipBytes);
    const audioPath = `01_Audios_con_capturas/Grupo Á/${audioName}`;
    const associatedCapturePath = `01_Audios_con_capturas/Grupo Á/${captureName}`;
    const orphanCapturePath = `02_Capturas_sin_audio/Sólo texto/${orphanCaptureName}`;

    expect(Object.keys(reopened.files).sort()).toEqual(
      [
        "01_Audios_con_capturas/",
        "01_Audios_con_capturas/Grupo Á/",
        audioPath,
        associatedCapturePath,
        "02_Capturas_sin_audio/",
        "02_Capturas_sin_audio/Sólo texto/",
        orphanCapturePath,
        MANIFEST_PDF_FILENAME,
      ].sort(),
    );
    const rootEntries = Object.keys(reopened.files).filter(
      (path) => path.replace(/\/$/u, "").split("/").length === 1,
    );
    expect(rootEntries.sort()).toEqual(
      [
        "01_Audios_con_capturas/",
        "02_Capturas_sin_audio/",
        MANIFEST_PDF_FILENAME,
      ].sort(),
    );
    expect(reopened.file(INVENTORY_CSV_FILENAME)).toBeNull();
    expect(reopened.file(MANIFEST_TXT_FILENAME)).toBeNull();
    expect(reopened.file(FILING_TEXT_FILENAME)).toBeNull();
    expect(EVIDENCE_ZIP_FILENAME).toBe("EVIDENCIA_AUDIO_SHA256.zip");
    expect(EVIDENCE_ZIP_FILENAME).not.toMatch(/prueba[-_ ]?digital/iu);
    expect(await reopened.file(audioPath)?.async("uint8array")).toEqual(
      audioBytes,
    );
    expect(
      await sha256Hex(
        (await reopened.file(audioPath)?.async("uint8array")) ??
          new Uint8Array(),
      ),
    ).toBe(audio.sha256);

    const methods = centralDirectoryCompressionMethods(zipBytes);
    expect(methods.length).toBeGreaterThan(0);
    expect(new Set(methods)).toEqual(new Set([0]));
  });

  it("falla con un reporte útil si el hash declarado no coincide", async () => {
    const audio = await makeAudio({
      sha256: "0".repeat(64),
    });

    await expect(
      generateEvidenceZip({
        audios: [audio],
        manifestPdf: encoder.encode("%PDF"),
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof EvidenceIntegrityError &&
        error.report.ok === false &&
        error.report.entries[0]?.matches === false &&
        error.report.entries[0]?.actualSha256.length === 64,
    );
  });
});

describe("salidas de texto", () => {
  it("genera CSV UTF-8 y TXT neutrales con los datos probatorios necesarios", async () => {
    const audio = await makeAudio({
      name: 'audio, "declaración" ñ.ogg',
      group: "G",
      duration: "00:58.283",
      detectedType: "RIFF/WAVE PCM, 16 bits",
      originalExtension: ".ogg",
      captureNames: ["1-PHOTO-ñ.jpg"],
    });

    const csv = generateInventoryCsv([audio]);
    expect(csv.codePointAt(0)).toBe(0xfeff);
    expect(csv).toContain('"audio, ""declaración"" ñ.ogg"');
    expect(csv).toContain(`"${audio.sha256}"`);
    expect(csv).not.toContain("Tipo real detectado");
    expect(csv).not.toContain("RIFF/WAVE");
    expect(csv).not.toMatch(/prueba[- ]digital/iu);
    expect(csv.endsWith("\r\n")).toBe(true);

    const txt = generateManifestTxt([audio], {
      calculationDate: "30/07/2026 18:45",
      timeZone: "America/Argentina/Buenos_Aires",
      caseReference: "Pérez c/ Gómez",
      observations: "Información íntegra",
      appVersion: "1.0.0",
      introduction: "Introducción editable.",
      conclusion: "Cierre editable.",
    });
    expect(txt).toContain(`Nombre exacto: ${audio.name}`);
    expect(txt).toContain("Grupo/captura asociada: G / 1-PHOTO-ñ.jpg");
    expect(txt).toContain("Duración técnica: 00:58.283");
    expect(txt).toContain(`Tamaño: ${audio.byteLength} bytes`);
    expect(txt).toContain("Extensión original: .ogg");
    expect(txt).toContain(`SHA-256: ${audio.sha256}`);
    expect(txt).toContain("Introducción editable.");
    expect(txt).toContain("Cierre editable.");
    expect(txt).not.toContain("Tipo real detectado");
    expect(txt).not.toContain("RIFF/WAVE");
    expect(txt).not.toContain("Versión de la aplicación");
    expect(txt).not.toContain("1.0.0");
    expect(txt).not.toMatch(/prueba[- ]digital/iu);
  });

  it("coloca la URL del escrito sola en su propia línea", async () => {
    const audio = await makeAudio();
    const url = "https://drive.example.test/carpeta?usp=sharing";
    const text = generateFilingText([audio], url);
    const lines = text.split("\n");
    const linkIndex = lines.indexOf(url);

    expect(linkIndex).toBeGreaterThan(0);
    expect(lines[linkIndex - 1]).toMatch(/:$/u);
    expect(lines[linkIndex + 1]).toBe("");
    expect(text).not.toContain(`${url}.`);
    expect(text).not.toContain(`${url},`);
    expect(text).toContain(audio.name);
    expect(text).toContain(audio.sha256);
    expect(text).not.toContain("Tipo real detectado");
    expect(text).not.toContain("Versión de la aplicación");
    expect(text).not.toMatch(/prueba[- ]digital/iu);
  });
});

describe("manifiesto PDF", () => {
  it("omite marcas, metadatos de autoría, introducción y tipo detectado", async () => {
    const audio = await makeAudio({
      detectedType: "RIFF/WAVE PCM, 16 bits",
    });
    const introduction =
      "INTRODUCCION_QUE_NO_DEBE_APARECER bajo datos generales.";
    const pdfBytes = await generateManifestPdf([audio], {
      calculationDate: "30/07/2026 18:45",
      timeZone: "America/Argentina/Buenos_Aires",
      appVersion: "1.0.0",
      introduction,
      conclusion: "Constancia final neutral.",
    });
    const pdf = await PDFDocument.load(pdfBytes, {
      updateMetadata: false,
    });
    const decodedContent = decodedPdfContent(pdf);
    const serialized = new TextDecoder("latin1").decode(pdfBytes);

    expect(decodedContent).toContain(pdfHexString("DATOS GENERALES"));
    expect(decodedContent).toContain(pdfHexString(audio.sha256));
    expect(decodedContent).not.toContain(pdfHexString(introduction));
    expect(decodedContent).not.toContain(pdfHexString("Tipo real detectado"));
    expect(decodedContent).not.toContain(pdfHexString("RIFF/WAVE"));
    expect(decodedContent).not.toContain(
      pdfHexString("Versión de la aplicación"),
    );
    expect(decodedContent).not.toContain(pdfHexString("Prueba Digital"));
    expect(decodedContent).not.toContain(pdfHexString("Prueba-Digital"));
    expect(pdf.getCreator()).toBeUndefined();
    expect(pdf.getProducer()).toBeUndefined();
    expect(serialized).not.toMatch(/prueba[- ]digital/iu);
    expect(serialized).not.toContain("/Creator");
    expect(serialized).not.toContain("/Producer");
  });

  it("mueve la constancia final completa si no cabe en la página actual", async () => {
    const audios: ExportAudio[] = [];
    for (let index = 0; index < 5; index += 1) {
      const bytes = encoder.encode(`audio cierre ${index}`);
      audios.push(
        await makeAudio({
          name: `audio-${index + 1}.ogg`,
          bytes,
          byteLength: bytes.byteLength,
          sha256: await sha256Hex(bytes),
        }),
      );
    }
    const conclusion = [
      "INICIO_CIERRE_JUDICIAL",
      "Primera linea de la constancia.",
      "Segunda linea de la constancia.",
      "Tercera linea de la constancia.",
      "Cuarta linea de la constancia.",
      "FIN_CIERRE_JUDICIAL",
    ].join("\n");

    const pdfBytes = await generateManifestPdf(audios, {
      calculationDate: "30/07/2026 18:45",
      conclusion,
    });
    const pdf = await PDFDocument.load(pdfBytes);
    const pageContents = pdf
      .getPages()
      .map((_, index) => decodedPdfPageContent(pdf, index));
    const heading = pdfHexString("CONSTANCIA FINAL");
    const start = pdfHexString("INICIO_CIERRE_JUDICIAL");
    const end = pdfHexString("FIN_CIERRE_JUDICIAL");
    const finalSectionPage = pageContents.findIndex((content) =>
      content.includes(heading),
    );

    expect(finalSectionPage).toBeGreaterThan(0);
    expect(pageContents[finalSectionPage]).toContain(start);
    expect(pageContents[finalSectionPage]).toContain(end);
    expect(pageContents[finalSectionPage - 1]).not.toContain(heading);
  });

  it("repite un encabezado de continuación si la constancia ocupa varias páginas", async () => {
    const conclusion = Array.from(
      { length: 70 },
      (_, index) => `LINEA_CIERRE_${String(index + 1).padStart(3, "0")}`,
    ).join("\n");

    const pdfBytes = await generateManifestPdf([], {
      calculationDate: "30/07/2026 18:45",
      conclusion,
    });
    const pdf = await PDFDocument.load(pdfBytes);
    const pageContents = pdf
      .getPages()
      .map((_, index) => decodedPdfPageContent(pdf, index));
    const finalLinePage = pageContents.findIndex((content) =>
      content.includes(pdfHexString("LINEA_CIERRE_070")),
    );

    expect(finalLinePage).toBeGreaterThan(0);
    expect(pageContents[finalLinePage]).toContain(
      pdfHexString("CONSTANCIA FINAL (continuaci"),
    );
    expect(pageContents[finalLinePage]).toContain(
      pdfHexString("LINEA_CIERRE_069"),
    );
  });

  it("genera A4 multipágina, pagina todas las hojas y conserva hashes completos", async () => {
    const audios: ExportAudio[] = [];
    for (let index = 0; index < 18; index += 1) {
      const bytes = encoder.encode(`audio judicial número ${index}`);
      audios.push(
        await makeAudio({
          name:
            `Audio ${String(index + 1).padStart(2, "0")} – ` +
            "declaración del señor Ñúñez con espacios 🚀.ogg",
          group: `Grupo ${index % 3 === 0 ? "Á" : "B"}`,
          bytes,
          byteLength: bytes.byteLength,
          sha256: await sha256Hex(bytes),
          captureNames: [`captura número ${index + 1} 📷.jpg`],
        }),
      );
    }

    const pdfBytes = await generateManifestPdf(audios, {
      calculationDate: "30/07/2026 18:45",
      timeZone: "America/Argentina/Buenos_Aires",
      caseReference: "Pérez c/ Gómez – Información jurídica ⚖️",
      observations: "Los caracteres españoles: á, é, í, ó, ú, ü, ñ, ¿, ¡.",
      appVersion: "1.0.0",
      introduction:
        "Introducción editable con información en español. " +
        "Un emoji fuera de WinAnsi se degrada de forma segura: 🧾.",
      conclusion: "Texto final editable para el Tribunal.",
    });

    expect(Array.from(pdfBytes.slice(0, 5))).toEqual([
      0x25, 0x50, 0x44, 0x46, 0x2d,
    ]);
    const pdf = await PDFDocument.load(pdfBytes);
    expect(pdf.getPageCount()).toBeGreaterThan(1);
    for (const page of pdf.getPages()) {
      const { width, height } = page.getSize();
      expect(width).toBeCloseTo(PageSizes.A4[0], 3);
      expect(height).toBeCloseTo(PageSizes.A4[1], 3);
    }

    const decodedContent = decodedPdfContent(pdf);
    for (const audio of audios) {
      expect(decodedContent).toContain(pdfHexString(audio.sha256));
    }
    for (
      let pageNumber = 1;
      pageNumber <= pdf.getPageCount();
      pageNumber += 1
    ) {
      expect(decodedContent).toContain(
        `50E167696E6120${pdfHexString(
          `${pageNumber} de ${pdf.getPageCount()}`,
        )}`,
      );
    }
  });
});
