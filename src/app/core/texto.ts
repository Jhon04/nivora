/**
 * Normaliza para buscar: sin acentos, sin mayúsculas y sin espacios sobrantes.
 *
 * Lo usan los buscadores de la interfaz (emojis, índice de la nota), donde nadie
 * espera tener que escribir «introducción» con tilde para encontrarla. La
 * búsqueda de notas es otra cosa: la hace SQLite con FTS5 (`remove_diacritics 2`
 * en el esquema), en Rust.
 */
export function normalizar(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // quita diacríticos (acentos)
    .toLowerCase()
    .trim();
}
