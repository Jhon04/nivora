/**
 * Catálogo de formas del esquema.
 *
 * Una entrada por forma, y de ahí sale todo: la silueta, cómo se acierta con el
 * ratón, cuánto ocupa y dónde va su etiqueta. Antes cada forma se repartía entre
 * `dentro`, `silueta` y `tamanoPara`, y añadir una obligaba a tocar los tres
 * ficheros sin que nada avisara si te dejabas uno. El menú de formas también se
 * pinta leyendo esto, así que una forma nueva aparece sola en su familia.
 *
 * No importa nada de `modelo.ts` a propósito: recibe una caja suelta y devuelve
 * `path`, así que no hay ciclo entre los dos y el catálogo se prueba solo.
 */

/** Caja de una forma: centro y medidas. */
export interface CajaForma {
  x: number;
  y: number;
  ancho: number;
  alto: number;
}

export const FAMILIAS = [
  { id: 'flujo', nombre: 'Diagrama de flujo' },
  { id: 'uml', nombre: 'UML' },
  { id: 'bpmn', nombre: 'BPMN' },
  { id: 'erd', nombre: 'Entidad-relación' },
] as const;

export type Familia = (typeof FAMILIAS)[number]['id'];

/**
 * Cuerpo con el que se acierta con el ratón y al que se apoyan las flechas.
 * Son cuatro y no uno por forma: para apuntar y para anclar, un cilindro se
 * comporta como una caja y un hexágono como un rombo, y multiplicar los casos
 * solo daría más sitios donde equivocarse.
 */
export type Cuerpo = 'caja' | 'rombo' | 'pastilla' | 'elipse';

/** Dónde se escribe la etiqueta del nodo. */
export type Etiqueta = 'centro' | 'debajo' | 'cabecera';

export interface DefinicionForma {
  id: string;
  familia: Familia;
  nombre: string;
  cuerpo: Cuerpo;
  /** Cuánto texto cabe: multiplicador sobre la caja del texto. */
  holgura: { x: number; y: number };
  /** Suelo de tamaño propio (un evento BPMN es un disco fijo). */
  minimo?: { ancho: number; alto: number };
  /** Tamaño fijo: no crece con el texto (la etiqueta va fuera). */
  fijo?: boolean;
  /** Los extremos redondos se comen su propia altura de ancho. */
  capsula?: boolean;
  etiqueta?: Etiqueta;
  /** Alto de la banda del título, para las de `etiqueta: 'cabecera'`. */
  cabecera?: number;
  /** La forma lista columnas debajo del título (una tabla de base de datos). */
  columnas?: boolean;
  /** Texto con el que nace. Por defecto, el nombre de la forma. */
  ejemplo?: string;
  /** Silueta, como atributo `d` de un `<path>`. */
  contorno(c: CajaForma): string;
  /** Trazos de dentro (divisiones, aspas, la tapa del cilindro). */
  adornos?(c: CajaForma): string[];
  /** Zonas con relleno tenue bajo el texto (la banda del nombre de una tabla). */
  bandas?(c: CajaForma): string[];
  /**
   * Silueta para el botón del menú, si la de verdad no se reconoce en pequeño.
   * La cabecera de una tabla mide 30 unidades fijas: en una miniatura de 22 de
   * alto se saldría por abajo y la tabla acabaría idéntica a una entidad.
   */
  mini?(c: CajaForma): string;
}

/**
 * Geometría de una tabla, en unidades del esquema.
 *
 * Son medidas fijas y no proporciones: una tabla crece hacia abajo una fila por
 * columna, igual que en cualquier herramienta de esquemas de base de datos. Si
 * el alto de fila fuera un porcentaje, dos tablas con distinto número de
 * columnas escribirían con distinta letra y no se podrían leer en paralelo.
 *
 * Las usan `tamanoPara` para medir y `dibujo.ts` para pintar. Tienen que salir
 * de aquí las dos veces: con dos juegos de números, el texto se saldría de la
 * caja en cuanto uno se quedara atrás.
 */
export const TABLA = {
  /** Alto de la banda del nombre. */
  cabecera: 30,
  /** Alto de cada fila. */
  fila: 20,
  /** Aire a izquierda y derecha. */
  sangria: 10,
  /** Ancho de la casilla de una llave (la de PK y la de FK). */
  casilla: 12,
  /** Respiro entre la última casilla de llave y el nombre de la columna. */
  respiro: 5,
  /** Aire mínimo entre el nombre de una columna y su tipo. */
  hueco: 14,
  /** Aire por debajo de la última fila. */
  pie: 6,
} as const;

