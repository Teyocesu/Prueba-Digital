# Prueba Digital

Aplicación web en español para organizar audios y capturas de WhatsApp,
calcular sus huellas SHA-256 y preparar un paquete documental para una
presentación judicial.

Sitio público: [prueba-digital.onrender.com](https://prueba-digital.onrender.com)

Todo el procesamiento ocurre en el navegador. Los archivos no se envían a un
servidor, no se guardan en una base de datos y no se convierten ni recomprimen.

## Qué hace

- Carga ZIP, carpetas o archivos sueltos.
- Omite automáticamente archivos auxiliares de macOS.
- Detecta el formato real por el contenido, no solo por la extensión.
- Calcula SHA-256 sobre los bytes originales de cada audio.
- Permite asociar una o más capturas a cada audio y definir su orden.
- Genera un ZIP organizado, un manifiesto PDF, un inventario CSV y copias TXT.
- Recalcula los hashes de los audios dentro del ZIP antes de marcarlo como
  listo.
- Incluye un verificador independiente para comparar cualquier archivo con un
  hash esperado.

## Alcance

SHA-256 permite comprobar si un archivo cambió desde que se calculó su huella.
Por sí solo no acredita autoría, identidad de una voz, fecha, origen del mensaje
ni autenticidad integral de una conversación. La valoración y cualquier pericia
corresponden al tribunal.

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

La suite cubre detección por magic bytes, WAV, SHA-256, agrupación, asociaciones,
seguridad de ZIP, generación de PDF/CSV/TXT/ZIP e integridad de las copias.
También se incluyen fixtures sintéticos para el recorrido manual de QA:

```bash
node tests/create-qa-fixtures.mjs
```

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
