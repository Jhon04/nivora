/**
 * Convierte un esquema en SVG. Lo usan los dos sitios que lo enseñan: la vista
 * previa dentro de la nota y el editor del diálogo.
 *
 * Ni un color aquí dentro. Todo va por clase CSS y se resuelve en `styles.scss`
 * con `light-dark()`, y eso trae una ventaja que el bloque `/diagrama` no puede
 * tener: Mermaid incrusta los colores dentro del SVG al renderizar, así que hay
 * que volver a generarlo entero al cambiar de tema. Este se adapta solo, porque
 * el color nunca llega a entrar en el documento.
 */

import { medirTexto } from '../anotar-imagen/formas';
import { TABLA, formaDe } from './catalogo';
import { TrazoMarca, conexionDe, marcaDe } from './catalogo-conexiones';
import {
  Caja,
  Conexion,
  DIRECCIONES,
  Direccion,
  Esquema,
  Nodo,
  Punto,
  TAM_TEXTO,
  TAM_TIPO,
  anclaje,
  envolvente,
  envolver,
  huecoLlaves,
  medioDeRuta,
  rutaEntre,
  rutas,
  nodoFantasma,
  nodoPorId,
  vecinoEn,
  puntoDe,
  vectorDe,
} from './modelo';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Largo de la punta de flecha, en unidades del esquema. */
const PUNTA = 11;
/** Media anchura de la punta. */
const PUNTA_ANCHO = 4.5;
/** Radio del punto de enganche en reposo y con el ratón encima. */
const RADIO_PUNTO = 4.5;
const RADIO_ACTIVO = 10;

export interface OpcionesDibujo {
  /** ids de todo lo resaltado: la selección puede ser de varios a la vez. */
  seleccion?: ReadonlySet<string>;
  /** Rectángulo de barrido mientras se arrastra sobre el lienzo vacío. */
  marquesina?: Caja | null;
  /** Flecha en curso mientras se arrastra desde un nodo hacia el ratón. */
  conectando?: { desde: string; hasta: Punto } | null;
  /** id del nodo que enseña sus cuatro puntos de enganche. */
  puntos?: string | null;
  /** Punto con el ratón encima: crece, le sale la flecha y pinta el fantasma. */
  activo?: { nodo: string; dir: Direccion } | null;
  /** Texto del nodo que se previsualiza en el fantasma. */
  textoBrote?: string;
  /**
   * Zona visible. El diálogo pasa una fija: si el `viewBox` se ajustara al
   * contenido, arrastrar un nodo cambiaría el sistema de coordenadas y todo lo
   * demás daría un salto bajo el ratón. La vista previa sí la ajusta.
   */
  vista?: Caja;
}

function el<K extends keyof SVGElementTagNameMap>(
  nombre: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const nodo = document.createElementNS(SVG_NS, nombre);
  for (const [k, v] of Object.entries(attrs)) nodo.setAttribute(k, String(v));
  return nodo;
}

/**
 * La silueta del nodo y sus trazos de dentro, tal y como los declara el
 * catálogo. Un único `<path>` sirve para las veinte formas, así que añadir una
 * no toca este fichero.
 */
function silueta(n: Nodo): SVGGElement {
  const def = formaDe(n.forma);
  const g = el('g', { class: 'esq-silueta' });

  g.appendChild(el('path', { d: def.contorno(n), class: 'esq-forma' }));
  // Las bandas van entre la silueta y los trazos: llevan relleno, así que por
  // encima de un adorno lo taparían.
  for (const d of def.bandas?.(n) ?? []) {
    g.appendChild(el('path', { d, class: 'esq-banda' }));
  }
  for (const d of def.adornos?.(n) ?? []) {
    // Sin relleno: son divisiones y aspas, no siluetas.
    g.appendChild(el('path', { d, class: 'esq-adorno' }));
  }

  return g;
}

/** Dónde se escribe la etiqueta, según lo que pida la forma. */
function anclaTexto(n: Nodo): Punto {
  const def = formaDe(n.forma);
  if (def.etiqueta === 'debajo') return { x: n.x, y: n.y + n.alto / 2 + TAM_TEXTO };
  // Cabecera: el primer compartimento de una clase UML, no el centro de la caja.
  if (def.etiqueta === 'cabecera') return { x: n.x, y: n.y - n.alto / 2 + (def.cabecera ?? 26) / 2 };
  return { x: n.x, y: n.y };
}