// --- ayudas de trazado ---------------------------------------------------

const bordes = (c: CajaForma) => ({
  i: c.x - c.ancho / 2,
  d: c.x + c.ancho / 2,
  a: c.y - c.alto / 2,
  b: c.y + c.alto / 2,
});

function poligono(puntos: [number, number][]): string {
  return puntos.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join(' ') + ' Z';
}

function rectangulo(c: CajaForma, r = 0): string {
  const { i, d, a, b } = bordes(c);
  if (!r) return poligono([[i, a], [d, a], [d, b], [i, b]]);
  const radio = Math.min(r, c.ancho / 2, c.alto / 2);
  return (
    `M${i + radio} ${a} H${d - radio} A${radio} ${radio} 0 0 1 ${d} ${a + radio} ` +
    `V${b - radio} A${radio} ${radio} 0 0 1 ${d - radio} ${b} H${i + radio} ` +
    `A${radio} ${radio} 0 0 1 ${i} ${b - radio} V${a + radio} ` +
    `A${radio} ${radio} 0 0 1 ${i + radio} ${a} Z`
  );
}

function elipse(c: CajaForma): string {
  const rx = c.ancho / 2;
  const ry = c.alto / 2;
  return (
    `M${c.x - rx} ${c.y} A${rx} ${ry} 0 0 1 ${c.x + rx} ${c.y} ` +
    `A${rx} ${ry} 0 0 1 ${c.x - rx} ${c.y} Z`
  );
}

/** Banda pegada al borde de arriba, con las esquinas de arriba redondeadas. */
function bandaSuperior(c: CajaForma, alto: number, r: number): string {
  const { i, d, a } = bordes(c);
  const radio = Math.min(r, c.ancho / 2, alto);
  return (
    `M${i} ${a + alto} V${a + radio} A${radio} ${radio} 0 0 1 ${i + radio} ${a} ` +
    `H${d - radio} A${radio} ${radio} 0 0 1 ${d} ${a + radio} V${a + alto} Z`
  );
}

function rombo(c: CajaForma): string {
  const { i, d, a, b } = bordes(c);
  return poligono([[c.x, a], [d, c.y], [c.x, b], [i, c.y]]);
}

// --- las formas ----------------------------------------------------------

const FLUJO: DefinicionForma[] = [
  {
    id: 'terminal',
    familia: 'flujo',
    nombre: 'Inicio / fin',
    cuerpo: 'pastilla',
    holgura: { x: 1, y: 1 },
    capsula: true,
    ejemplo: 'Inicio',
    contorno: (c) => rectangulo(c, c.alto / 2),
  },
  {
    id: 'proceso',
    familia: 'flujo',
    nombre: 'Paso',
    cuerpo: 'caja',
    holgura: { x: 1, y: 1 },
    contorno: (c) => rectangulo(c, 6),
  },
  {
    id: 'decision',
    familia: 'flujo',
    nombre: 'Decisión',
    cuerpo: 'rombo',
    // El doble no es margen de sobra: un rectángulo centrado solo cabe en un
    // rombo si `tw/W + th/H <= 1`, y el ajuste más pequeño es justo el doble.
    holgura: { x: 2, y: 2 },
    ejemplo: '¿Sí o no?',
    contorno: rombo,
  },
  {
    id: 'datos',
    familia: 'flujo',
    nombre: 'Datos',
    cuerpo: 'caja',
    holgura: { x: 1.25, y: 1 },
    contorno: (c) => {
      const { i, d, a, b } = bordes(c);
      const sesgo = Math.min(c.alto * 0.4, c.ancho / 4);
      return poligono([[i + sesgo, a], [d, a], [d - sesgo, b], [i, b]]);
    },
  },
  {
    id: 'documento',
    familia: 'flujo',
    nombre: 'Documento',
    cuerpo: 'caja',
    holgura: { x: 1, y: 1.15 },
    contorno: (c) => {
      const { i, d, a, b } = bordes(c);
      const ola = c.alto * 0.16;
      // El borde de abajo ondula: es lo que distingue un documento de un paso.
      return (
        `M${i} ${a} H${d} V${b - ola} ` +
        `Q${c.x + c.ancho / 4} ${b + ola} ${c.x} ${b - ola / 2} ` +
        `T${i} ${b - ola} Z`
      );
    },
  },
  {
    id: 'almacen',
    familia: 'flujo',
    nombre: 'Base de datos',
    cuerpo: 'caja',
    holgura: { x: 1, y: 1.3 },
    contorno: (c) => {
      const { i, d, a, b } = bordes(c);
      const tapa = Math.min(c.alto * 0.18, 14);
      return (
        `M${i} ${a + tapa} A${c.ancho / 2} ${tapa} 0 0 1 ${d} ${a + tapa} ` +
        `V${b - tapa} A${c.ancho / 2} ${tapa} 0 0 1 ${i} ${b - tapa} Z`
      );
    },
    adornos: (c) => {
      const { i, d, a } = bordes(c);
      const tapa = Math.min(c.alto * 0.18, 14);
      // La tapa de arriba, que da el volumen del cilindro.
      return [`M${i} ${a + tapa} A${c.ancho / 2} ${tapa} 0 0 0 ${d} ${a + tapa}`];
    },
  },
];

