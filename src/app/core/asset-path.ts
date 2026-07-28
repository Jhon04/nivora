import { convertFileSrc } from '@tauri-apps/api/core';

/**
 * Resolución de assets. El documento guarda el **nombre relativo** del fichero
 * (p.ej. `a1b2….png`); para mostrarlo hay que resolverlo contra la carpeta
 * `Workspace/assets/` de esta máquina. Así el workspace es portable entre
 * equipos (no depende de rutas absolutas).
 *
 * La carpeta base se fija una vez al iniciar la app (`setBaseAssets`), porque el
 * render de Tiptap es síncrono y no puede esperar una promesa.
 */
let baseAssets = '';

export function setBaseAssets(dir: string): void {
  baseAssets = dir;
}

/** ¿`src` es una URL o dato embebido (no hay que resolverlo)? */
function esUrl(src: string): boolean {
  return src.includes('://') || src.startsWith('data:') || src.startsWith('blob:');
}

/** ¿`src` es una ruta absoluta (documentos antiguos)? */
function esRutaAbsoluta(src: string): boolean {
  return src.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(src);
}

/**
 * Convierte el `src` guardado (nombre relativo nuevo, ruta absoluta antigua, o
 * URL) en una URL que el webview puede mostrar.
 */
export function resolverSrc(src: string | null | undefined): string {
  if (!src) return '';
  if (esUrl(src)) return src;
  if (esRutaAbsoluta(src)) return convertFileSrc(src); // compat. documentos antiguos
  // Nombre relativo → resolver contra la carpeta de assets.
  return baseAssets ? convertFileSrc(`${baseAssets}/${src}`) : '';
}

/**
 * Convierte un `src` a su nombre relativo (para migrar documentos antiguos que
 * guardaron ruta absoluta). Las URLs/datos se dejan intactos.
 */
export function nombreRelativo(src: string | null | undefined): string {
  if (!src) return '';
  if (esUrl(src)) return src;
  if (baseAssets && src.startsWith(baseAssets)) {
    return src.slice(baseAssets.length).replace(/^[/\\]+/, '');
  }
  if (esRutaAbsoluta(src)) return src.split(/[/\\]/).pop() ?? src;
  return src; // ya es relativo
}

/**
 * Recorre el JSON de bloques y reescribe el `src` de las imágenes a nombre
 * relativo (migración in situ de documentos antiguos). Muta el nodo recibido.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function migrarAssetsARelativo(nodo: any): void {
  if (!nodo || typeof nodo !== 'object') return;
  if (nodo.type === 'image' && nodo.attrs?.src) {
    nodo.attrs.src = nombreRelativo(nodo.attrs.src);
  }
  if (Array.isArray(nodo.content)) {
    for (const hijo of nodo.content) migrarAssetsARelativo(hijo);
  }
}