/**
 * Texto centrado en un punto.
 *
 * La vertical se calcula con el ascenso en vez de dejarla en manos de
 * `dominant-baseline`. Es la misma cuenta que hace `formas.ts`, y por el mismo
 * motivo por el que el bloque de Mermaid va con `htmlLabels: false`: cuanto
 * menos dependa la colocación del texto de lo que interprete cada motor, menos
 * sorpresas en el WebKit de Tauri.
 */
function textoCentrado(lineas: string[], centro: Punto, clase: string): SVGGElement {
  const g = el('g', { class: clase });
  const alturaLinea = TAM_TEXTO * 1.35;
  const total = lineas.length * alturaLinea;
  const { ascenso } = medirTexto(lineas[0] || ' ', TAM_TEXTO);

  lineas.forEach((linea, i) => {
    const t = el('text', {
      x: centro.x,
      y: centro.y - total / 2 + i * alturaLinea + (alturaLinea - TAM_TEXTO) / 2 + ascenso * 0.82,
      'text-anchor': 'middle',
    });
    t.textContent = linea;
    g.appendChild(t);
  });

  return g;
}

/**
 * Una línea de texto alineada por un lado, centrada en vertical sobre `p.y`.
 *
 * La vertical se saca del ascenso medido, igual que en `textoCentrado` y por el
 * mismo motivo: `dominant-baseline` lo resuelve distinto cada motor, y el WebKit
 * de Tauri no es el que se usa para probar.
 */
function textoAlineado(
  linea: string,
  p: Punto,
  ancla: 'start' | 'end',
  clase: string,
  tam = TAM_TEXTO,
): SVGGElement {
  const g = el('g', { class: clase });
  const { ascenso, alto } = medirTexto(linea, tam);
  const t = el('text', { x: p.x, y: p.y - alto / 2 + ascenso, 'text-anchor': ancla });
  t.textContent = linea;
  g.appendChild(t);
  return g;
}

/**
 * Llave de clave primaria: aro macizo y paletón con dos dientes.
 *
 * Dibujada a mano y no con una letra («PK») porque a este tamaño el rótulo se
 * come el ancho de media columna, y porque el icono se reconoce sin leerlo.
 */
function llave(cx: number, cy: number): SVGElement[] {
  return [
    el('circle', { cx: cx - 2.6, cy, r: 2.3, class: 'esq-llave' }),
    el('path', {
      d: `M${cx - 0.6} ${cy} H${cx + 4.2} M${cx + 1.9} ${cy} V${cy + 2.4} M${cx + 4.2} ${cy} V${cy + 2.9}`,
      class: 'esq-llave-paleton',
    }),
  ];
}

/**
 * Marca de clave foránea: un rombo hueco.
 *
 * A propósito NO es otra llave con el relleno cambiado: a 12 unidades, hueco y
 * macizo se distinguen mirando de cerca, y dos siluetas distintas se distinguen
 * de un vistazo. Además el rombo ya significa «relación» en el resto de la
 * familia de entidad-relación.
 */
function rombito(cx: number, cy: number): SVGElement {
  const r = 3.1;
  return el('path', {
    d: `M${cx} ${cy - r} L${cx + r} ${cy} L${cx} ${cy + r} L${cx - r} ${cy} Z`,
    class: 'esq-foranea',
  });
}

/**
 * Las filas de una tabla: llaves, nombre y tipo.
 *
 * Las casillas de las llaves son columnas fijas de la tabla entera —la de PK
 * primero y la de FK después—, no un hueco por fila. Así los nombres quedan
 * alineados en vertical, que es lo único que hace legible una lista de veinte
 * campos. El ancho de ese margen sale de `huecoLlaves`, la misma función con la
 * que se midió la caja.
 */
