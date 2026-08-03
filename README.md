# Prueba Digital

Aplicación web en español para organizar audios, videos y capturas,
calcular sus huellas SHA-256 y preparar un paquete documental para una
presentación judicial.

Sitio público: [prueba-digital.onrender.com](https://prueba-digital.onrender.com)

Todo el procesamiento ocurre en el navegador. Los archivos no se envían a un
servidor, no se guardan en una base de datos y no se convierten ni recomprimen.

## Qué hace

- Carga ZIP, varias carpetas juntas o archivos sueltos.
- Omite automáticamente archivos auxiliares de macOS.
- Detecta el formato real por el contenido, no solo por la extensión.
- Calcula SHA-256 sobre los bytes originales de cada audio y video.
- Permite asociar una o más capturas a cada audio o video y definir su orden.
- Contempla material compuesto sólo por audios, sólo por videos o por ambos,
  con capturas o sin ellas.
- Genera una carpeta ZIP para Drive con sólo las dos carpetas de evidencia y el
  manifiesto PDF.
- Muestra el inventario CSV y las copias TXT por separado para revisarlos,
  editarlos y descargarlos sin agregarlos a Drive.
- Recalcula los hashes de los audios y videos dentro del ZIP antes de marcarlo como
  listo.
- Incluye un verificador independiente para comparar cualquier archivo con un
  hash esperado.

## Formatos admitidos

La aplicación identifica los archivos por su contenido interno, aunque la
extensión del nombre sea incorrecta:

- Audio: WAV, OGG, Opus, MP3, M4A y AAC.
- Video: MP4, MOV, 3GP, WebM, MKV, AVI, OGV, MPEG/MPG, TS/MTS/M2TS,
  WMV/ASF y FLV.
- Capturas: JPEG, PNG, WebP y HEIC/HEIF.

Que un navegador no pueda mostrar la vista previa de un video no significa que
el archivo sea inválido. Algunos contenedores o códecs —en especial los formatos
de cámaras, grabadores y sistemas antiguos— no se reproducen en todos los
navegadores; si el formato está reconocido, la aplicación puede conservar,
calcular y presentar su hash sin convertir ni alterar sus bytes.

Como medida preventiva, el límite actual es de 256 MiB por archivo y 1 GiB para
el total seleccionado. Si el material supera esos valores, la aplicación lo
informa antes de preparar el paquete.

## Alcance

SHA-256 permite comprobar si un archivo cambió desde que se calculó su huella.
Por sí solo no acredita autoría, identidad de las personas o voces, fecha,
origen del material ni autenticidad de su contenido. La valoración y cualquier
pericia corresponden al tribunal.

## Desarrollo local

Requiere Node.js 22.13 o posterior.

```bash
npm install
npm run dev
```

La aplicación queda disponible en `http://localhost:3000`.

## Verificación

```bash
npm run lint
npm test
```

La suite cubre detección por magic bytes, audio, video, SHA-256, agrupación,
asociaciones, seguridad de ZIP, generación de PDF/CSV/TXT/ZIP e integridad de
las copias.
También se incluyen fixtures sintéticos para el recorrido manual de QA:

```bash
node tests/create-qa-fixtures.mjs
```

El generador prepara casos de sólo video, material mixto y varias carpetas con
distintas combinaciones de audios, videos y capturas. Los archivos MP4 y WebM
sintéticos sirven para probar detección, hash y preservación; deliberadamente no
contienen pistas reproducibles y no deben usarse para evaluar el reproductor.

Los nueve ZIP reales y los siete hashes de aceptación mencionados en el brief
no forman parte del repositorio; deben validarse cuando se disponga de esos
archivos.

## Despliegue

El proyecto se publica como sitio estático en Render mediante
[`render.yaml`](./render.yaml). Cada avance validado que se incorpora a `main`
activa automáticamente un nuevo despliegue. El mismo código también incluye la
configuración de OpenAI Sites en
[`.openai/hosting.json`](./.openai/hosting.json).

No se requieren variables de entorno, almacenamiento, cuentas ni servicios de
backend.

## Licencia

Distribuido bajo la [licencia MIT](LICENSE).
