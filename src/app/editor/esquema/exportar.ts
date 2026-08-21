/**
 * Exportar un esquema a un fichero: SVG o PNG.
 *
 * El diagrama **ya es** un SVG —lo genera `dibujar()`, el mismo que se ve en la
 * nota—, así que exportar es serializar, no volver a pintar. Eso es lo que
 * garantiza que lo exportado y lo que hay en pantalla no se puedan separar: no
 * existe un segundo camino de dibujo que se quede desfasado del primero.
 *
 * Y el PNG sale del SVG, no del modelo: se rasteriza el mismo texto. Por eso el
 * orden importa y hay una sola función que arma el SVG.
 *
 * Dos cosas hay que resolver aquí que en la app no hacen falta:
 *
 * 1. **El SVG no lleva ni un color dentro.** Todo va por `currentColor` y por
 *    tokens de Material que se resuelven en `styles.scss`, que es justo lo que
 *    hace que el esquema cambie de tema sin repintarse. Fuera de la app no hay
 *    quien resuelva eso, así que el aspecto se mete en línea.
 * 2. **La fuente.** El ancho de cada caja está medido con las métricas de
 *    Roboto; abierto donde no la haya, el texto se mide distinto y se sale de su
 *    caja. Se incrusta.
 */

import { dibujar } from './dibujo';
import { Esquema, envolvente } from './modelo';

export type Formato = 'svg' | 'png';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Aire alrededor del dibujo. Más que en la nota: aquí no hay caja que lo sujete. */
const MARGEN = 24;

/**
 * Píxeles del PNG por unidad del esquema. A 1 el texto de 11 unidades sale
 * pastoso en cuanto alguien lo mira en una pantalla normal.
 */
const ESCALA_PNG = 2;

/**
 * Lo que se copia de los estilos calculados a cada elemento.
 *
 * Se copia el valor CALCULADO en vez de escribir a mano una hoja de estilos que
 * imite a `styles.scss`. Una copia a mano se queda desfasada en cuanto alguien
 * añade una clase —como pasó con las llaves de las tablas—, y nadie se entera
 * hasta que exporta. Así lo que sale es literalmente lo que dice el CSS de hoy,
 * incluidos los `color-mix`, que llegan aquí ya resueltos a un color.
 */
const PINTURA = [
  'fill',
  'stroke',
  'stroke-width',
  'stroke-dasharray',
  'stroke-linecap',
  'stroke-linejoin',
  'opacity',
] as const;

/** Lo que solo tiene sentido en un `<text>`. Un rombo no necesita saber la letra. */
const LETRA = ['font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor'] as const;

/** Elementos que pintan algo. A los `<g>` no hace falta copiarles nada. */
const PINTAN = 'path, circle, rect, line, polygon, polyline, ellipse, text';

/**
 * Valores que no hace falta escribir porque ya son los de partida de SVG.
 *
 * No es solo por tamaño: uno de los motivos de exportar en SVG es poder abrirlo
 * en Inkscape y retocarlo, y un fichero donde cada trazo arrastra ocho
 * declaraciones que no dicen nada es bastante peor de leer.
 */
const PREDETERMINADO: Partial<Record<(typeof PINTURA)[number] | (typeof LETRA)[number], string>> = {
  opacity: '1',
  'stroke-linecap': 'butt',
  'stroke-linejoin': 'miter',
  'stroke-dasharray': 'none',
  'font-style': 'normal',
  'text-anchor': 'start',
};

/** Pesos de Roboto que hay servidos en `public/fonts`. */
const PESOS_CON_ARCHIVO = new Set(['300', '400', '500', '700']);

/** Un canal o un alfa como fracción de 0 a 1. Admite `0.5`, `50%` y `none`. */
function cuota(texto: string): number {
  const t = texto.trim();
  if (t === 'none') return 0;
  const n = parseFloat(t);
  if (Number.isNaN(n)) return 1;
  return Math.min(1, Math.max(0, t.endsWith('%') ? n / 100 : n));
}

/**
 * Un color en la sintaxis que entiende todo el mundo, con el alfa aparte.
 *
 * Esto no es cosmética, es un fallo de verdad que se veía así: la banda del
 * título de una tabla sale de un `color-mix`, y el valor CALCULADO de un
 * `color-mix(in srgb, …)` se serializa como `color(srgb 0.1 0.1 0.12 / 0.09)`.
 * Es CSS válido, pero muchos programas de dibujo no lo saben leer — y en SVG un
 * `fill` que no se parsea **no se ignora: cae al valor inicial, que es negro
 * opaco**. La cabecera salía negra con el nombre encima, casi invisible.
 *
 * El alfa se devuelve aparte para mandarlo a `fill-opacity` en vez de dejarlo
 * dentro de un `rgba()`. Un `rgba()` en un `fill` necesita que el visor traiga
 * soporte de color de CSS; `fill-opacity` es SVG 1.1 pelado y lo entiende hasta
 * lo más viejo.
 */