function filasTabla(n: Nodo): SVGGElement | null {
  const columnas = n.columnas ?? [];
  if (!formaDe(n.forma).columnas || !columnas.length) return null;

  const izq = n.x - n.ancho / 2;
  const der = n.x + n.ancho / 2;
  const arriba = n.y - n.alto / 2;
  const hueco = huecoLlaves(columnas);
  const hayPk = columnas.some((c) => c.pk);

  const g = el('g', { class: 'esq-columnas' });
  columnas.forEach((c, i) => {
    const cy = arriba + TABLA.cabecera + i * TABLA.fila + TABLA.fila / 2;
    let casilla = izq + TABLA.sangria + TABLA.casilla / 2;

    if (hayPk) {
      if (c.pk) for (const parte of llave(casilla, cy)) g.appendChild(parte);
      casilla += TABLA.casilla;
    }
    if (c.fk) g.appendChild(rombito(casilla, cy));

    const clase = `esq-columna${c.pk ? ' clave' : ''}`;
    g.appendChild(textoAlineado(c.nombre, { x: izq + TABLA.sangria + hueco, y: cy }, 'start', clase));
    if (c.tipo) {
      g.appendChild(textoAlineado(c.tipo, { x: der - TABLA.sangria, y: cy }, 'end', 'esq-tipo', TAM_TIPO));
    }
  });

  return g;
}

/** Punta de flecha en `b`, apuntando en la dirección a→b. */
function punta(a: Punto, b: Punto, op: { escala?: number; clase?: string } = {}): SVGElement {
  const escala = op.escala ?? 1;
  const clase = op.clase ?? 'esq-punta';
  const largo = Math.hypot(b.x - a.x, b.y - a.y);
  if (largo === 0) return el('polygon', { points: '0,0', class: clase });

  const ux = (b.x - a.x) / largo;
  const uy = (b.y - a.y) / largo;
  // Perpendicular, para separar las dos esquinas de la base.
  const px = -uy;
  const py = ux;
  const base = { x: b.x - ux * PUNTA * escala, y: b.y - uy * PUNTA * escala };
  const ancho = PUNTA_ANCHO * escala;

  return el('polygon', {
    points: [
      `${b.x},${b.y}`,
      `${base.x + px * ancho},${base.y + py * ancho}`,
      `${base.x - px * ancho},${base.y - py * ancho}`,
    ].join(' '),
    class: clase,
  });
}

/** Radio con el que se redondean los codos. */
const CODO = 9;

/**
 * La ruta como atributo `d`, con los codos redondeados.
 *
 * El radio se recorta a la mitad del tramo más corto que toca cada vértice: sin
 * eso, dos codos seguidos y juntos se comerían el tramo del medio y la curva
 * saldría al revés.
 */
function rutaComoPath(pts: Punto[], radio = CODO): string {
  if (pts.length < 2) return '';

  const partes = [`M${pts[0].x} ${pts[0].y}`];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const c = pts[i + 1];
    const largoA = Math.hypot(b.x - a.x, b.y - a.y);
    const largoC = Math.hypot(c.x - b.x, c.y - b.y);
    const r = Math.min(radio, largoA / 2, largoC / 2);
    if (r < 0.5) {
      partes.push(`L${b.x} ${b.y}`);
      continue;
    }
    const entra = { x: b.x + ((a.x - b.x) / largoA) * r, y: b.y + ((a.y - b.y) / largoA) * r };
    const sale = { x: b.x + ((c.x - b.x) / largoC) * r, y: b.y + ((c.y - b.y) / largoC) * r };
    partes.push(`L${entra.x} ${entra.y}`, `Q${b.x} ${b.y} ${sale.x} ${sale.y}`);
  }
  const fin = pts[pts.length - 1];
  partes.push(`L${fin.x} ${fin.y}`);
  return partes.join(' ');
}

/** Vector unitario del tramo que llega al punto `i` de la ruta. */
function direccionEn(pts: Punto[], i: number): Punto {
  const a = pts[Math.max(0, i - 1)];
  const b = pts[i];
  const largo = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { x: (b.x - a.x) / largo, y: (b.y - a.y) / largo };
}

/** Un trazo de una marca de extremo. El relleno lo decide el catálogo. */
function pintarMarca(t: TrazoMarca): SVGElement {
  return el('path', { d: t.d, class: `esq-marca relleno-${t.relleno}` });
}

