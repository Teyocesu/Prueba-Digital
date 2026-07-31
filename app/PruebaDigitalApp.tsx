"use client";

import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  BadgeCheck,
  Check,
  CheckCircle2,
  Clipboard,
  CloudUpload,
  Copy,
  Download,
  ExternalLink,
  FileArchive,
  FileAudio,
  FileCheck2,
  FileImage,
  FileQuestion,
  FileText,
  Fingerprint,
  FolderOpen,
  Hash,
  Info,
  Link2,
  LoaderCircle,
  LockKeyhole,
  RotateCcw,
  ShieldCheck,
  Trash2,
  Upload,
  X,
  XCircle,
} from "lucide-react";
import {
  type ChangeEvent,
  type DragEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type EvidenceFile,
  isValidSha256,
  loadEvidenceFiles,
  sha256,
} from "../lib/evidence";
import {
  type ExportAudio,
  type ExportCapture,
  type ManifestSettings,
  generateEvidenceZip,
  generateFilingText,
  generateInventoryCsv,
  generateManifestPdf,
  generateManifestTxt,
} from "../lib/exports";

const APP_VERSION = "1.0.0";
const PACKAGE_NAME = "PRUEBA_DIGITAL_AUDIOS_WHATSAPP_SHA256";

const DEFAULT_INTRODUCTION =
  "Se deja expresa constancia de que los valores hash SHA-256 consignados a continuación fueron calculados por esta parte respecto de cada uno de los archivos de audio individualizados, con anterioridad a su carga en el enlace público de solo lectura denunciado en autos.\n\nCada valor hash corresponde al contenido exacto del respectivo archivo y permite verificar posteriormente su integridad y detectar cualquier eventual modificación, sustitución, conversión o alteración.";

const DEFAULT_CONCLUSION =
  "Se deja constancia de que los archivos alojados en el enlace público de solo lectura son los mismos respecto de los cuales se calcularon los valores SHA-256 precedentemente consignados.\n\nAsimismo, esta parte asume el compromiso de no modificar, sustituir ni eliminar dichos archivos durante la tramitación de las presentes actuaciones, y pone a disposición del Tribunal y del perito que eventualmente se designe el dispositivo móvil original para su correspondiente examen técnico.";

type AppMode = "home" | "prepare" | "verify";

type ManifestForm = {
  calculationDate: string;
  timeZone: string;
  caseReference: string;
  observations: string;
  introduction: string;
  conclusion: string;
  publicUrl: string;
  includeCapturesWithoutAudio: boolean;
  includeCsv: boolean;
  includeTxt: boolean;
};

type GeneratedPackage = {
  zipUrl: string;
  pdfUrl: string;
  csvUrl?: string;
  manifestTxtUrl?: string;
  integrityCount: number;
  integrityTotal: number;
  zipSize: number;
  pdfSize: number;
};

const STEPS = [
  { number: 1, label: "Cargar" },
  { number: 2, label: "Revisar" },
  { number: 3, label: "Asociar" },
  { number: 4, label: "Manifiesto" },
  { number: 5, label: "Descargar" },
];

function localDateTimeValue() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function initialManifest(): ManifestForm {
  return {
    calculationDate: localDateTimeValue(),
    timeZone:
      Intl.DateTimeFormat().resolvedOptions().timeZone ||
      "America/Argentina/Buenos_Aires",
    caseReference: "",
    observations: "",
    introduction: DEFAULT_INTRODUCTION,
    conclusion: DEFAULT_CONCLUSION,
    publicUrl: "",
    includeCapturesWithoutAudio: true,
    includeCsv: true,
    includeTxt: true,
  };
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes.toLocaleString("es-AR")} bytes`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value.toLocaleString("es-AR", {
    minimumFractionDigits: value < 10 ? 1 : 0,
    maximumFractionDigits: 1,
  })} ${unit}`;
}

function detectedLabel(file: EvidenceFile) {
  const labels: Record<string, string> = {
    wav: "RIFF/WAVE",
    ogg: "OGG",
    opus: "Opus",
    mp3: "MP3",
    m4a: "M4A",
    aac: "AAC",
    jpeg: "JPEG",
    png: "PNG",
    webp: "WebP",
    heic: "HEIC/HEIF",
    unknown: "No identificado",
  };
  return labels[file.detectedFormat] ?? "No identificado";
}

function detectedMime(file: EvidenceFile) {
  const mimeTypes: Record<string, string> = {
    wav: "audio/wav",
    ogg: "audio/ogg",
    opus: "audio/ogg; codecs=opus",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    aac: "audio/aac",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    heic: "image/heic",
  };
  const fallback =
    file.kind === "audio"
      ? "audio/wav"
      : file.kind === "image"
        ? "image/jpeg"
        : "application/octet-stream";
  return mimeTypes[file.detectedFormat] ?? fallback;
}

function quantityLabel(
  count: number,
  singular: string,
  plural = `${singular}s`,
) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function isValidHttpsUrl(value: string) {
  try {
    return new URL(value.trim()).protocol === "https:";
  } catch {
    return false;
  }
}

function friendlyFormatWarning(file: EvidenceFile) {
  const extension = file.extension || "sin extensión";
  return `Archivo válido: aunque el nombre termina en ${extension}, por dentro es ${detectedLabel(file)}. Se incluirá sin cambios.`;
}

function displayListItem(value: unknown) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return String(record.path ?? record.name ?? record.reason ?? "Archivo");
  }
  return String(value);
}

function blobFromBytes(
  value: Uint8Array | ArrayBuffer,
  type: string,
): Blob {
  const buffer =
    value instanceof Uint8Array
      ? new Uint8Array(value).buffer
      : value.slice(0);
  return new Blob([buffer], { type });
}

async function hashFileInWorker(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();

  if (typeof Worker === "undefined") {
    return sha256(buffer);
  }

  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const worker = new Worker(new URL("./hash.worker.ts", import.meta.url), {
      type: "module",
    });

    const finish = () => worker.terminate();
    worker.onerror = () => {
      finish();
      reject(new Error("No se pudo iniciar el cálculo local del hash."));
    };
    worker.onmessage = (
      event: MessageEvent<{ id: string; hash?: string; error?: string }>,
    ) => {
      if (event.data.id !== id) return;
      finish();
      if (event.data.error) {
        reject(new Error(event.data.error));
      } else if (event.data.hash) {
        resolve(event.data.hash);
      } else {
        reject(new Error("El cálculo local no devolvió un hash válido."));
      }
    };

    worker.postMessage({ id, buffer }, [buffer]);
  });
}