function clasico(valor: string): { color: string; alfa: number } {
  const v = valor.trim();
  if (!v || v === 'none' || v === 'transparent') return { color: 'none', alfa: 1 };

  const moderno = /^color\(\s*srgb\s+(.+)\)$/i.exec(v);
  if (moderno) {
    const [canales, alfa] = moderno[1].split('/');
    const [r, g, b] = canales
      .trim()
      .split(/\s+/)
      .map((c) => Math.round(cuota(c) * 255));
    return { color: `rgb(${r}, ${g}, ${b})`, alfa: alfa === undefined ? 1 : cuota(alfa) };
  }

  const legado = /^rgba?\(([^)]+)\)$/i.exec(v);
  if (legado) {
    const partes = legado[1].split(/[\s,/]+/).filter(Boolean);
    if (partes.length >= 3) {
      return {
        color: `rgb(${partes[0]}, ${partes[1]}, ${partes[2]})`,
        alfa: partes[3] === undefined ? 1 : cuota(partes[3]),
      };
    }
  }

  // Cualquier otra cosa (`oklch`, un `color()` de otro espacio) sale tal cual, y
  // hay un test que lo caza antes de que llegue a un fichero.
  return { color: v, alfa: 1 };
}

/** El alfa con tres decimales: `0.09`, no `0.09000000000000001`. */
function recortar(a: number): string {
  return String(Math.round(a * 1000) / 1000);
}

/** Convierte bytes a base64 sin pasar por `btoa`, que solo admite latin-1. */
function aBase64(bytes: Uint8Array): string {
  let binario = '';
  // A trozos: `String.fromCharCode(...miles)` desborda la pila de argumentos.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binario += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binario);
}

function textoABase64(texto: string): string {
  return aBase64(new TextEncoder().encode(texto));
}

/**
 * Las `@font-face` de los pesos que use este dibujo, con el archivo incrustado.
 *
 * Solo los que aparecen: un diagrama de flujo gasta un peso y una tabla tres, y
 * cada archivo son unos 30 KB ya en base64.
 *
 * Si un archivo no se puede leer se sigue sin él. Quedarse sin exportar por no
 * poder incrustar una fuente sería cambiar un problema de aspecto por uno de no
 * tener el fichero.
 */
async function carasDe(pesos: Iterable<string>): Promise<string> {
  const caras: string[] = [];

  for (const peso of pesos) {
    if (!PESOS_CON_ARCHIVO.has(peso)) continue;
    try {
      const res = await fetch(`/fonts/roboto-${peso}.woff2`);
      if (!res.ok) continue;
      const datos = aBase64(new Uint8Array(await res.arrayBuffer()));
      caras.push(
        `@font-face{font-family:'Roboto';font-style:normal;font-weight:${peso};` +
          `src:url(data:font/woff2;base64,${datos}) format('woff2');}`,
      );
    } catch {
      // Sin fuente incrustada el SVG sigue siendo válido: cae al `sans-serif`
      // del propio `font-family`, solo que con otras métricas.
    }
  }

  return caras.join('');
}

/**
 * Arma el SVG del esquema listo para salir de la app.
 *
 * El aspecto se resuelve dentro de una sonda con `color-scheme: light` aunque la
 * app esté en oscuro: un diagrama con fondo oscuro pegado en un documento blanco
 * queda ilegible, y quien exporta lo hace para meterlo en otro sitio. Es la misma
 * palanca que usa la app para cambiar de tema, así que los colores que salen son
 * los del tema claro de verdad, no una paleta paralela.
 */