/** Una conexión: línea, marcas y, si la tiene, su etiqueta sobre una pastilla. */
function dibujarConexion(c: Conexion, ruta: Punto[], seleccionada: boolean): SVGGElement | null {
  if (ruta.length < 2) return null;

  const g = el('g', {
    class: `esq-conexion${seleccionada ? ' sel' : ''}`,
    'data-tipo': 'conexion',
    'data-id': c.id,
  });

  const d = rutaComoPath(ruta);

  /* Un trazo invisible y gordo por debajo: acertar con el ratón en una línea de
     1,5 px es imposible con el pulso normal de nadie. */
  g.appendChild(el('path', { d, class: 'esq-tirador' }));

  const def = conexionDe(c.tipo);
  g.appendChild(el('path', { d, class: `esq-linea trazo-${def.trazo}` }));

  /* Las marcas se orientan por SU tramo, no por la recta entre extremos: con
     codos, la flecha tiene que entrar perpendicular al lado del nodo, que es
     justo lo que le da el aspecto de diagrama de tablas. */
  const salida = direccionEn(ruta, 1);
  const llegada = direccionEn(ruta, ruta.length - 1);
  for (const t of marcaDe(def.desde, ruta[0], { x: -salida.x, y: -salida.y })) {
    g.appendChild(pintarMarca(t));
  }
  for (const t of marcaDe(def.hasta, ruta[ruta.length - 1], llegada)) g.appendChild(pintarMarca(t));

  const etiqueta = c.texto.trim();
  if (etiqueta) {
    const centro = medioDeRuta(ruta);
    const { ancho } = medirTexto(etiqueta, TAM_TEXTO);
    // Pastilla opaca detrás: sin ella la línea cruza el texto y no se lee.
    g.appendChild(
      el('rect', {
        x: centro.x - ancho / 2 - 5,
        y: centro.y - TAM_TEXTO * 0.75,
        width: ancho + 10,
        height: TAM_TEXTO * 1.5,
        rx: 3,
        class: 'esq-etiqueta-fondo',
      }),
    );
    g.appendChild(textoCentrado([etiqueta], centro, 'esq-etiqueta'));
  }

  return g;
}

/**
 * Punto de enganche de un lado del nodo.
 *
 * En reposo es un disco pequeño. Con el ratón cerca crece y le sale una flecha
 * dentro apuntando hacia fuera, que es lo que anuncia qué va a pasar al pulsar:
 * un punto a secas no dice si conecta, mueve o redimensiona.
 */
function enganche(n: Nodo, d: Direccion, activo: boolean): SVGGElement {
  const c = puntoDe(n, d);
  const v = vectorDe(d);
  const g = el('g', {
    class: `esq-punto${activo ? ' activo' : ''}`,
    'data-dir': d,
  });

  g.appendChild(
    el('circle', { cx: c.x, cy: c.y, r: activo ? RADIO_ACTIVO : RADIO_PUNTO, class: 'esq-punto-disco' }),
  );

  if (activo) {
    const cola = { x: c.x - v.x * 5.5, y: c.y - v.y * 5.5 };
    const cabeza = { x: c.x + v.x * 5.5, y: c.y + v.y * 5.5 };
    g.appendChild(
      el('line', { x1: cola.x, y1: cola.y, x2: cabeza.x, y2: cabeza.y, class: 'esq-punto-asta' }),
    );
    g.appendChild(punta(cola, cabeza, { escala: 0.45, clase: 'esq-punto-punta' }));
  }

  return g;
}

/**
 * Lo que va a aparecer si se pulsa el punto activo: la flecha y el bloque, en
 * tenue y a rayas. Se dibuja con el mismo `nodoFantasma` que luego crea el nodo
 * de verdad, así que la promesa y el resultado no se pueden separar.
 */
function fantasma(e: Esquema, origen: Nodo, d: Direccion, texto: string): SVGElement[] {
  // La MISMA función que usa `brotar` para decidir. Preguntar aquí por separado
  // sería abrir la puerta a que la vista previa prometa una cosa y el clic haga
  // otra.
  const vecino = vecinoEn(e, origen.id, d);
  const destino = vecino ?? nodoFantasma(origen, d, texto);

  const g = el('g', { class: 'esq-fantasma' });
  // Con la misma ruta que tendrá de verdad: si el fantasma saliera recto y luego
  // apareciera en codos, la vista previa estaría mintiendo.
  // Con los demás nodos como obstáculos, igual que la de verdad: si el fantasma
  // atravesara una caja y luego la ruta la rodeara, la vista previa mentiría.
  const ruta = rutaEntre(origen, destino, e.nodos);
  g.appendChild(el('path', { d: rutaComoPath(ruta), class: 'esq-linea' }));
  const llegada = direccionEn(ruta, ruta.length - 1);
  const fin = ruta[ruta.length - 1];
  g.appendChild(punta({ x: fin.x - llegada.x, y: fin.y - llegada.y }, fin));

  if (!vecino) {
    g.appendChild(silueta(destino));
    g.appendChild(textoCentrado(envolver(destino.texto), anclaTexto(destino), 'esq-texto'));
    const filas = filasTabla(destino);
    if (filas) g.appendChild(filas);
    return [g];
  }

  /* Enlazando con uno que ya existe: se le pone un cerco para que se vea CUÁL.
     Va fuera del grupo del fantasma porque ese está al 45% de opacidad, y la
     marca tiene que leerse sin dudar. */
  const cerco = el('path', { d: formaDe(vecino.forma).contorno(vecino), class: 'esq-destino' });
  return [g, cerco];
}

