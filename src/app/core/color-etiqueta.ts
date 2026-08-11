/**
 * Color de una etiqueta, derivado de su nombre.
 *
 * Sin paleta guardada ni elección del usuario: el mismo nombre da siempre el
 * mismo tono, en este equipo y en cualquier otro, sin nada que sincronizar.
 *
 * Se devuelve `light-dark()` en vez de mirar el tema desde TypeScript: así el
 * color lo resuelve el navegador y sigue al vuelo los cambios de tema.
 */

/** Tono (0-359) estable a partir del nombre. */
function hue(nombre: string): number {
  let h = 0;
  for (const ch of nombre) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

/** Fondo del chip. */
export function bgTag(nombre: string): string {
  const h = hue(nombre);
  return `light-dark(hsl(${h} 65% 92%), hsl(${h} 42% 24%))`;
}

/** Texto del chip (y fondo cuando el filtro está activo). */
export function fgTag(nombre: string): string {
  const h = hue(nombre);
  return `light-dark(hsl(${h} 45% 32%), hsl(${h} 70% 80%))`;
}
