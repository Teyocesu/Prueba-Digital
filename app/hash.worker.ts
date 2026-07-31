/// <reference lib="webworker" />

type HashRequest = {
  id: string;
  buffer: ArrayBuffer;
};

type HashResponse =
  | { id: string; hash: string }
  | { id: string; error: string };

self.onmessage = async (event: MessageEvent<HashRequest>) => {
  const { id, buffer } = event.data;

  try {
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    const hash = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");

    self.postMessage({ id, hash } satisfies HashResponse);
  } catch (error) {
    self.postMessage({
      id,
      error:
        error instanceof Error
          ? error.message
          : "No se pudo calcular el hash.",
    } satisfies HashResponse);
  }
};

export {};