const UML: DefinicionForma[] = [
  {
    id: 'uml-clase',
    familia: 'uml',
    nombre: 'Clase',
    cuerpo: 'caja',
    holgura: { x: 1, y: 1 },
    minimo: { ancho: 120, alto: 76 },
    etiqueta: 'cabecera',
    cabecera: 26,
    contorno: (c) => rectangulo(c),
    adornos: (c) => {
      const { i, d, a } = bordes(c);
      // Las dos divisiones de siempre: nombre, atributos, operaciones.
      return [`M${i} ${a + 26} H${d}`, `M${i} ${a + 48} H${d}`];
    },
  },
  {
    id: 'uml-actor',
    familia: 'uml',
    nombre: 'Actor',
    cuerpo: 'caja',
    holgura: { x: 1, y: 1 },
    minimo: { ancho: 34, alto: 56 },
    fijo: true,
    etiqueta: 'debajo',
    contorno: (c) => {
      const { a, b } = bordes(c);
      const cabeza = c.alto * 0.22;
      const hombros = a + cabeza * 2;
      const cadera = a + c.alto * 0.62;
      return (
        `M${c.x} ${a + cabeza} m${-cabeza} 0 a${cabeza} ${cabeza} 0 1 0 ${cabeza * 2} 0 ` +
        `a${cabeza} ${cabeza} 0 1 0 ${-cabeza * 2} 0 ` +
        `M${c.x} ${hombros} V${cadera} ` +
        `M${c.x - c.ancho / 2} ${hombros + 6} H${c.x + c.ancho / 2} ` +
        `M${c.x} ${cadera} L${c.x - c.ancho / 2} ${b} M${c.x} ${cadera} L${c.x + c.ancho / 2} ${b}`
      );
    },
  },
  {
    id: 'uml-caso',
    familia: 'uml',
    nombre: 'Caso de uso',
    cuerpo: 'elipse',
    holgura: { x: 1.45, y: 1.5 },
    contorno: elipse,
  },
  {
    id: 'uml-nota',
    familia: 'uml',
    nombre: 'Nota',
    cuerpo: 'caja',
    holgura: { x: 1, y: 1 },
    contorno: (c) => {
      const { i, d, a, b } = bordes(c);
      const pico = 14;
      return poligono([[i, a], [d - pico, a], [d, a + pico], [d, b], [i, b]]);
    },
    adornos: (c) => {
      const { d, a } = bordes(c);
      const pico = 14;
      // La esquina doblada.
      return [`M${d - pico} ${a} V${a + pico} H${d}`];
    },
  },
];

