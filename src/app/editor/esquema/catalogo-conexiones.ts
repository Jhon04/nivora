/**
 * Catálogo de tipos de conexión.
 *
 * Mismo reparto que `catalogo.ts`: una entrada por tipo, y de ahí salen el
 * trazo, las dos puntas y la miniatura del menú. Añadir un tipo es una entrada.
 *
 * La idea que lo ordena todo: **«uno a muchos» no es una propiedad, son dos
 * marcas independientes**, una en cada extremo. Es como funciona de verdad la
 * notación de pata de gallo, y modelarlo así da las combinaciones gratis en vez
 * de una lista cerrada — los tipos con nombre no son más que atajos encima.
 *
 * Aquí solo hay geometría: se devuelven cadenas `d` de `<path>`, nunca
 * elementos. Por eso lo pueden usar igual el lienzo y la vista previa del menú,
 * y se prueba sin montar nada.
 */

import { Familia } from './catalogo';

export interface Punto {
  x: number;
  y: number;
}

/** Cómo se pinta la línea. */
export type Trazo = 'solido' | 'discontinuo' | 'punteado';

/** Qué hay en un extremo. */
export type Marca =
  | 'nada'
  | 'flecha'
  | 'abierta'
  | 'triangulo'
  | 'rombo'
  | 'rombo-relleno'
  | 'circulo'
  | 'uno'
  | 'muchos'
  | 'cero-uno'
  | 'cero-muchos';

/**
 * Un trazo de la marca. `relleno` decide con qué se pinta por dentro:
 * `fondo` es el color del lienzo, que es lo que hace «hueco» a un triángulo de
 * herencia sin que se le vea la línea por debajo.
 */
export interface TrazoMarca {
  d: string;
  relleno: 'ninguno' | 'fondo' | 'tinta';
}

export interface DefinicionConexion {
  id: string;
  familia: Familia;
  nombre: string;
  trazo: Trazo;
  /** Marca del extremo del nodo de origen. */
  desde: Marca;
  /** Marca del extremo del nodo de destino. */
  hasta: Marca;
}

// --- geometría de las marcas ---------------------------------------------

/** Largo de las marcas con cuerpo (flecha, triángulo, rombo). */
const LARGO = 12;
const ANCHO = 5;
/** Radio del circulito de opcionalidad y del de mensaje BPMN. */
const RADIO = 4.5;

function linea(a: Punto, b: Punto): string {
  return `M${a.x} ${a.y} L${b.x} ${b.y}`;
}

function circulo(c: Punto, r: number): string {
  return `M${c.x - r} ${c.y} a${r} ${r} 0 1 0 ${r * 2} 0 a${r} ${r} 0 1 0 ${-r * 2} 0`;
}

/**
 * Los trazos de una marca puesta en `punta`, con la línea llegando en la
 * dirección `u` (unitaria).
 *
 * Todo se dibuja hacia dentro desde la punta, así que el punto de apoyo es
 * siempre el borde del nodo y las marcas no se salen de la línea.
 */
export function marcaDe(tipo: Marca, punta: Punto, u: Punto): TrazoMarca[] {
  // Perpendicular, para separar lo que se abre a los lados.
  const p = { x: -u.y, y: u.x };
  /** Punto a `d` de la punta hacia atrás, desviado `s` de lado. */
  const en = (d: number, s = 0): Punto => ({
    x: punta.x - u.x * d + p.x * s,
    y: punta.y - u.y * d + p.y * s,
  });

  switch (tipo) {
    case 'nada':
      return [];

    case 'flecha':
      return [
        {
          d: `M${punta.x} ${punta.y} L${en(LARGO, ANCHO).x} ${en(LARGO, ANCHO).y} ` +
            `L${en(LARGO, -ANCHO).x} ${en(LARGO, -ANCHO).y} Z`,
          relleno: 'tinta',
        },
      ];

    case 'abierta':
      // Una V, sin cerrar: es la punta «fina» de UML y BPMN.
      return [
        { d: linea(en(LARGO, ANCHO), punta), relleno: 'ninguno' },
        { d: linea(en(LARGO, -ANCHO), punta), relleno: 'ninguno' },
      ];

    case 'triangulo':
      return [
        {
          d: `M${punta.x} ${punta.y} L${en(LARGO + 2, ANCHO + 1).x} ${en(LARGO + 2, ANCHO + 1).y} ` +
            `L${en(LARGO + 2, -ANCHO - 1).x} ${en(LARGO + 2, -ANCHO - 1).y} Z`,
          // Relleno del color del lienzo: así se ve hueco y tapa la línea.
          relleno: 'fondo',
        },
      ];

    case 'rombo':
    case 'rombo-relleno': {
      const largo = LARGO + 5;
      return [
        {
          d: `M${punta.x} ${punta.y} L${en(largo / 2, ANCHO).x} ${en(largo / 2, ANCHO).y} ` +
            `L${en(largo, 0).x} ${en(largo, 0).y} ` +
            `L${en(largo / 2, -ANCHO).x} ${en(largo / 2, -ANCHO).y} Z`,
          relleno: tipo === 'rombo' ? 'fondo' : 'tinta',
        },
      ];
    }

    case 'circulo':
      return [{ d: circulo(en(RADIO), RADIO), relleno: 'fondo' }];

    case 'uno':
      // Una raya cruzada: «exactamente uno».
      return [{ d: linea(en(9, 6), en(9, -6)), relleno: 'ninguno' }];

    case 'muchos':
      return patasDeGallo(en);

    case 'cero-uno':
      return [
        { d: linea(en(9, 6), en(9, -6)), relleno: 'ninguno' },
        // El círculo de «cero» va POR FUERA de la cardinalidad, más lejos del
        // nodo: es el orden de la notación.
        { d: circulo(en(9 + RADIO * 2 + 2), RADIO), relleno: 'fondo' },
      ];

    case 'cero-muchos':
      return [
        ...patasDeGallo(en),
        { d: circulo(en(LARGO + RADIO * 2), RADIO), relleno: 'fondo' },
      ];
  }
}