function downloadTextFile(text: string, filename: string) {
  const url = URL.createObjectURL(
    new Blob([text], { type: "text/plain;charset=utf-8" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function Logo() {
  return (
    <span className="brand" aria-label="Prueba Digital">
      <span className="brand-mark" aria-hidden="true">
        <Fingerprint size={20} strokeWidth={2.1} />
      </span>
      <span>
        <strong>Prueba</strong> Digital
      </span>
    </span>
  );
}

function PrivacyBadge() {
  return (
    <span className="privacy-badge">
      <LockKeyhole size={14} aria-hidden="true" />
      Procesamiento local
    </span>
  );
}

function AppHeader({
  mode,
  hasSession,
  onHome,
  onVerify,
  onClear,
}: {
  mode: AppMode;
  hasSession: boolean;
  onHome: () => void;
  onVerify: () => void;
  onClear: () => void;
}) {
  return (
    <header className="topbar">
      <button className="brand-button" type="button" onClick={onHome}>
        <Logo />
      </button>
      <div className="topbar-actions">
        <PrivacyBadge />
        {mode !== "verify" && (
          <button
            className="text-button"
            type="button"
            title="Verificar un hash"
            onClick={onVerify}
          >
            <Hash size={16} aria-hidden="true" />
            <span>Verificar un hash</span>
          </button>
        )}
        {hasSession && (
          <button
            className="text-button danger-text"
            type="button"
            title="Borrar sesión"
            onClick={onClear}
          >
            <Trash2 size={16} aria-hidden="true" />
            <span>Borrar sesión</span>
          </button>
        )}
      </div>
    </header>
  );
}

function Stepper({ current }: { current: number }) {
  return (
    <nav className="stepper" aria-label="Progreso de la preparación">
      {STEPS.map((item, index) => {
        const complete = item.number < current;
        const active = item.number === current;
        return (
          <div
            className={`stepper-item${active ? " is-active" : ""}${
              complete ? " is-complete" : ""
            }`}
            key={item.number}
            aria-current={active ? "step" : undefined}
          >
            <span className="step-dot">
              {complete ? <Check size={14} /> : item.number}
            </span>
            <span className="step-label">{item.label}</span>
            {index < STEPS.length - 1 && (
              <span className="step-line" aria-hidden="true" />
            )}
          </div>
        );
      })}
    </nav>
  );
}

function SectionHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="section-heading">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}

function FooterNote() {
  return (
    <aside className="legal-note">
      <Info size={18} aria-hidden="true" />
      <p>
        <strong>Alcance del hash.</strong> Permite verificar la integridad de un
        archivo desde que se calculó su huella digital. Por sí solo no acredita
        autoría, identidad de la voz, fecha, origen del mensaje ni autenticidad
        integral de la conversación. La valoración y eventual pericia
        corresponden al Tribunal.
      </p>
    </aside>
  );
}

function EmptyIcon({ kind }: { kind: EvidenceFile["kind"] }) {
  if (kind === "audio") return <FileAudio size={19} />;
  if (kind === "image") return <FileImage size={19} />;
  return <FileQuestion size={19} />;
}

export function PruebaDigitalApp() {
  const [mode, setMode] = useState<AppMode>("home");
  const [step, setStep] = useState(1);
  const [files, setFiles] = useState<EvidenceFile[]>([]);
  const [ignored, setIgnored] = useState<string[]>([]);
  const [rejected, setRejected] = useState<string[]>([]);
  const [loadWarnings, setLoadWarnings] = useState<string[]>([]);
  const [associations, setAssociations] = useState<Record<string, string[]>>({});
  const [audioOrder, setAudioOrder] = useState<string[]>([]);
  const [excludedIds, setExcludedIds] = useState<Set<string>>(new Set());
  const [manifest, setManifest] = useState<ManifestForm>(initialManifest);
  const [generated, setGenerated] = useState<GeneratedPackage | null>(null);
  const [filingText, setFilingText] = useState("");
  const [lastExportAudios, setLastExportAudios] = useState<ExportAudio[]>([]);
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const [isDragging, setIsDragging] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingLabel, setLoadingLabel] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [verifierFile, setVerifierFile] = useState<File | null>(null);
  const [verifierHash, setVerifierHash] = useState("");
  const [expectedHash, setExpectedHash] = useState("");
  const [verifierLoading, setVerifierLoading] = useState(false);
  const [verifierError, setVerifierError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const verifierInputRef = useRef<HTMLInputElement>(null);
  const previewUrlsRef = useRef(new Map<string, string>());
  const generatedUrlsRef = useRef<string[]>([]);
  const batchRef = useRef(0);

  useEffect(() => {
    folderInputRef.current?.setAttribute("webkitdirectory", "");
    folderInputRef.current?.setAttribute("directory", "");
  }, []);

  useEffect(
    () => () => {
      previewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      generatedUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    },
    [],
  );

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
    const heading = document.querySelector<HTMLElement>("main h1");
    if (!heading) return;
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }, [mode, step]);

  const audios = useMemo(
    () => files.filter((file) => file.kind === "audio"),
    [files],
  );
  const images = useMemo(
    () => files.filter((file) => file.kind === "image"),
    [files],
  );
  const unknownFiles = useMemo(
    () => files.filter((file) => file.kind === "unknown"),
    [files],
  );

  const groups = useMemo(() => {
    const ids = Array.from(new Set(files.map((file) => file.groupId)));
    return ids
      .map((id) => {
        const groupFiles = files.filter((file) => file.groupId === id);
        return {
          id,
          name: groupFiles[0]?.group ?? "Sin grupo",
          files: groupFiles,
        };
      })
      .sort((a, b) =>
        a.name.localeCompare(b.name, "es", { numeric: true }),
      );
  }, [files]);

  const orderedAudios = useMemo(() => {
    const byId = new Map(audios.map((audio) => [audio.id, audio]));
    const ordered = audioOrder
      .map((id) => byId.get(id))
      .filter((audio): audio is EvidenceFile => Boolean(audio));
    const included = new Set(ordered.map((audio) => audio.id));
    return [
      ...ordered,
      ...audios
        .filter((audio) => !included.has(audio.id))
        .sort((a, b) =>
          `${a.group}/${a.name}`.localeCompare(`${b.group}/${b.name}`, "es", {
            numeric: true,
          }),
        ),
    ];
  }, [audios, audioOrder]);

  const includedAudios = useMemo(
    () => orderedAudios.filter((audio) => !excludedIds.has(audio.id)),
    [orderedAudios, excludedIds],
  );

  const duplicatePaths = useMemo(() => {
    const counts = new Map<string, number>();
    for (const file of files) {
      if (file.kind === "unknown" || excludedIds.has(file.id)) continue;
      const key = `${file.group}/${file.name}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .filter(([, count]) => count > 1)
      .map(([path]) => path);
  }, [files, excludedIds]);

  const audiosWithoutCapture = useMemo(
    () =>
      includedAudios.filter(
        (audio) => (associations[audio.id] ?? []).length === 0,
      ),
    [associations, includedAudios],
  );

  const publicUrlValue = manifest.publicUrl.trim();
  const hasValidPublicUrl = isValidHttpsUrl(publicUrlValue);
  const publicUrlIsInvalid =
    publicUrlValue.length > 0 && !hasValidPublicUrl;
  const filingTextIsReady =
    hasValidPublicUrl &&
    filingText.length > 0 &&
    !filingText.includes("[ENLACE PÚBLICO DE SOLO LECTURA]");

  function registerPreviewUrl(file: EvidenceFile) {
    const url = URL.createObjectURL(
      new Blob([file.file], { type: detectedMime(file) }),
    );
    previewUrlsRef.current.set(file.id, url);
    return url;
  }

  function revokeGeneratedUrls() {
    generatedUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    generatedUrlsRef.current = [];
  }

  async function copyText(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1800);
    } catch {
      setCopiedKey(null);
    }
  }

  async function ingestFiles(input: File[]) {
    if (!input.length) return;

    setIsLoading(true);
    setLoadError(null);
    setLoadingLabel("Leyendo archivos en este dispositivo…");
    const batchNumber = ++batchRef.current;
    const prefix = `b${batchNumber}-`;

    try {
      const result = await loadEvidenceFiles(input, { hashAudio: false });
      const idMap = new Map(
        result.files.map((file) => [file.id, `${prefix}${file.id}`]),
      );
      const prepared = result.files.map((file) => ({
        ...file,
        id: idMap.get(file.id) as string,
        groupId: `${prefix}${file.groupId}`,
        associatedCaptureId: file.associatedCaptureId
          ? idMap.get(file.associatedCaptureId)
          : undefined,
        associatedCaptureIds: file.associatedCaptureIds
          .map((captureId) => idMap.get(captureId))
          .filter((captureId): captureId is string => Boolean(captureId)),
      }));

      const nextAssociations: Record<string, string[]> = {};
      const preparedAudios = prepared.filter(
        (file) => file.kind === "audio",
      );
      for (let index = 0; index < preparedAudios.length; index += 1) {
        const file = preparedAudios[index];
        setLoadingLabel(
          `Calculando la huella del audio ${index + 1} de ${preparedAudios.length}… No cierres esta ventana.`,
        );
        const hash =
          file.sha256 && isValidSha256(file.sha256)
            ? file.sha256
            : await hashFileInWorker(file.file);
        file.sha256 = hash;
        if (file.associatedCaptureId) {
          nextAssociations[file.id] = [file.associatedCaptureId];
        }
      }

      const nextPreviewUrls: Record<string, string> = {};
      prepared
        .filter((file) => file.kind === "audio" || file.kind === "image")
        .forEach((file) => {
          nextPreviewUrls[file.id] = registerPreviewUrl(file);
        });

      setFiles((current) => [...current, ...prepared]);
      setPreviewUrls((current) => ({ ...current, ...nextPreviewUrls }));
      setIgnored((current) => [
        ...current,
        ...result.ignored.map(displayListItem),
      ]);
      setRejected((current) => [
        ...current,
        ...result.rejected.map(displayListItem),
      ]);
      setLoadWarnings((current) => [
        ...current,
        ...result.warnings.map(displayListItem),
      ]);
      setAssociations((current) => ({ ...current, ...nextAssociations }));
      setAudioOrder((current) => [
        ...current,
        ...prepared
          .filter((file) => file.kind === "audio")
          .sort((a, b) =>
            `${a.group}/${a.name}`.localeCompare(
              `${b.group}/${b.name}`,
              "es",
              { numeric: true },
            ),
          )
          .map((file) => file.id),
      ]);
    } catch (error) {
      setLoadError(
        error instanceof Error
          ? error.message
          : "No se pudo leer el material seleccionado.",
      );
    } finally {
      setIsLoading(false);
      setLoadingLabel("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      if (folderInputRef.current) folderInputRef.current.value = "";
    }
  }

  function handleFileInput(event: ChangeEvent<HTMLInputElement>) {
    void ingestFiles(Array.from(event.target.files ?? []));
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    void ingestFiles(Array.from(event.dataTransfer.files));
  }

  function toggleAssociation(audioId: string, captureId: string) {
    setAssociations((current) => {
      const selected = current[audioId] ?? [];
      return {
        ...current,
        [audioId]: selected.includes(captureId)
          ? selected.filter((id) => id !== captureId)
          : [...selected, captureId],
      };
    });
  }

  function moveAudio(id: string, direction: -1 | 1) {
    setAudioOrder((current) => {
      const index = current.indexOf(id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function toggleExcluded(file: EvidenceFile) {
    const isExcluded = excludedIds.has(file.id);
    if (
      !isExcluded &&
      !window.confirm(
        `¿Excluir “${file.name}” de la presentación? El archivo seguirá cargado y podrás volver a incluirlo.`,
      )
    ) {
      return;
    }
    setExcludedIds((current) => {
      const next = new Set(current);
      if (isExcluded) next.delete(file.id);
      else next.add(file.id);
      return next;
    });
  }

  function updateManifest<K extends keyof ManifestForm>(
    key: K,
    value: ManifestForm[K],
  ) {
    setManifest((current) => ({ ...current, [key]: value }));
  }

  function manifestSettings(): ManifestSettings {
    return {
      calculationDate: manifest.calculationDate,
      timeZone: manifest.timeZone,
      caseReference: manifest.caseReference || undefined,
      observations: manifest.observations || undefined,
      appVersion: APP_VERSION,
      title:
        "MANIFIESTO DE IDENTIFICACIÓN Y HASH SHA-256 DE ARCHIVOS DE AUDIO",
      introduction: manifest.introduction,
      conclusion: manifest.conclusion,
      publicUrl: manifest.publicUrl || undefined,
    };
  }

  function buildExportAudios(): ExportAudio[] {
    return includedAudios.map((audio) => {
      const captureNames = (associations[audio.id] ?? [])
        .map((captureId) => files.find((file) => file.id === captureId)?.name)
        .filter((name): name is string => Boolean(name));

      return {
        name: audio.name,
        group: audio.group,
        bytes: audio.file,
        duration: audio.duration ?? "No disponible",
        byteLength: audio.size,
        detectedType: detectedLabel(audio),
        originalExtension: audio.extension,
        sha256: audio.sha256 ?? "",
        captureNames,
      };
    });
  }

  function buildExportCaptures(): ExportCapture[] {
    const groupsWithIncludedAudio = new Set(
      includedAudios.map((audio) => audio.groupId),
    );
    const associatedIds = new Set(
      includedAudios.flatMap((audio) => associations[audio.id] ?? []),
    );

    return images
      .filter((image) => {
        if (associatedIds.has(image.id)) return true;
        return (
          manifest.includeCapturesWithoutAudio &&
          !groupsWithIncludedAudio.has(image.groupId)
        );
      })
      .map((image) => ({
        name: image.name,
        group: image.group,
        bytes: image.file,
      }));
  }

  async function generatePackage() {
    if (!includedAudios.length) {
      setGenerateError("Incluí al menos un audio antes de generar el paquete.");
      return;
    }
    if (duplicatePaths.length) {
      setGenerateError(
        "Hay nombres duplicados dentro de un mismo grupo. Revisalos antes de generar para no sobrescribir archivos.",
      );
      return;
    }
    if (
      includedAudios.some(
        (audio) => !audio.sha256 || !isValidSha256(audio.sha256),
      )
    ) {
      setGenerateError(
        "Uno o más audios no tienen un hash SHA-256 válido. Volvé a cargarlos.",
      );
      return;
    }
    if (
      includedAudios.some(
        (audio) => (associations[audio.id] ?? []).length === 0,
      )
    ) {
      const missingNames = includedAudios
        .filter((audio) => (associations[audio.id] ?? []).length === 0)
        .map((audio) => `• ${audio.name}`)
        .join("\n");
      const proceed = window.confirm(
        `Estos audios no tienen una captura asociada:\n\n${missingNames}\n\n¿Querés generar el paquete de todos modos?`,
      );
      if (!proceed) return;
    }

    setIsGenerating(true);
    setGenerateError(null);
    revokeGeneratedUrls();

    try {
      const exportAudios = buildExportAudios();
      const exportCaptures = buildExportCaptures();
      const settings = manifestSettings();

      const pdfBytes = await generateManifestPdf(exportAudios, settings);
      const inventoryCsv = generateInventoryCsv(exportAudios);
      const manifestTxt = generateManifestTxt(exportAudios, settings);
      const nextFilingText = generateFilingText(
        exportAudios,
        manifest.publicUrl || undefined,
      );

      const zipResult = await generateEvidenceZip({
        audios: exportAudios,
        captures: exportCaptures,
        manifestPdf: pdfBytes,
        inventoryCsv: manifest.includeCsv ? inventoryCsv : undefined,
        manifestTxt: manifest.includeTxt ? manifestTxt : undefined,
        filingText: nextFilingText,
      });

      const zipBlob = blobFromBytes(zipResult.zipBytes, "application/zip");
      const pdfBlob = blobFromBytes(pdfBytes, "application/pdf");
      const csvBlob = new Blob([inventoryCsv], {
        type: "text/csv;charset=utf-8",
      });
      const manifestTxtBlob = new Blob([manifestTxt], {
        type: "text/plain;charset=utf-8",
      });

      const zipUrl = URL.createObjectURL(zipBlob);
      const pdfUrl = URL.createObjectURL(pdfBlob);
      const csvUrl = manifest.includeCsv
        ? URL.createObjectURL(csvBlob)
        : undefined;
      const manifestTxtUrl = manifest.includeTxt
        ? URL.createObjectURL(manifestTxtBlob)
        : undefined;
      generatedUrlsRef.current = [
        zipUrl,
        pdfUrl,
        ...(csvUrl ? [csvUrl] : []),
        ...(manifestTxtUrl ? [manifestTxtUrl] : []),
      ];

      const integrityCount = zipResult.integrityReport.entries.filter(
        (entry) => entry.matches,
      ).length;

      setLastExportAudios(exportAudios);
      setFilingText(nextFilingText);
      setGenerated({
        zipUrl,
        pdfUrl,
        csvUrl,
        manifestTxtUrl,
        integrityCount,
        integrityTotal: exportAudios.length,
        zipSize: zipBlob.size,
        pdfSize: pdfBlob.size,
      });
      setStep(5);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
      setGenerateError(
        error instanceof Error
          ? error.message
          : "No se pudo generar y verificar el paquete.",
      );
    } finally {
      setIsGenerating(false);
    }
  }

  function refreshFilingText() {
    const next = generateFilingText(
      lastExportAudios,
      manifest.publicUrl || undefined,
    );
    setFilingText(next);
  }

  function clearSession(requireConfirmation = true) {
    if (
      requireConfirmation &&
      files.length > 0 &&
      !window.confirm(
        "¿Borrar la sesión? Se liberarán los archivos cargados y los resultados generados.",
      )
    ) {
      return;
    }

    previewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    previewUrlsRef.current.clear();
    revokeGeneratedUrls();
    setFiles([]);
    setIgnored([]);
    setRejected([]);
    setLoadWarnings([]);
    setAssociations({});
    setAudioOrder([]);
    setExcludedIds(new Set());
    setManifest(initialManifest());
    setGenerated(null);
    setFilingText("");
    setLastExportAudios([]);
    setPreviewUrls({});
    setLoadError(null);
    setGenerateError(null);
    setStep(1);
    batchRef.current = 0;
  }

  function goHome() {
    setMode("home");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function startPrepare() {
    setMode("prepare");
    setStep(files.length ? step : 1);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function startVerify() {
    setMode("verify");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function verifyFile(file: File) {
    setVerifierFile(file);
    setVerifierHash("");
    setVerifierError(null);
    setVerifierLoading(true);
    try {
      setVerifierHash(await hashFileInWorker(file));
    } catch (error) {
      setVerifierError(
        error instanceof Error
          ? error.message
          : "No se pudo calcular el hash del archivo.",
      );
    } finally {
      setVerifierLoading(false);
    }
  }

  function verifierInputChanged(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) void verifyFile(file);
    event.target.value = "";
  }

  const normalizedExpected = expectedHash.trim().toLowerCase().replace(/\s/g, "");
  const expectedIsValid =
    normalizedExpected.length === 0 || isValidSha256(normalizedExpected);
  const verificationMatches =
    verifierHash && isValidSha256(normalizedExpected)
      ? verifierHash === normalizedExpected
      : null;

  return (
    <div className="app-shell">
      <AppHeader
        mode={mode}
        hasSession={files.length > 0}
        onHome={goHome}
        onVerify={startVerify}
        onClear={() => clearSession(true)}
      />

      {mode === "home" && (
        <main>
          <section className="home-hero">
            <div className="home-glow" aria-hidden="true" />
            <div className="home-copy">
              <span className="hero-kicker">
                <ShieldCheck size={17} aria-hidden="true" />
                Preparación segura de evidencia digital
              </span>
              <h1>
                Prepará tu prueba digital,{" "}
                <em>sin alterar los archivos.</em>
              </h1>
              <p className="hero-lead">
                Organizá audios y capturas de WhatsApp, calculá sus huellas
                SHA-256 y generá un manifiesto claro para tu presentación
                judicial.
              </p>
              <div className="hero-actions">
                <button className="primary-button hero-button" onClick={startPrepare}>
                  <FolderOpen size={19} />
                  Preparar prueba digital
                  <ArrowRight size={18} />
                </button>
                <button className="secondary-button hero-button" onClick={startVerify}>
                  <Fingerprint size={19} />
                  Verificar un hash
                </button>
              </div>
              <div className="privacy-line">
                <LockKeyhole size={16} aria-hidden="true" />
                <span>
                  Tus archivos se procesan únicamente en este dispositivo.
                  Nunca se suben a nuestros servidores.
                </span>
              </div>
              <div className="hash-explanation">
                <Fingerprint size={17} aria-hidden="true" />
                <span>
                  <strong>¿Qué es SHA-256?</strong> Es una huella digital del
                  archivo: sirve para comprobar si cambió, pero no demuestra
                  quién lo creó ni qué contiene.
                </span>
              </div>
            </div>

            <div className="hero-process-card">
              <div className="process-card-header">
                <div>
                  <span className="mini-label">Proceso guiado</span>
                  <h2>De los archivos al manifiesto</h2>
                </div>
                <span className="process-badge">5 pasos</span>
              </div>
              <ol className="process-list">
                {[
                  ["01", "Cargá", "ZIP, carpetas o archivos sueltos"],
                  ["02", "Revisá", "Formato real, tamaño y duración"],
                  ["03", "Asociá", "Cada audio con su captura"],
                  ["04", "Generá", "PDF, inventario y texto"],
                  ["05", "Verificá", "Copias idénticas byte por byte"],
                ].map(([number, title, text], index) => (
                  <li key={number}>
                    <span className="process-number">{number}</span>
                    <span className="process-copy">
                      <strong>{title}</strong>
                      <small>{text}</small>
                    </span>
                    {index < 4 ? (
                      <span className="process-connector" />
                    ) : (
                      <BadgeCheck className="process-check" size={20} />
                    )}
                  </li>
                ))}
              </ol>
              <div className="process-foot">
                <ShieldCheck size={18} />
                SHA-256 sobre los bytes originales
              </div>
            </div>
          </section>

          <section className="trust-grid" aria-label="Principios de seguridad">
            <article>
              <span className="trust-icon">
                <LockKeyhole size={20} />
              </span>
              <div>
                <h3>Privado por diseño</h3>
                <p>Sin cuentas, sin base de datos y sin subir el material.</p>
              </div>
            </article>
            <article>
              <span className="trust-icon">
                <FileCheck2 size={20} />
              </span>
              <div>
                <h3>Archivos intactos</h3>
                <p>No convierte, renombra ni recomprime los audios.</p>
              </div>
            </article>
            <article>
              <span className="trust-icon">
                <Fingerprint size={20} />
              </span>
              <div>
                <h3>Verificación doble</h3>
                <p>Recalcula cada hash dentro del paquete final.</p>
              </div>
            </article>
          </section>

          <div className="home-legal">
            <FooterNote />
          </div>
        </main>
      )}

      {mode === "prepare" && (
        <main className="workspace">
          <Stepper current={step} />

          {step === 1 && (
            <section className="workspace-section">
              <SectionHeading
                eyebrow="Paso 1 de 5"
                title="Cargá el material"
                description="Podés seleccionar varios ZIP, una carpeta completa o archivos sueltos. Los nombres y bytes originales se conservan."
              />

              <div
                className={`drop-zone${isDragging ? " is-dragging" : ""}${
                  isLoading ? " is-loading" : ""
                }`}
                onDragEnter={(event) => {
                  event.preventDefault();
                  setIsDragging(true);
                }}
                onDragOver={(event) => event.preventDefault()}
                onDragLeave={() => setIsDragging(false)}
                onDrop={handleDrop}
              >
                {isLoading ? (
                  <>
                    <span className="drop-icon is-processing">
                      <LoaderCircle size={32} />
                    </span>
                    <h2>Procesando localmente</h2>
                    <p aria-live="polite" role="status">
                      {loadingLabel}
                    </p>
                    <span className="loading-bar" aria-hidden="true">
                      <span />
                    </span>
                  </>
                ) : (
                  <>
                    <span className="drop-icon">
                      <CloudUpload size={32} />
                    </span>
                    <h2>Arrastrá tus archivos acá</h2>
                    <p>ZIP, audio e imágenes · también podés elegir una carpeta</p>
                    <div className="drop-actions">
                      <button
                        className="primary-button"
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                      >
                        <Upload size={18} />
                        Elegir ZIP o archivos
                      </button>
                      <button
                        className="secondary-button"
                        type="button"
                        onClick={() => folderInputRef.current?.click()}
                      >
                        <FolderOpen size={18} />
                        Elegir carpeta
                      </button>
                    </div>
                    <span className="local-only">
                      <LockKeyhole size={14} /> Nada sale de este dispositivo
                    </span>
                  </>
                )}
                <input
                  ref={fileInputRef}
                  id="evidence-file-input"
                  type="file"
                  multiple
                  className="file-input-visually-hidden"
                  accept=".zip,.ogg,.opus,.wav,.mp3,.m4a,.aac,.jpg,.jpeg,.png,.webp,.heic,audio/*,image/*"
                  onChange={handleFileInput}
                />
                <input
                  ref={folderInputRef}
                  id="evidence-folder-input"
                  type="file"
                  multiple
                  className="file-input-visually-hidden"
                  onChange={handleFileInput}
                />
              </div>

              {loadError && (
                <div className="alert alert-error" role="alert">
                  <XCircle size={19} />
                  <div>
                    <strong>No pudimos leer todo el material</strong>
                    <p>{loadError}</p>
                  </div>
                </div>
              )}

              {files.length > 0 && (
                <div className="loaded-summary">
                  <div className="summary-heading">
                  <div>
                      <CheckCircle2 size={20} />
                      <div>
                        <strong>Material cargado</strong>
                        <span>
                          {files.length} archivo{files.length === 1 ? "" : "s"} en{" "}
                          {groups.length} grupo{groups.length === 1 ? "" : "s"}
                        </span>
                      </div>
                    </div>
                    <button
                      className="small-button"
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <Upload size={15} /> Agregar
                    </button>
                  </div>
                  <div className="summary-stats">
                    <span>
                      <FileAudio size={18} />
                      <strong>{audios.length}</strong>{" "}
                      {audios.length === 1 ? "audio" : "audios"}
                    </span>
                    <span>
                      <FileImage size={18} />
                      <strong>{images.length}</strong>{" "}
                      {images.length === 1 ? "captura" : "capturas"}
                    </span>
                    <span>
                      <Trash2 size={17} />
                      <strong>{ignored.length}</strong>{" "}
                      {ignored.length === 1 ? "omitido" : "omitidos"}
                    </span>
                    <span>
                      <AlertTriangle size={17} />
                      <strong>
                        {loadWarnings.length + unknownFiles.length + rejected.length}
                      </strong>{" "}
                      {loadWarnings.length +
                        unknownFiles.length +
                        rejected.length ===
                      1
                        ? "aviso"
                        : "avisos"}
                    </span>
                  </div>
                </div>
              )}

              {duplicatePaths.length > 0 && (
                <div className="alert alert-warning">
                  <AlertTriangle size={19} />
                  <div>
                    <strong>Hay rutas duplicadas</strong>
                    <p>
                      Dos archivos quedarían con el mismo nombre dentro del mismo
                      grupo. Podrás revisarlos antes de generar el paquete.
                    </p>
                  </div>
                </div>
              )}

              <div className="workspace-actions">
                <button className="ghost-button" type="button" onClick={goHome}>
                  <ArrowLeft size={17} /> Volver al inicio
                </button>
                <button
                  className="primary-button"
                  type="button"
                  disabled={audios.length === 0 || isLoading}
                  onClick={() => {
                    setStep(2);
                    window.scrollTo({ top: 0, behavior: "smooth" });
                  }}
                >
                  Revisar clasificación <ArrowRight size={17} />
                </button>
              </div>
            </section>
          )}

          {step === 2 && (
            <section className="workspace-section">
              <SectionHeading
                eyebrow="Paso 2 de 5"
                title="Revisá la clasificación"
                description="Detectamos el tipo real por el contenido del archivo, aunque la extensión diga otra cosa."
                action={
                  <div className="heading-stat">
                    <strong>{groups.length}</strong>
                    <span>
                      {groups.length === 1
                        ? "grupo detectado"
                        : "grupos detectados"}
                    </span>
                  </div>
                }
              />

              <div className="review-summary">
                <span>
                  <FileAudio size={18} />
                  <strong>{audios.length}</strong>{" "}
                  {audios.length === 1 ? "audio" : "audios"}
                </span>
                <span>
                  <FileImage size={18} />
                  <strong>{images.length}</strong>{" "}
                  {images.length === 1 ? "captura" : "capturas"}
                </span>
                <span>
                  <Trash2 size={17} />
                  <strong>{ignored.length}</strong>{" "}
                  {ignored.length === 1
                    ? "archivo del sistema omitido"
                    : "archivos del sistema omitidos"}
                </span>
              </div>

              <div className="group-list">
                {groups.map((group) => {
                  const groupAudios = group.files.filter(
                    (file) => file.kind === "audio",
                  );
                  const groupImages = group.files.filter(
                    (file) => file.kind === "image",
                  );
                  return (
                    <article className="group-card" key={group.id}>
                      <div className="group-header">
                        <span className="group-letter">
                          {group.name.slice(0, 2).toUpperCase()}
                        </span>
                        <div>
                          <h2>Grupo {group.name}</h2>
                          <p>
                            {groupAudios.length} audio
                            {groupAudios.length === 1 ? "" : "s"} ·{" "}
                            {groupImages.length} captura
                            {groupImages.length === 1 ? "" : "s"}
                          </p>
                        </div>
                        {groupAudios.length > 0 && groupImages.length === 1 && (
                          <span className="auto-badge">
                            <BadgeCheck size={15} /> Asociación automática
                          </span>
                        )}
                      </div>
                      <div className="file-table">
                        {group.files.map((file) => (
                          <div className="file-row" key={file.id}>
                            <span className={`file-kind file-kind-${file.kind}`}>
                              <EmptyIcon kind={file.kind} />
                            </span>
                            <div className="file-primary">
                              <strong title={file.name}>{file.name}</strong>
                              <span>
                                {formatBytes(file.size)} · {detectedLabel(file)}
                                {file.duration ? ` · ${file.duration}` : ""}
                              </span>
                            </div>
                            {file.warning ? (
                              <span
                                className="warning-chip"
                                title={friendlyFormatWarning(file)}
                              >
                                <Info size={14} /> Formato válido
                              </span>
                            ) : (
                              <span className="ok-chip">
                                <Check size={14} /> Detectado
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    </article>
                  );
                })}
              </div>

              {(ignored.length > 0 || rejected.length > 0) && (
                <details className="ignored-details">
                  <summary>
                    <Trash2 size={17} />
                    Ver archivos ignorados o rechazados (
                    {ignored.length + rejected.length})
                  </summary>
                  <ul>
                    {[...ignored, ...rejected].map((item, index) => (
                      <li key={`${item}-${index}`}>{item}</li>
                    ))}
                  </ul>
                </details>
              )}

              {loadWarnings.length > 0 && (
                <div className="alert alert-warning">
                  <Info size={19} />
                  <div>
                    <strong>
                      {quantityLabel(
                        loadWarnings.length,
                        "archivo válido tiene",
                        "archivos válidos tienen",
                      )}{" "}
                      otro formato interno
                    </strong>
                    <p>
                      Se incluirá{loadWarnings.length === 1 ? "" : "n"} sin
                      cambios. No necesitás hacer nada con este aviso.
                    </p>
                  </div>
                </div>
              )}

              {unknownFiles.length > 0 && (
                <div className="alert alert-warning">
                  <AlertTriangle size={19} />
                  <div>
                    <strong>
                      {quantityLabel(
                        unknownFiles.length,
                        "archivo no reconocido",
                        "archivos no reconocidos",
                      )}
                    </strong>
                    <p>
                      No se incluirá{unknownFiles.length === 1 ? "" : "n"} en
                      el paquete. Revisá el nombre dentro de cada grupo.
                    </p>
                  </div>
                </div>
              )}

              <div className="workspace-actions">
                <button className="ghost-button" onClick={() => setStep(1)}>
                  <ArrowLeft size={17} /> Volver
                </button>
                <button className="primary-button" onClick={() => setStep(3)}>
                  Asociar audios y capturas <ArrowRight size={17} />
                </button>
              </div>
            </section>
          )}

          {step === 3 && (
            <section className="workspace-section wide-section">
              <SectionHeading
                eyebrow="Paso 3 de 5"
                title="Asociá y ordená los audios"
                description="Confirmá qué captura acompaña a cada audio. El orden que ves será el del manifiesto."
                action={
                  <div className="heading-stat">
                    <strong>{includedAudios.length}</strong>
                    <span>
                      {includedAudios.length === 1
                        ? "audio incluido"
                        : "audios incluidos"}
                    </span>
                  </div>
                }
              />

              <div className="association-list">
                {orderedAudios.map((audio, index) => {
                  const groupCaptures = images.filter(
                    (image) => image.groupId === audio.groupId,
                  );
                  const isExcluded = excludedIds.has(audio.id);
                  return (
                    <article
                      className={`audio-card${isExcluded ? " is-excluded" : ""}`}
                      key={audio.id}
                    >
                      <div className="audio-order">
                        <span>{String(index + 1).padStart(2, "0")}</span>
                        <div>
                          <button
                            type="button"
                            aria-label={`Subir ${audio.name}`}
                            disabled={index === 0}
                            onClick={() => moveAudio(audio.id, -1)}
                          >
                            <ArrowUp size={15} />
                          </button>
                          <button
                            type="button"
                            aria-label={`Bajar ${audio.name}`}
                            disabled={index === orderedAudios.length - 1}
                            onClick={() => moveAudio(audio.id, 1)}
                          >
                            <ArrowDown size={15} />
                          </button>
                        </div>
                      </div>
                      <div className="audio-content">
                        <div className="audio-card-heading">
                          <div>
                            <span className="group-pill">Grupo {audio.group}</span>
                            <h2 title={audio.name}>{audio.name}</h2>
                          </div>
                          <button
                            className={`exclude-button${
                              isExcluded ? " is-restore" : ""
                            }`}
                            type="button"
                            onClick={() => toggleExcluded(audio)}
                          >
                            {isExcluded ? (
                              <>
                                <RotateCcw size={15} /> Volver a incluir
                              </>
                            ) : (
                              <>
                                <X size={15} /> Excluir
                              </>
                            )}
                          </button>
                        </div>

                        {!isExcluded && (
                          <>
                            <audio
                              className="audio-player"
                              controls
                              preload="metadata"
                              src={previewUrls[audio.id]}
                            >
                              Tu navegador no puede reproducir este audio.
                            </audio>

                            <div className="capture-section">
                              <div className="capture-heading">
                                <div>
                                  <h3>Elegí la captura</h3>
                                  <p>
                                    Elegí una o más capturas del mismo grupo.
                                  </p>
                                </div>
                                {(associations[audio.id] ?? []).length > 0 && (
                                  <span className="selected-count">
                                    <Check size={14} />{" "}
                                    {(associations[audio.id] ?? []).length} elegida
                                    {(associations[audio.id] ?? []).length === 1
                                      ? ""
                                      : "s"}
                                  </span>
                                )}
                              </div>
                              {groupCaptures.length ? (
                                <div className="capture-options">
                                  {groupCaptures.map((capture) => {
                                    const selected = (
                                      associations[audio.id] ?? []
                                    ).includes(capture.id);
                                    return (
                                      <button
                                        className={`capture-option${
                                          selected ? " is-selected" : ""
                                        }`}
                                        type="button"
                                        key={capture.id}
                                        aria-pressed={selected}
                                        onClick={() =>
                                          toggleAssociation(audio.id, capture.id)
                                        }
                                      >
                                        {detectedMime(capture).includes("heic") ? (
                                          <span className="heic-placeholder">
                                            <FileImage size={26} />
                                            HEIC
                                          </span>
                                        ) : (
                                          // eslint-disable-next-line @next/next/no-img-element
                                          <img
                                            src={previewUrls[capture.id]}
                                            alt=""
                                          />
                                        )}
                                        <span title={capture.name}>
                                          {capture.name}
                                        </span>
                                        <i aria-hidden="true">
                                          {selected && <Check size={14} />}
                                        </i>
                                      </button>
                                    );
                                  })}
                                </div>
                              ) : (
                                <div className="empty-captures">
                                  <FileImage size={20} />
                                  No hay capturas en el grupo {audio.group}.
                                </div>
                              )}
                              {groupCaptures.length > 0 &&
                                (associations[audio.id] ?? []).length === 0 && (
                                  <div
                                    className="association-needed"
                                    role="status"
                                  >
                                    <AlertTriangle size={17} />
                                    Falta elegir al menos una captura para este
                                    audio.
                                  </div>
                                )}
                            </div>

                            <details className="technical-details">
                              <summary>
                                <Info size={16} />
                                Ver detalles técnicos
                              </summary>
                              <div className="technical-grid">
                                <span>
                                  <small>Duración</small>
                                  <strong>
                                    {audio.duration ?? "No disponible"}
                                  </strong>
                                </span>
                                <span>
                                  <small>Tamaño del archivo</small>
                                  <strong>
                                    {audio.size.toLocaleString("es-AR")} bytes
                                  </strong>
                                </span>
                                <span>
                                  <small>Formato interno del audio</small>
                                  <strong>{detectedLabel(audio)}</strong>
                                </span>
                              </div>

                              {audio.warning && (
                                <div className="inline-warning">
                                  <Info size={16} />
                                  {friendlyFormatWarning(audio)}
                                </div>
                              )}

                              <div className="hash-box">
                                <div>
                                  <span>Huella SHA-256</span>
                                  <code>{audio.sha256}</code>
                                </div>
                                <button
                                  type="button"
                                  aria-label={`Copiar hash de ${audio.name}`}
                                  onClick={() =>
                                    void copyText(audio.sha256 ?? "", audio.id)
                                  }
                                >
                                  {copiedKey === audio.id ? (
                                    <Check size={17} />
                                  ) : (
                                    <Copy size={17} />
                                  )}
                                </button>
                              </div>
                            </details>
                          </>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>

              {audiosWithoutCapture.length > 0 && (
                <div className="alert alert-warning association-summary" role="status">
                  <AlertTriangle size={19} />
                  <div>
                    <strong>
                      {quantityLabel(
                        audiosWithoutCapture.length,
                        "audio todavía no tiene captura",
                        "audios todavía no tienen captura",
                      )}
                    </strong>
                    <p>
                      Podés continuar, pero te conviene elegir una captura para
                      cada audio antes de preparar el manifiesto.
                    </p>
                  </div>
                </div>
              )}

              <div className="workspace-actions">
                <button className="ghost-button" onClick={() => setStep(2)}>
                  <ArrowLeft size={17} /> Volver
                </button>
                <button
                  className="primary-button"
                  disabled={includedAudios.length === 0}
                  onClick={() => setStep(4)}
                >
                  Continuar al manifiesto <ArrowRight size={17} />
                </button>
              </div>
            </section>
          )}

          {step === 4 && (
            <section className="workspace-section wide-section">
              <SectionHeading
                eyebrow="Paso 4 de 5"
                title="Completá el manifiesto"
                description="Estos datos aparecerán en el PDF y en el texto listo para incorporar al escrito."
              />

              <div className="manifest-layout">
                <div className="form-card">
                  <div className="form-section">
                    <div className="form-section-title">
                      <span>1</span>
                      <div>
                        <h2>Datos generales</h2>
                        <p>Los campos del expediente son opcionales.</p>
                      </div>
                    </div>
                    <div className="form-grid two-columns">
                      <label>
                        <span>Fecha y hora de cálculo</span>
                        <input
                          type="datetime-local"
                          value={manifest.calculationDate}
                          onChange={(event) =>
                            updateManifest("calculationDate", event.target.value)
                          }
                        />
                      </label>
                      <label>
                        <span>Zona horaria</span>
                        <input
                          type="text"
                          value={manifest.timeZone}
                          onChange={(event) =>
                            updateManifest("timeZone", event.target.value)
                          }
                        />
                      </label>
                    </div>
                    <label>
                      <span>Expediente o carátula</span>
                      <input
                        type="text"
                        placeholder="Ej.: Pérez c/ Gómez s/ daños y perjuicios"
                        value={manifest.caseReference}
                        onChange={(event) =>
                          updateManifest("caseReference", event.target.value)
                        }
                      />
                    </label>
                    <label>
                      <span>Observaciones</span>
                      <textarea
                        rows={3}
                        placeholder="Información adicional que deba constar…"
                        value={manifest.observations}
                        onChange={(event) =>
                          updateManifest("observations", event.target.value)
                        }
                      />
                    </label>
                  </div>

                  <div className="form-section">
                    <div className="form-section-title">
                      <span>2</span>
                      <div>
                        <h2>Textos del manifiesto</h2>
                        <p>Podés editarlos antes de generar el PDF.</p>
                      </div>
                    </div>
                    <label>
                      <span>Texto introductorio</span>
                      <textarea
                        rows={7}
                        value={manifest.introduction}
                        onChange={(event) =>
                          updateManifest("introduction", event.target.value)
                        }
                      />
                    </label>
                    <label>
                      <span>Constancia final</span>
                      <textarea
                        rows={7}
                        value={manifest.conclusion}
                        onChange={(event) =>
                          updateManifest("conclusion", event.target.value)
                        }
                      />
                    </label>
                  </div>

                  <div className="form-section">
                    <div className="form-section-title">
                      <span>3</span>
                      <div>
                        <h2>Enlace público y archivos auxiliares</h2>
                        <p>
                          Si querés que aparezca en el PDF y el ZIP, pegalo antes
                          de generar.
                        </p>
                      </div>
                    </div>
                    <label>
                      <span>Enlace público de solo lectura</span>
                      <div className="input-with-icon">
                        <Link2 size={17} />
                        <input
                          aria-describedby="public-url-help public-url-error"
                          aria-invalid={publicUrlIsInvalid}
                          type="url"
                          placeholder="https://drive.google.com/drive/folders/…"
                          value={manifest.publicUrl}
                          onChange={(event) =>
                            updateManifest("publicUrl", event.target.value)
                          }
                        />
                      </div>
                      <small id="public-url-help">
                        Es opcional. La aplicación no publica nada
                        automáticamente.
                      </small>
                      {publicUrlIsInvalid && (
                        <small className="field-error" id="public-url-error">
                          Pegá un enlace válido que comience con https://
                        </small>
                      )}
                    </label>
                    <div className="check-list">
                      <label className="check-row">
                        <input
                          type="checkbox"
                          checked={manifest.includeCapturesWithoutAudio}
                          onChange={(event) =>
                            updateManifest(
                              "includeCapturesWithoutAudio",
                              event.target.checked,
                            )
                          }
                        />
                        <span>
                          <strong>Incluir capturas sin audio</strong>
                          <small>
                            Se guardarán en 02_Capturas_sin_audio, separadas por
                            grupo.
                          </small>
                        </span>
                      </label>
                      <label className="check-row">
                        <input
                          type="checkbox"
                          checked={manifest.includeCsv}
                          onChange={(event) =>
                            updateManifest("includeCsv", event.target.checked)
                          }
                        />
                        <span>
                          <strong>Incluir inventario CSV</strong>
                          <small>Útil para revisar los datos en una planilla.</small>
                        </span>
                      </label>
                      <label className="check-row">
                        <input
                          type="checkbox"
                          checked={manifest.includeTxt}
                          onChange={(event) =>
                            updateManifest("includeTxt", event.target.checked)
                          }
                        />
                        <span>
                          <strong>Incluir manifiesto TXT</strong>
                          <small>Una copia de texto plano para archivo.</small>
                        </span>
                      </label>
                    </div>
                  </div>
                </div>

                <aside className="manifest-sidebar">
                  <div className="package-preview">
                    <span className="mini-label">Resumen del paquete</span>
                    <h2>{PACKAGE_NAME}</h2>
                    <ul>
                      <li>
                        <span className="tree-branch">01</span>
                        <div>
                          <strong>Audios incluidos</strong>
                          <small>
                            {quantityLabel(
                              includedAudios.length,
                              "audio",
                            )}{" "}
                            ·{" "}
                            {quantityLabel(
                              includedAudios.length -
                                audiosWithoutCapture.length,
                              "con captura",
                              "con captura",
                            )}{" "}
                            ·{" "}
                            {quantityLabel(
                              audiosWithoutCapture.length,
                              "sin captura",
                              "sin captura",
                            )}
                          </small>
                        </div>
                      </li>
                      {manifest.includeCapturesWithoutAudio && (
                        <li>
                          <span className="tree-branch">02</span>
                          <div>
                            <strong>Capturas sin audio</strong>
                            <small>
                              {quantityLabel(
                                images.filter(
                                  (image) =>
                                    !includedAudios.some(
                                      (audio) => audio.groupId === image.groupId,
                                    ),
                                ).length,
                                "captura",
                              )}
                            </small>
                          </div>
                        </li>
                      )}
                      <li>
                        <FileText size={18} />
                        <div>
                          <strong>Manifiesto PDF</strong>
                          <small>Hash completo y páginas numeradas</small>
                        </div>
                      </li>
                    </ul>
                  </div>
                  <div className="integrity-promise">
                    <ShieldCheck size={23} />
                    <div>
                      <strong>Verificación antes de descargar</strong>
                      <p>
                        Volveremos a calcular los hashes dentro del ZIP. Si una
                        copia no coincide, el paquete no se marcará como listo.
                      </p>
                    </div>
                  </div>
                </aside>
              </div>

              {generateError && (
                <div className="alert alert-error" role="alert">
                  <XCircle size={19} />
                  <div>
                    <strong>No se pudo generar el paquete</strong>
                    <p>{generateError}</p>
                  </div>
                </div>
              )}

              <div className="workspace-actions">
                <button
                  className="ghost-button"
                  disabled={isGenerating}
                  onClick={() => setStep(3)}
                >
                  <ArrowLeft size={17} /> Volver
                </button>
                <button
                  className="primary-button generate-button"
                  disabled={
                    isGenerating ||
                    duplicatePaths.length > 0 ||
                    publicUrlIsInvalid
                  }
                  onClick={() => void generatePackage()}
                >
                  {isGenerating ? (
                    <>
                      <LoaderCircle className="spin" size={18} />
                      Generando y verificando…
                    </>
                  ) : (
                    <>
                      <ShieldCheck size={18} />
                      Generar paquete verificado
                    </>
                  )}
                </button>
              </div>
            </section>
          )}

          {step === 5 && generated && (
            <section className="workspace-section wide-section result-section">
              <div className="result-hero">
                <span className="success-mark">
                  <Check size={30} />
                </span>
                <span className="eyebrow">Paquete listo</span>
                <h1>El paquete está listo.</h1>
                <p>
                  Comprobamos que {generated.integrityCount} de{" "}
                  {generated.integrityTotal} copias dentro del ZIP son idénticas
                  a los audios que cargaste.
                </p>
                <div className="verified-pill">
                  <BadgeCheck size={18} />
                  Copias del ZIP comprobadas
                </div>
                <p className="result-scope">
                  Esta comprobación no determina quién creó el archivo ni la
                  autenticidad de la conversación.
                </p>
              </div>

              <div className="download-grid">
                <a
                  className="download-card is-primary"
                  href={generated.zipUrl}
                  download={`${PACKAGE_NAME}.zip`}
                >
                  <span className="download-icon">
                    <FileArchive size={25} />
                  </span>
                  <div>
                    <span className="mini-label">Paso principal</span>
                    <h2>Descargar ZIP completo</h2>
                    <p>{formatBytes(generated.zipSize)}</p>
                  </div>
                  <Download size={20} />
                </a>
                <a
                  className="download-card"
                  href={generated.pdfUrl}
                  download="MANIFIESTO_SHA256_AUDIOS.pdf"
                >
                  <span className="download-icon">
                    <FileText size={24} />
                  </span>
                  <div>
                    <span className="mini-label">Documento principal</span>
                    <h2>Descargar manifiesto PDF</h2>
                    <p>{formatBytes(generated.pdfSize)}</p>
                  </div>
                  <Download size={20} />
                </a>
                {generated.csvUrl && (
                  <a
                    className="download-card"
                    href={generated.csvUrl}
                    download="INVENTARIO_AUDIOS_SHA256.csv"
                  >
                    <span className="download-icon">
                      <FileCheck2 size={24} />
                    </span>
                    <div>
                      <span className="mini-label">Archivo opcional</span>
                      <h2>Inventario CSV</h2>
                      <p>Compatible con planillas</p>
                    </div>
                    <Download size={20} />
                  </a>
                )}
                {generated.manifestTxtUrl && (
                  <a
                    className="download-card"
                    href={generated.manifestTxtUrl}
                    download="MANIFIESTO_SHA256_AUDIOS.txt"
                  >
                    <span className="download-icon">
                      <Clipboard size={24} />
                    </span>
                    <div>
                      <span className="mini-label">Archivo opcional</span>
                      <h2>Manifiesto TXT</h2>
                      <p>Texto plano UTF-8</p>
                    </div>
                    <Download size={20} />
                  </a>
                )}
              </div>
              <a
                className="pdf-preview-link"
                href={generated.pdfUrl}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink size={16} />
                Ver el manifiesto PDF antes de presentarlo
              </a>

              <div className="result-layout">
                <article className="filing-card">
                  <div className="card-title-row">
                    <div>
                      <span className="mini-label">
                        {filingTextIsReady
                          ? "Listo para usar"
                          : "Falta completar el enlace público"}
                      </span>
                      <h2>Texto para incorporar al escrito</h2>
                    </div>
                    <button
                      className="small-button"
                      type="button"
                      disabled={!filingTextIsReady}
                      onClick={() => void copyText(filingText, "filing-text")}
                    >
                      {copiedKey === "filing-text" ? (
                        <>
                          <Check size={16} /> Copiado
                        </>
                      ) : (
                        <>
                          <Copy size={16} />{" "}
                          {filingTextIsReady
                            ? "Copiar texto"
                            : "Falta el enlace"}
                        </>
                      )}
                    </button>
                  </div>
                  <div
                    className={`filing-status${
                      filingTextIsReady ? " is-ready" : " is-missing"
                    }`}
                    role="status"
                  >
                    {filingTextIsReady ? (
                      <>
                        <CheckCircle2 size={18} />
                        El enlace público ya está incluido. Podés copiar este
                        texto.
                      </>
                    ) : (
                      <>
                        <AlertTriangle size={18} />
                        Subí el material a Drive, comprobá que el enlace abra sin
                        iniciar sesión y pegalo en el recuadro de la derecha.
                      </>
                    )}
                  </div>
                  <textarea
                    className="filing-textarea"
                    value={filingText}
                    onChange={(event) => setFilingText(event.target.value)}
                    aria-label="Texto para incorporar al escrito"
                  />
                  <button
                    className="text-download"
                    type="button"
                    disabled={!filingTextIsReady}
                    onClick={() =>
                      downloadTextFile(
                        filingText,
                        "TEXTO_PARA_INCORPORAR_AL_ESCRITO.txt",
                      )
                    }
                  >
                    <Download size={16} />{" "}
                    {filingTextIsReady
                      ? "Descargar texto como TXT"
                      : "TXT disponible después de agregar el enlace"}
                  </button>
                </article>

                <aside className="drive-card">
                  <span className="drive-icon">
                    <Upload size={22} />
                  </span>
                  <span className="mini-label">Publicación opcional</span>
                  <h2>Subir a Google Drive</h2>
                  <p>
                    La carga es manual para que conserves el control del material
                    y confirmes expresamente cuándo hacerlo público.
                  </p>
                  <ol>
                    <li>
                      <span>1</span> Subí el ZIP o la carpeta extraída.
                    </li>
                    <li>
                      <span>2</span> Elegí “Cualquier persona con el enlace” y
                      “Lector”.
                    </li>
                    <li>
                      <span>3</span> Probá el enlace en una ventana de incógnito.
                    </li>
                  </ol>
                  <a
                    className="secondary-button drive-link"
                    href="https://drive.google.com/"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Abrir Google Drive <ExternalLink size={16} />
                  </a>
                  <label>
                    <span>Pegar enlace público</span>
                    <input
                      aria-describedby="result-public-url-help"
                      aria-invalid={publicUrlIsInvalid}
                      type="url"
                      placeholder="https://drive.google.com/…"
                      value={manifest.publicUrl}
                      onChange={(event) =>
                        updateManifest("publicUrl", event.target.value)
                      }
                    />
                    <small id="result-public-url-help">
                      {!publicUrlValue
                        ? "Pegá un enlace que comience con https://"
                        : publicUrlIsInvalid
                          ? "El enlace todavía no es válido."
                          : filingTextIsReady
                            ? "El enlace ya está incluido en el texto."
                            : "Enlace válido. Ahora actualizá el texto."}
                    </small>
                  </label>
                  <button
                    className="small-button full-width"
                    type="button"
                    disabled={!lastExportAudios.length || !hasValidPublicUrl}
                    onClick={refreshFilingText}
                  >
                    <Link2 size={15} /> Actualizar texto con el enlace
                  </button>
                  <div className="result-link-note">
                    <Info size={16} />
                    Este botón solo actualiza el texto para el escrito. Para
                    incluir el enlace en el PDF y el ZIP, volvé al manifiesto y
                    generá el paquete nuevamente.
                  </div>
                  <div className="public-warning">
                    <AlertTriangle size={16} />
                    Un enlace público puede ser visto o descargado por cualquiera
                    que lo tenga.
                  </div>
                </aside>
              </div>

              <FooterNote />

              <div className="workspace-actions result-actions">
                <button className="ghost-button" onClick={() => setStep(4)}>
                  <ArrowLeft size={17} /> Volver al manifiesto
                </button>
                <button
                  className="secondary-button"
                  onClick={() => {
                    clearSession(true);
                    setMode("home");
                  }}
                >
                  <RotateCcw size={17} /> Preparar otra prueba
                </button>
              </div>
            </section>
          )}
        </main>
      )}

      {mode === "verify" && (
        <main className="verify-page">
          <button className="back-link" type="button" onClick={goHome}>
            <ArrowLeft size={17} /> Volver al inicio
          </button>
          <div className="verify-heading">
            <span className="verify-mark">
              <Fingerprint size={29} />
            </span>
            <span className="eyebrow">Verificación independiente</span>
            <h1>Verificá la huella de cualquier archivo.</h1>
            <p>
              Calculá su SHA-256 o comparalo con un valor esperado. El archivo se
              procesa localmente y no se modifica.
            </p>
          </div>

          <div className="verify-card">
            <div
              className={`verify-drop${verifierLoading ? " is-loading" : ""}`}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                const file = event.dataTransfer.files[0];
                if (file) void verifyFile(file);
              }}
            >
              {verifierLoading ? (
                <>
                  <LoaderCircle className="spin" size={28} />
                  <strong aria-live="polite" role="status">
                    Calculando SHA-256…
                  </strong>
                  <span>Puede demorar unos segundos en archivos grandes.</span>
                </>
              ) : verifierFile ? (
                <>
                  <FileCheck2 size={28} />
                  <strong>{verifierFile.name}</strong>
                  <span>{formatBytes(verifierFile.size)}</span>
                  <button
                    className="small-button"
                    type="button"
                    onClick={() => verifierInputRef.current?.click()}
                  >
                    Cambiar archivo
                  </button>
                </>
              ) : (
                <>
                  <Upload size={28} />
                  <strong>Arrastrá un archivo acá</strong>
                  <span>Puede ser el original o una copia descargada.</span>
                  <button
                    className="primary-button"
                    type="button"
                    onClick={() => verifierInputRef.current?.click()}
                  >
                    Elegir archivo
                  </button>
                </>
              )}
              <input
                ref={verifierInputRef}
                id="verifier-file-input"
                type="file"
                className="file-input-visually-hidden"
                onChange={verifierInputChanged}
              />
            </div>

            {verifierError && (
              <div className="alert alert-error" role="alert">
                <XCircle size={18} />
                <p>{verifierError}</p>
              </div>
            )}

            {verifierHash && (
              <div className="verify-result">
                <label>
                  <span>SHA-256 calculado</span>
                  <div className="hash-input">
                    <code>{verifierHash}</code>
                    <button
                      type="button"
                      aria-label="Copiar hash calculado"
                      onClick={() =>
                        void copyText(verifierHash, "verifier-hash")
                      }
                    >
                      {copiedKey === "verifier-hash" ? (
                        <Check size={17} />
                      ) : (
                        <Copy size={17} />
                      )}
                    </button>
                  </div>
                </label>
                <label>
                  <span>Hash esperado (opcional)</span>
                  <input
                    className={!expectedIsValid ? "is-invalid" : ""}
                    aria-describedby="expected-hash-error"
                    aria-invalid={!expectedIsValid}
                    type="text"
                    inputMode="text"
                    spellCheck={false}
                    placeholder="Pegá aquí los 64 caracteres…"
                    value={expectedHash}
                    onChange={(event) => setExpectedHash(event.target.value)}
                  />
                  {!expectedIsValid && (
                    <small className="field-error" id="expected-hash-error">
                      El hash debe tener 64 caracteres hexadecimales.
                    </small>
                  )}
                </label>

                {verificationMatches !== null && (
                  <div
                    className={`match-result${
                      verificationMatches ? " is-match" : " is-mismatch"
                    }`}
                    role="status"
                  >
                    {verificationMatches ? (
                      <CheckCircle2 size={25} />
                    ) : (
                      <XCircle size={25} />
                    )}
                    <div>
                      <strong>
                        {verificationMatches ? "COINCIDE" : "NO COINCIDE"}
                      </strong>
                      <p>
                        {verificationMatches
                          ? "El archivo es idéntico byte por byte al que corresponde el hash esperado."
                          : "El archivo no es idéntico byte por byte. No lo reemplaces ni lo presentes como la misma copia."}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="verify-tips">
            <article>
              <ShieldCheck size={20} />
              <div>
                <strong>Sin subir el archivo</strong>
                <p>El cálculo ocurre dentro de tu navegador.</p>
              </div>
            </article>
            <article>
              <Hash size={20} />
              <div>
                <strong>Comparación exacta</strong>
                <p>Un solo byte distinto produce otra huella.</p>
              </div>
            </article>
          </div>
          <FooterNote />
        </main>
      )}

      <footer className="site-footer">
        <Logo />
        <span>
          Versión {APP_VERSION} · Procesamiento local · Sin almacenamiento
        </span>
        <span className="footer-security">
          <LockKeyhole size={14} /> SHA-256
        </span>
      </footer>
    </div>
  );
}
