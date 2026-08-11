/**
 * Formas que se dibujan encima de una imagen (anotaciones al estilo WhatsApp).
 *
 * Aquí solo vive la geometría: crear, mover, medir y pintar. La interacción
 * (ratón, herramientas, colores) está en `anotar-imagen.ts`, y así esta parte
 * —que es la delicada— se puede probar sin montar la UI.
 *
 * TODAS las coordenadas están en píxeles de la imagen ORIGINAL, nunca en
 * píxeles de pantalla. Es lo que hace que lo que se ve mientras se dibuja (un
 * SVG con `viewBox` del tamaño de la imagen) y lo que se exporta (un canvas del
 * tamaño de la imagen) coincidan exactamente, sin factores de escala por medio.
 *
 * Las formas son SIEMPRE huecas: solo trazo, sin relleno (el texto es la
 * excepción evidente).
 */

export type TipoForma = 'rect' | 'circulo' | 'linea' | 'flecha' | 'texto';

/**
 * Una anotación. Se guardan los dos extremos del gesto del ratón tal cual (sin
 * normalizar): `rect` y `circulo` los usan como esquinas opuestas de su caja, y
 * `linea`/`flecha` como principio y fin — para la flecha el orden importa,
 * porque la punta va en (x2, y2).
 *
 * El texto guarda en (x1,y1) su esquina superior izquierda y en (x2,y2) la
 * inferior derecha, ya medidas: así se mueve y se acierta con el ratón igual
 * que las demás, sin casos especiales.
 */
export interface Forma {
  tipo: TipoForma;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  /** Grosor del trazo; en el texto, el del borde que lo despega del fondo. */
  grosor: number;
  /** Solo texto. */
  texto?: string;
  /** Solo texto: cuerpo de letra, en píxeles de imagen. */
  tam?: number;
  /** Solo texto: se pinta sobre una pastilla del color elegido. */
  fondo?: boolean;
}

export interface Punto {
  x: number;
  y: number;
}

