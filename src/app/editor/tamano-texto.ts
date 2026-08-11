/**
 * Tamaños de letra que ofrece la barra de herramientas.
 *
 * El tamaño se guarda como estilo en línea del texto (`fontSize` de
 * `textStyle`, la extensión de Tiptap), así que viaja dentro de la nota y el
 * HTML que sale al copiar a otra aplicación lo lleva puesto.
 */

/**
 * **PUNTOS, no píxeles.** Es la unidad de los procesadores de texto —Word,
 * Google Docs— y por eso su «12» se lee cómodo mientras que 12 px se ve
 * diminuto: un punto es 1/72 de pulgada y un píxel CSS 1/96, así que
 * `1pt = 1.333px` y el 12 de Google Docs son 16 px.
 *
 * Se usa `pt` de verdad en el CSS en vez de convertir a px al escribir: el
 * número que enseña la barra y el que va en la nota son entonces el mismo, sin
 * cuentas que revisar. El navegador hace la conversión al pintar.
 */
export const UNIDAD = 'pt';

/** La escala del desplegable. Ordenada de menor a mayor: `escalon` cuenta con ello. */
export const TAMANOS = [8, 10, 12, 14, 18, 20, 24, 30, 36] as const;

/**
 * Tamaño del texto que no lleva ninguno puesto. 12 pt = 16 px, que es
 * exactamente lo que medía el texto de las notas antes de que esto existiera.
 *
 * Tiene que coincidir con el `font-size` de `.ProseMirror` en styles.scss: es
 * el mismo número contado dos veces —una para pintar, otra para que el
 * indicador de la barra sepa qué enseñar cuando no hay marca— y si se separan,
 * la barra dice un número y la nota enseña otro.
 */
export const TAMANO_BASE = 12;

export const TAMANO_MINIMO = TAMANOS[0];
export const TAMANO_MAXIMO = TAMANOS[TAMANOS.length - 1];

/**
 * El siguiente tamaño de la escala hacia arriba (`+1`) o hacia abajo (`-1`).
 *
 * Los botones `-` y `+` recorren la MISMA lista que el desplegable en vez de
 * sumar y restar de uno en uno: así los dos controles hablan del mismo juego de
 * tamaños, y subir de 12 a 36 son cinco clics en vez de veinticuatro.
 *
 * Se busca por comparación y no por índice para que un tamaño que no esté en la
 * lista —pegado desde otra aplicación— caiga en el escalón contiguo en vez de
 * quedarse atascado. En los extremos se queda quieto.
 */
export function escalon(actual: number, direccion: 1 | -1): number {
  if (direccion === 1) return TAMANOS.find((t) => t > actual) ?? TAMANO_MAXIMO;
  return [...TAMANOS].reverse().find((t) => t < actual) ?? TAMANO_MINIMO;
}