/** El SVG completo del esquema. */
export function dibujar(e: Esquema, op: OpcionesDibujo = {}): SVGSVGElement {
  const vista = op.vista ?? envolvente(e);
  const svg = el('svg', {
    class: 'esq-svg',
    viewBox: `${vista.x} ${vista.y} ${vista.w} ${vista.h}`,
    /* `width` y `height` explícitos, y no solo el `viewBox`.
       Un SVG con `viewBox` a secas no tiene tamaño intrínseco, y ahí cada motor
       decide distinto: Chrome deduce el ancho del alto por la proporción, pero
       el WebKit de Tauri lo resuelve a **cero**. Con `overflow: hidden` —el
       valor por defecto de un SVG— eso recorta el dibujo entero y el esquema se
       vuelve invisible, aunque los nodos sigan estando y se puedan seleccionar.
       Con las dos medidas puestas, quien manda es el CSS de cada sitio. */
    width: vista.w,
    height: vista.h,
    // Sin esto un esquema apaisado se estiraría al meterlo en una caja alta.
    preserveAspectRatio: 'xMidYMid meet',
  });

  // Las conexiones van primero: por debajo de los nodos, para que la línea se
  // meta bajo la silueta y no se vea asomar por dentro.
  // Todas las rutas de una vez: el reparto de ranuras en cada lado depende de
  // cuántas flechas salen por ahí, así que no se puede resolver una a una.
  const mapa = rutas(e);
  for (const c of e.conexiones) {
    const ruta = mapa.get(c.id);
    const g = ruta && dibujarConexion(c, ruta, !!op.seleccion?.has(c.id));
    if (g) svg.appendChild(g);
  }

  // Flecha en curso: se dibuja aparte porque todavía no existe en el modelo.
  if (op.conectando) {
    const desde = nodoPorId(e, op.conectando.desde);
    if (desde) {
      const a = anclaje(desde, op.conectando.hasta);
      const b = op.conectando.hasta;
      const g = el('g', { class: 'esq-conexion tentativa' });
      g.appendChild(el('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'esq-linea' }));
      g.appendChild(punta(a, b));
      svg.appendChild(g);
    }
  }

  // El fantasma va antes que los nodos: si el hueco estuviera ocupado, lo que
  // manda es lo que ya existe, no la promesa.
  const conPuntos = op.puntos ? nodoPorId(e, op.puntos) : undefined;
  if (conPuntos && op.activo?.nodo === conPuntos.id) {
    for (const parte of fantasma(e, conPuntos, op.activo.dir, op.textoBrote ?? '')) {
      svg.appendChild(parte);
    }
  }

  for (const n of e.nodos) {
    const g = el('g', {
      class: `esq-nodo${op.seleccion?.has(n.id) ? ' sel' : ''}`,
      'data-tipo': 'nodo',
      'data-id': n.id,
    });
    g.appendChild(silueta(n));
    g.appendChild(textoCentrado(envolver(n.texto), anclaTexto(n), 'esq-texto'));
    const filas = filasTabla(n);
    if (filas) g.appendChild(filas);
    svg.appendChild(g);
  }

  // La marquesina, por encima de los nodos y por debajo de los puntos: es un
  // gesto en curso, tiene que verse sobre lo que está barriendo.
  if (op.marquesina) {
    svg.appendChild(
      el('rect', {
        x: op.marquesina.x,
        y: op.marquesina.y,
        width: op.marquesina.w,
        height: op.marquesina.h,
        class: 'esq-marquesina',
      }),
    );
  }

  // Y los puntos los últimos: quedan por encima de todo, también del nodo
  // vecino, para que no haya que buscarlos por debajo de nada.
  if (conPuntos) {
    for (const dir of DIRECCIONES) {
      svg.appendChild(enganche(conPuntos, dir, op.activo?.nodo === conPuntos.id && op.activo.dir === dir));
    }
  }

  return svg;
}