export async function svgDeEsquema(e: Esquema): Promise<string> {
  const vista = envolvente(e, MARGEN);
  const svg = dibujar(e, { vista });

  /* Fuera los tiradores: son los trazos gordos e invisibles que hay bajo cada
     flecha para poder acertarle con el ratón. En un fichero solo son peso. */
  for (const t of Array.from(svg.querySelectorAll('.esq-tirador'))) t.remove();

  const sonda = document.createElement('div');
  sonda.style.cssText = 'position:absolute;left:-10000px;top:0;color-scheme:light';
  // El fondo se lee de un `div` y no del SVG: `getPropertyValue` de una variable
  // devuelve el token sin resolver (`light-dark(…)` tal cual), y lo que hace
  // falta es el color ya elegido.
  const medidorFondo = document.createElement('div');
  medidorFondo.style.background = 'var(--mat-sys-surface, #fff)';
  sonda.append(medidorFondo, svg);
  document.body.appendChild(sonda);

  try {
    const fondo = clasico(getComputedStyle(medidorFondo).backgroundColor);
    const pesos = new Set<string>();

    for (const el of Array.from(svg.querySelectorAll<SVGElement>(PINTAN))) {
      const css = getComputedStyle(el);
      const esTexto = el.tagName === 'text';
      const trozos: string[] = [];

      for (const prop of esTexto ? [...PINTURA, ...LETRA] : PINTURA) {
        const v = css.getPropertyValue(prop);
        if (!v || v === PREDETERMINADO[prop]) continue;

        if (prop !== 'fill' && prop !== 'stroke') {
          trozos.push(`${prop}:${v}`);
          continue;
        }

        // `fill: none` y `stroke: none` se escriben aunque parezcan vacíos: el
        // hueco del rombo de clave foránea es precisamente un `fill: none`, y sin
        // ponerlo saldría macizo como la llave.
        const { color, alfa } = clasico(v);
        trozos.push(`${prop}:${color}`);

        // El alfa del color se junta con el `-opacity` que ya tuviera: son dos
        // cosas distintas que se multiplican, y quedarse con una sola cambiaría
        // el resultado.
        const propia = parseFloat(css.getPropertyValue(`${prop}-opacity`));
        const total = (Number.isNaN(propia) ? 1 : propia) * alfa;
        if (total < 1) trozos.push(`${prop}-opacity:${recortar(total)}`);
      }

      el.setAttribute('style', trozos.join(';'));
      if (esTexto) pesos.add(css.fontWeight);
    }

    /* Fondo explícito y no transparente: con los colores en claro el texto es
       oscuro, y sobre el fondo de un Slack en modo noche desaparecería. */
    const rect = document.createElementNS(SVG_NS, 'rect');
    for (const [k, v] of Object.entries({
      x: vista.x, y: vista.y, width: vista.w, height: vista.h, fill: fondo.color,
      ...(fondo.alfa < 1 && { 'fill-opacity': recortar(fondo.alfa) }),
    })) {
      rect.setAttribute(k, String(v));
    }
    svg.prepend(rect);

    const caras = await carasDe(pesos);
    if (caras) {
      const estilo = document.createElementNS(SVG_NS, 'style');
      estilo.textContent = caras;
      svg.prepend(estilo);
    }

    return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(svg)}`;
  } finally {
    sonda.remove();
  }
}

/**
 * Rasteriza el SVG.
 *
 * Va por `<img>` con el SVG en un `data:`, no por el DOM: un `data:` es del
 * mismo origen, así que el lienzo no queda «tainted» y `toBlob` funciona — el
 * mismo motivo por el que `leer_imagen` trae los bytes en vez de usar `asset://`.
 *
 * Un SVG cargado como imagen es un documento aislado: no ve las fuentes de la
 * página, solo las que lleve incrustadas. Por eso la fuente se incrusta también
 * para el PNG, aunque luego se tire.
 */
async function pngDeSvg(svg: string, ancho: number, alto: number): Promise<Blob> {
  const img = new Image();
  img.src = `data:image/svg+xml;base64,${textoABase64(svg)}`;
  await img.decode();

  const lienzo = document.createElement('canvas');
  lienzo.width = Math.max(1, Math.round(ancho * ESCALA_PNG));
  lienzo.height = Math.max(1, Math.round(alto * ESCALA_PNG));
  const ctx = lienzo.getContext('2d');
  if (!ctx) throw new Error('sin contexto 2d para rasterizar el esquema');
  ctx.drawImage(img, 0, 0, lienzo.width, lienzo.height);

  return new Promise<Blob>((resolver, fallar) => {
    lienzo.toBlob(
      (b) => (b ? resolver(b) : fallar(new Error('el lienzo no devolvió un PNG'))),
      'image/png',
    );
  });
}

/** El esquema como fichero. La extensión sale del formato, sin sorpresas. */
export async function exportarEsquema(e: Esquema, formato: Formato): Promise<Blob> {
  const svg = await svgDeEsquema(e);
  if (formato === 'svg') return new Blob([svg], { type: 'image/svg+xml' });

  const vista = envolvente(e, MARGEN);
  return pngDeSvg(svg, vista.w, vista.h);
}