export interface Caja {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Lado mínimo (en px de imagen) para dar una forma por buena al soltar. */
const MINIMO = 8;

/** Grosor del trazo en proporción al lado corto de la imagen. */
const PROPORCION_GROSOR = 180;

/** Cuerpo de letra en proporción al lado corto de la imagen. */
const PROPORCION_TEXTO = 18;

/** Lado mínimo (px de imagen) de un recorte, para que un clic no lo dispare. */
const RECORTE_MINIMO = 24;

/* La familia se repite en el CSS del SVG (`.lienzo text`): la vista previa la
   pinta el navegador y la exportación el canvas, y solo coinciden si ambos usan
   exactamente la misma fuente. */
const FAMILIA = 'Roboto, "Helvetica Neue", Arial, sans-serif';

export function fuenteDe(tam: number): string {
  return `bold ${tam}px ${FAMILIA}`;
}

/** Cuerpo de letra adecuado para una imagen de este tamaño. */
export function tamTextoPara(ancho: number, alto: number): number {
  return Math.max(12, Math.round(Math.min(ancho, alto) / PROPORCION_TEXTO));
}

/** Canvas de usar y tirar, solo para medir texto. */
let medidor: CanvasRenderingContext2D | null = null;

/**
 * Mide una línea de texto. El `ascenso` es lo que hay del borde superior a la
 * línea base: el texto se ancla por arriba, pero tanto el SVG como el canvas
 * dibujan desde la línea base, así que hay que sumarlo.
 */
export function medirTexto(texto: string, tam: number): { ancho: number; ascenso: number; alto: number } {
  medidor ??= document.createElement('canvas').getContext('2d');
  if (!medidor) return { ancho: texto.length * tam * 0.6, ascenso: tam * 0.8, alto: tam * 1.2 };
  medidor.font = fuenteDe(tam);
  const m = medidor.measureText(texto || ' ');
  const ascenso = m.fontBoundingBoxAscent || tam * 0.8;
  const descenso = m.fontBoundingBoxDescent || tam * 0.25;
  return { ancho: m.width, ascenso, alto: ascenso + descenso };
}

/**
 * Color de la pastilla del texto. Es SIEMPRE blanco, no el color elegido: la
 * paleta de colores es la del texto y solo la del texto. Cuando pintaba también
 * la pastilla, se volvía confuso qué se estaba cambiando.
 */
export const COLOR_FONDO = '#ffffff';

/** Aire entre el texto y el borde de su pastilla. */
export function almohadilla(tam: number): Punto {
  return { x: tam * 0.3, y: tam * 0.06 };
}

/** Pastilla de fondo del texto: su caja, ensanchada por la almohadilla. */
export function cajaFondo(f: Forma): Caja {
  const c = caja(f);
  const p = almohadilla(f.tam ?? 24);
  return { x: c.x - p.x, y: c.y - p.y, w: c.w + p.x * 2, h: c.h + p.y * 2 };
}

/** Crea un texto ya medido, anclado por su esquina superior izquierda. */
export function crearTexto(
  en: Punto,
  texto: string,
  tam: number,
  color: string,
  fondo = false,
): Forma {
  const m = medirTexto(texto, tam);
  return {
    tipo: 'texto',
    x1: en.x,
    y1: en.y,
    x2: en.x + m.ancho,
    y2: en.y + m.alto,
    color,
    grosor: 1,
    texto,
    tam,
    fondo,
  };
}

/** Cambia el cuerpo de letra (o el texto) manteniendo el centro donde estaba. */
export function rehacerTexto(f: Forma, cambios: Partial<Forma>): Forma {
  const c = caja(f);
  const centro = { x: c.x + c.w / 2, y: c.y + c.h / 2 };
  const nuevo = { ...f, ...cambios };
  const m = medirTexto(nuevo.texto ?? '', nuevo.tam ?? 24);
  return {
    ...nuevo,
    x1: centro.x - m.ancho / 2,
    y1: centro.y - m.alto / 2,
    x2: centro.x + m.ancho / 2,
    y2: centro.y + m.alto / 2,
  };
}

export function crearForma(
  tipo: TipoForma,
  desde: Punto,
  hasta: Punto,
  color: string,
  grosor: number,
): Forma {
  return { tipo, x1: desde.x, y1: desde.y, x2: hasta.x, y2: hasta.y, color, grosor };
}

/** Grosor de trazo adecuado para una imagen de este tamaño. */
export function grosorPara(ancho: number, alto: number): number {
  return Math.max(2, Math.round(Math.min(ancho, alto) / PROPORCION_GROSOR));
}

/** Copia la forma desplazada. */
export function mover(f: Forma, dx: number, dy: number): Forma {
  return { ...f, x1: f.x1 + dx, y1: f.y1 + dy, x2: f.x2 + dx, y2: f.y2 + dy };
}

/* ---------- Encaje: de la imagen original a la que se está editando ----------
 *
 * Recortar y girar rehacen la imagen, así que hay que llevar la cuenta de cómo
 * se llega de una a otra para poder DESHACERLO ("Restablecer"). Como las únicas
 * operaciones son giros de 90° y desplazamientos, basta con guardar cuántos
 * cuartos de vuelta (`k`) y cuánto se ha corrido (`tx`,`ty`):
 *
 *     punto_actual = girar(k, punto_original) + (tx, ty)
 *
 * Es exacto: los giros de 90° solo permutan y cambian de signo coordenadas, sin
 * decimales ni interpolación de por medio.
 */

export interface Encaje {
  /** Cuartos de vuelta en sentido horario (0..3). */
  k: number;
  tx: number;
  ty: number;
}

export const ENCAJE_ID: Encaje = { k: 0, tx: 0, ty: 0 };

/** Normaliza cuartos de vuelta a 0..3 (acepta negativos). */
function cuartos(k: number): number {
  return ((k % 4) + 4) % 4;
}

/** Gira un punto alrededor del origen. Ojo: la Y crece hacia ABAJO, así que el
 *  sentido horario en pantalla es (x,y) → (-y,x). */
function girarPunto(k: number, p: Punto): Punto {
  switch (cuartos(k)) {
    case 1:
      return { x: -p.y, y: p.x };
    case 2:
      return { x: -p.x, y: -p.y };
    case 3:
      return { x: p.y, y: -p.x };
    default:
      return { x: p.x, y: p.y };
  }
}

export function aplicarEncaje(e: Encaje, p: Punto): Punto {
  const g = girarPunto(e.k, p);
  return { x: g.x + e.tx, y: g.y + e.ty };
}

/** Encadena una operación nueva (girar `j` cuartos y luego desplazar `b`). */
export function componer(e: Encaje, j: number, b: Punto): Encaje {
  const t = girarPunto(j, { x: e.tx, y: e.ty });
  return { k: cuartos(e.k + j), tx: t.x + b.x, ty: t.y + b.y };
}

/** El camino de vuelta: de coordenadas actuales a las de la imagen original. */
export function invertir(e: Encaje): Encaje {
  const t = girarPunto(-e.k, { x: -e.tx, y: -e.ty });
  return { k: cuartos(-e.k), tx: t.x, ty: t.y };
}

/**
 * Lleva una forma a otro sistema de coordenadas.
 *
 * El texto es el caso especial: se transforma su CENTRO y se rehace la caja a
 * su alrededor, porque siempre se pinta derecho (si se girase con la imagen
 * quedaría tumbado) y al girar se intercambian su ancho y su alto.
 */
export function transformar(f: Forma, e: Encaje): Forma {
  if (f.tipo === 'texto') {
    const c = caja(f);
    const centro = aplicarEncaje(e, { x: c.x + c.w / 2, y: c.y + c.h / 2 });
    const m = medirTexto(f.texto ?? '', f.tam ?? 24);
    return {
      ...f,
      x1: centro.x - m.ancho / 2,
      y1: centro.y - m.alto / 2,
      x2: centro.x + m.ancho / 2,
      y2: centro.y + m.alto / 2,
    };
  }
  const a = aplicarEncaje(e, { x: f.x1, y: f.y1 });
  const b = aplicarEncaje(e, { x: f.x2, y: f.y2 });
  return { ...f, x1: a.x, y1: a.y, x2: b.x, y2: b.y };
}

/** Encaje de un giro de 90° sobre una imagen de `ancho`×`alto`. */
export function encajeDeGiro(sentido: 1 | -1, ancho: number, alto: number): Encaje {
  // A la derecha: (x,y) → (alto - y, x). A la izquierda: (x,y) → (y, ancho - x).
  return sentido === 1 ? { k: 1, tx: alto, ty: 0 } : { k: 3, tx: 0, ty: ancho };
}

/** Caja que envuelve a la forma, ya normalizada (w/h nunca negativos). */
export function caja(f: Forma): Caja {
  return {
    x: Math.min(f.x1, f.x2),
    y: Math.min(f.y1, f.y2),
    w: Math.abs(f.x2 - f.x1),
    h: Math.abs(f.y2 - f.y1),
  };
}

/** ¿El gesto fue tan corto que no merece convertirse en forma? */
export function esMinima(f: Forma): boolean {
  if (f.tipo === 'texto') return !f.texto?.trim();
  const { w, h } = caja(f);
  // Rectángulo y círculo necesitan las dos dimensiones; una línea, solo largo.
  return f.tipo === 'rect' || f.tipo === 'circulo'
    ? w < MINIMO || h < MINIMO
    : Math.hypot(w, h) < MINIMO;
}

/** ¿El rectángulo arrastrado da para recortar? (un clic suelto, no). */
export function recorteValido(c: Caja): boolean {
  return c.w >= RECORTE_MINIMO && c.h >= RECORTE_MINIMO;
}

/** Radio de las esquinas del rectángulo: proporcional, con tope para que un
 *  rectángulo grande no acabe pareciendo un óvalo. */
export function radioEsquina(f: Forma): number {
  const { w, h } = caja(f);
  return Math.min(Math.min(w, h) * 0.12, f.grosor * 6);
}

/**
 * Los dos "barbos" de la punta de flecha, en orden de dibujo:
 * barbo → punta → barbo (una polilínea abierta).
 */
export function puntosCabeza(f: Forma): Punto[] {
  const angulo = Math.atan2(f.y2 - f.y1, f.x2 - f.x1);
  const largo = Math.max(f.grosor * 3.6, 12);
  const apertura = Math.PI / 7;
  return [
    {
      x: f.x2 - largo * Math.cos(angulo - apertura),
      y: f.y2 - largo * Math.sin(angulo - apertura),
    },
    { x: f.x2, y: f.y2 },
    {
      x: f.x2 - largo * Math.cos(angulo + apertura),
      y: f.y2 - largo * Math.sin(angulo + apertura),
    },
  ];
}

/** Distancia de un punto al segmento (x1,y1)-(x2,y2). */
function distanciaASegmento(f: Forma, p: Punto): number {
  const dx = f.x2 - f.x1;
  const dy = f.y2 - f.y1;
  const largo2 = dx * dx + dy * dy;
  if (largo2 === 0) return Math.hypot(p.x - f.x1, p.y - f.y1);
  // Proyección del punto sobre la recta, recortada al tramo [0,1].
  const t = Math.max(0, Math.min(1, ((p.x - f.x1) * dx + (p.y - f.y1) * dy) / largo2));
  return Math.hypot(p.x - (f.x1 + t * dx), p.y - (f.y1 + t * dy));
}

/** Distancia de un punto al perímetro del rectángulo. */
function distanciaAlPerimetro(c: Caja, p: Punto): number {
  const fueraX = Math.max(c.x - p.x, 0, p.x - (c.x + c.w));
  const fueraY = Math.max(c.y - p.y, 0, p.y - (c.y + c.h));
  const fuera = Math.hypot(fueraX, fueraY);
  if (fuera > 0) return fuera;
  // Dentro: lo que falta para salir por el lado más cercano.
  return Math.min(p.x - c.x, c.x + c.w - p.x, p.y - c.y, c.y + c.h - p.y);
}

/** Distancia de un punto al contorno de la elipse (aproximada). */
function distanciaAElipse(c: Caja, p: Punto): number {
  const rx = c.w / 2;
  const ry = c.h / 2;
  if (rx === 0 || ry === 0) return distanciaAlPerimetro(c, p);
  const nx = (p.x - (c.x + rx)) / rx;
  const ny = (p.y - (c.y + ry)) / ry;
  // Radio normalizado: 1 = justo encima del contorno.
  return Math.abs(Math.hypot(nx, ny) - 1) * Math.min(rx, ry);
}

/**
 * ¿El punto cae sobre el TRAZO de la forma (con margen `tolerancia`)?
 *
 * Se pregunta por el trazo y no por el interior a propósito: las formas son
 * huecas, así que el hueco de un rectángulo sigue siendo zona libre para
 * dibujar otra forma dentro.
 */
export function tocaTrazo(f: Forma, p: Punto, tolerancia: number): boolean {
  const margen = Math.max(tolerancia, f.grosor);
  switch (f.tipo) {
    // El texto sí es macizo: se agarra desde cualquier punto de su caja.
    case 'texto': {
      const c = caja(f);
      return (
        p.x >= c.x - margen &&
        p.x <= c.x + c.w + margen &&
        p.y >= c.y - margen &&
        p.y <= c.y + c.h + margen
      );
    }
    case 'rect':
      return distanciaAlPerimetro(caja(f), p) <= margen;
    case 'circulo':
      return distanciaAElipse(caja(f), p) <= margen;
    default:
      return distanciaASegmento(f, p) <= margen;
  }
}

/** Índice de la forma que hay bajo el punto, la de más arriba primero. */
export function formaEn(formas: readonly Forma[], p: Punto, tolerancia: number): number {
  for (let i = formas.length - 1; i >= 0; i--) {
    if (tocaTrazo(formas[i], p, tolerancia)) return i;
  }
  return -1;
}

/** `ctx.roundRect` no existe en motores viejos; el respaldo son cuatro arcos. */
function rectRedondeado(ctx: CanvasRenderingContext2D, c: Caja, r: number): void {
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(c.x, c.y, c.w, c.h, r);
    return;
  }
  ctx.moveTo(c.x + r, c.y);
  ctx.arcTo(c.x + c.w, c.y, c.x + c.w, c.y + c.h, r);
  ctx.arcTo(c.x + c.w, c.y + c.h, c.x, c.y + c.h, r);
  ctx.arcTo(c.x, c.y + c.h, c.x, c.y, r);
  ctx.arcTo(c.x, c.y, c.x + c.w, c.y, r);
  ctx.closePath();
}