const BPMN: DefinicionForma[] = [
  {
    id: 'bpmn-inicio',
    familia: 'bpmn',
    nombre: 'Evento de inicio',
    cuerpo: 'elipse',
    holgura: { x: 1, y: 1 },
    minimo: { ancho: 40, alto: 40 },
    fijo: true,
    etiqueta: 'debajo',
    contorno: elipse,
  },
  {
    id: 'bpmn-fin',
    familia: 'bpmn',
    nombre: 'Evento de fin',
    cuerpo: 'elipse',
    holgura: { x: 1, y: 1 },
    minimo: { ancho: 40, alto: 40 },
    fijo: true,
    etiqueta: 'debajo',
    contorno: elipse,
    // El aro de dentro es lo que distingue un fin de un inicio en BPMN.
    adornos: (c) => [elipse({ ...c, ancho: c.ancho - 7, alto: c.alto - 7 })],
  },
  {
    id: 'bpmn-tarea',
    familia: 'bpmn',
    nombre: 'Tarea',
    cuerpo: 'caja',
    holgura: { x: 1, y: 1 },
    minimo: { ancho: 110, alto: 52 },
    contorno: (c) => rectangulo(c, 10),
  },
  {
    id: 'bpmn-compuerta',
    familia: 'bpmn',
    nombre: 'Compuerta',
    cuerpo: 'rombo',
    holgura: { x: 1, y: 1 },
    minimo: { ancho: 52, alto: 52 },
    fijo: true,
    etiqueta: 'debajo',
    contorno: rombo,
    adornos: (c) => {
      const r = Math.min(c.ancho, c.alto) * 0.22;
      // El aspa de la compuerta exclusiva.
      return [
        `M${c.x - r} ${c.y - r} L${c.x + r} ${c.y + r}`,
        `M${c.x + r} ${c.y - r} L${c.x - r} ${c.y + r}`,
      ];
    },
  },
];

const ERD: DefinicionForma[] = [
  {
    id: 'erd-entidad',
    familia: 'erd',
    nombre: 'Entidad',
    cuerpo: 'caja',
    holgura: { x: 1, y: 1 },
    contorno: (c) => rectangulo(c),
  },
  {
    id: 'erd-debil',
    familia: 'erd',
    nombre: 'Entidad débil',
    cuerpo: 'caja',
    holgura: { x: 1, y: 1 },
    contorno: (c) => rectangulo(c),
    adornos: (c) => [rectangulo({ ...c, ancho: c.ancho - 10, alto: c.alto - 10 })],
  },
  {
    /* La tabla de un esquema de base de datos: nombre arriba y una fila por
       columna, como en MySQL Workbench. Es la única forma cuyo contenido no cabe
       en `texto`, así que el nodo lleva además una lista de columnas — ver
       `Columna` en `modelo.ts`. */
    id: 'erd-tabla',
    familia: 'erd',
    nombre: 'Tabla',
    cuerpo: 'caja',
    holgura: { x: 1, y: 1 },
    minimo: { ancho: 150, alto: TABLA.cabecera + TABLA.fila + TABLA.pie },
    etiqueta: 'cabecera',
    cabecera: TABLA.cabecera,
    columnas: true,
    ejemplo: 'tabla',
    contorno: (c) => rectangulo(c, 6),
    bandas: (c) => [bandaSuperior(c, TABLA.cabecera, 6)],
    adornos: (c) => {
      const { i, d, a } = bordes(c);
      return [`M${i} ${a + TABLA.cabecera} H${d}`];
    },
    // En pequeño la cabecera va en proporción: con las 30 unidades de verdad, la
    // división caería fuera de la miniatura y la tabla parecería una entidad.
    mini: (c) => {
      const { i, d, a } = bordes(c);
      return `${rectangulo(c, 2)} M${i} ${a + c.alto * 0.34} H${d}`;
    },
  },
  {
    id: 'erd-atributo',
    familia: 'erd',
    nombre: 'Atributo',
    cuerpo: 'elipse',
    holgura: { x: 1.45, y: 1.5 },
    contorno: elipse,
  },
  {
    id: 'erd-relacion',
    familia: 'erd',
    nombre: 'Relación',
    cuerpo: 'rombo',
    holgura: { x: 2, y: 2 },
    contorno: rombo,
  },
];

export const FORMAS: DefinicionForma[] = [...FLUJO, ...UML, ...BPMN, ...ERD];

const POR_ID = new Map(FORMAS.map((f) => [f.id, f]));

/** La forma por su id; `proceso` si no se reconoce (documento de otra versión). */
export function formaDe(id: string): DefinicionForma {
  return POR_ID.get(id) ?? POR_ID.get('proceso')!;
}

export function hayForma(id: string): boolean {
  return POR_ID.has(id);
}

export function formasDe(familia: Familia): DefinicionForma[] {
  return FORMAS.filter((f) => f.familia === familia);
}