/** Las tres patas que se abren hacia el nodo. */
function patasDeGallo(en: (d: number, s?: number) => Punto): TrazoMarca[] {
  const apice = en(LARGO);
  return [
    { d: linea(apice, en(0, 6)), relleno: 'ninguno' },
    { d: linea(apice, en(0, -6)), relleno: 'ninguno' },
    { d: linea(apice, en(0)), relleno: 'ninguno' },
  ];
}

// --- los tipos -----------------------------------------------------------

export const CONEXIONES: DefinicionConexion[] = [
  // Flujo
  { id: 'flecha', familia: 'flujo', nombre: 'Flecha', trazo: 'solido', desde: 'nada', hasta: 'flecha' },
  { id: 'linea', familia: 'flujo', nombre: 'Línea', trazo: 'solido', desde: 'nada', hasta: 'nada' },
  { id: 'discontinua', familia: 'flujo', nombre: 'Discontinua', trazo: 'discontinuo', desde: 'nada', hasta: 'flecha' },
  { id: 'doble', familia: 'flujo', nombre: 'Doble sentido', trazo: 'solido', desde: 'flecha', hasta: 'flecha' },

  // UML
  { id: 'uml-asociacion', familia: 'uml', nombre: 'Asociación', trazo: 'solido', desde: 'nada', hasta: 'nada' },
  { id: 'uml-dirigida', familia: 'uml', nombre: 'Dirigida', trazo: 'solido', desde: 'nada', hasta: 'abierta' },
  { id: 'uml-herencia', familia: 'uml', nombre: 'Herencia', trazo: 'solido', desde: 'nada', hasta: 'triangulo' },
  { id: 'uml-implementacion', familia: 'uml', nombre: 'Implementación', trazo: 'discontinuo', desde: 'nada', hasta: 'triangulo' },
  { id: 'uml-dependencia', familia: 'uml', nombre: 'Dependencia', trazo: 'discontinuo', desde: 'nada', hasta: 'abierta' },
  { id: 'uml-agregacion', familia: 'uml', nombre: 'Agregación', trazo: 'solido', desde: 'rombo', hasta: 'nada' },
  { id: 'uml-composicion', familia: 'uml', nombre: 'Composición', trazo: 'solido', desde: 'rombo-relleno', hasta: 'nada' },

  // BPMN
  { id: 'bpmn-secuencia', familia: 'bpmn', nombre: 'Flujo de secuencia', trazo: 'solido', desde: 'nada', hasta: 'flecha' },
  { id: 'bpmn-mensaje', familia: 'bpmn', nombre: 'Flujo de mensaje', trazo: 'discontinuo', desde: 'circulo', hasta: 'abierta' },
  { id: 'bpmn-asociacion', familia: 'bpmn', nombre: 'Asociación', trazo: 'punteado', desde: 'nada', hasta: 'abierta' },

  // Entidad-relación
  { id: 'erd-1-1', familia: 'erd', nombre: 'Uno a uno', trazo: 'solido', desde: 'uno', hasta: 'uno' },
  { id: 'erd-1-n', familia: 'erd', nombre: 'Uno a muchos', trazo: 'solido', desde: 'uno', hasta: 'muchos' },
  { id: 'erd-n-1', familia: 'erd', nombre: 'Muchos a uno', trazo: 'solido', desde: 'muchos', hasta: 'uno' },
  { id: 'erd-n-n', familia: 'erd', nombre: 'Muchos a muchos', trazo: 'solido', desde: 'muchos', hasta: 'muchos' },
  { id: 'erd-0-1', familia: 'erd', nombre: 'Cero o uno', trazo: 'solido', desde: 'uno', hasta: 'cero-uno' },
  { id: 'erd-0-n', familia: 'erd', nombre: 'Cero o muchos', trazo: 'solido', desde: 'uno', hasta: 'cero-muchos' },
];

/** El tipo con el que nace una conexión, y al que caen las de antes. */
export const CONEXION_POR_DEFECTO = 'flecha';

const POR_ID = new Map(CONEXIONES.map((c) => [c.id, c]));

/** El tipo por su id; la flecha simple si no se reconoce. */
export function conexionDe(id: string | undefined): DefinicionConexion {
  return POR_ID.get(id ?? '') ?? POR_ID.get(CONEXION_POR_DEFECTO)!;
}

export function hayConexion(id: string): boolean {
  return POR_ID.has(id);
}

export function conexionesDe(familia: Familia): DefinicionConexion[] {
  return CONEXIONES.filter((c) => c.familia === familia);
}

/** Trazos de una miniatura horizontal, para el menú. */
export function previsualizar(def: DefinicionConexion): { linea: string; marcas: TrazoMarca[] } {
  const a = { x: 6, y: 11 };
  const b = { x: 54, y: 11 };
  return {
    linea: linea(a, b),
    marcas: [
      ...marcaDe(def.desde, a, { x: -1, y: 0 }),
      ...marcaDe(def.hasta, b, { x: 1, y: 0 }),
    ],
  };
}