/**
 * Pinta la forma en un canvas. Es el gemelo del SVG de la vista previa: mismas
 * coordenadas y mismo grosor, para que lo exportado sea lo que se vio.
 */
export function dibujar(ctx: CanvasRenderingContext2D, f: Forma): void {
  const c = caja(f);
  ctx.save();

  if (f.tipo === 'texto') {
    const tam = f.tam ?? 24;
    const texto = f.texto ?? '';
    if (f.fondo) {
      const p = cajaFondo(f);
      ctx.beginPath();
      rectRedondeado(ctx, p, tam * 0.28);
      ctx.fillStyle = COLOR_FONDO;
      ctx.fill();
    }
    ctx.font = fuenteDe(tam);
    ctx.textBaseline = 'alphabetic'; // la única línea base que el SVG y el
    ctx.textAlign = 'left'; //          canvas interpretan igual
    ctx.fillStyle = f.color; // la pastilla no cambia el color de la letra
    ctx.fillText(texto, c.x, c.y + medirTexto(texto, tam).ascenso);
    ctx.restore();
    return;
  }

  ctx.strokeStyle = f.color;
  ctx.lineWidth = f.grosor;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Nunca se llama a fill(): las formas son solo trazo.
  ctx.beginPath();
  switch (f.tipo) {
    case 'rect':
      rectRedondeado(ctx, c, radioEsquina(f));
      break;
    case 'circulo':
      ctx.ellipse(c.x + c.w / 2, c.y + c.h / 2, c.w / 2, c.h / 2, 0, 0, Math.PI * 2);
      break;
    case 'linea':
    case 'flecha':
      ctx.moveTo(f.x1, f.y1);
      ctx.lineTo(f.x2, f.y2);
      break;
  }
  ctx.stroke();

  if (f.tipo === 'flecha') {
    const [a, punta, b] = puntosCabeza(f);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(punta.x, punta.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.restore();
}
