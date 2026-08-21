/**
 * Esquema: un grafo de nodos y conexiones que el usuario coloca a mano.
 *
 * Aquí solo vive la geometría y las transformaciones: crear, medir, mover,
 * acertar con el ratón. El dibujo está en `dibujo.ts` y la interacción en
 * `esquema-dialog.ts`, igual que en `anotar-imagen/formas.ts` — así la parte
 * delicada se prueba sin montar la UI.
 *
 * A diferencia del bloque `/diagrama`, aquí **las posiciones son del usuario**.
 * Esa es toda la razón de que este bloque exista aparte: Mermaid calcula la
 * colocación con su propio motor y no tiene sitio donde guardar un x/y, así que
 * arrastrar un nodo allí es imposible por construcción, no por falta de trabajo.
 *
 * Todas las coordenadas están en unidades del esquema, no en píxeles de
 * pantalla: el SVG las escala con su `viewBox` y así la vista previa de la nota
 * y el editor del diálogo enseñan exactamente lo mismo a distinto tamaño.
 */

import { medirTexto } from '../anotar-imagen/formas';
import { TABLA, formaDe, hayForma } from './catalogo';
import { CONEXION_POR_DEFECTO, hayConexion } from './catalogo-conexiones';

/** Id de una forma del catálogo (ver `catalogo.ts`). */
export type FormaNodo = string;

/**
 * Una columna de una tabla.
 *
 * `pk` y `fk` son dos banderas y no un solo campo con tres valores porque una
 * columna puede ser las dos cosas a la vez —es lo normal en una tabla puente— y
 * con un `clave: 'pk' | 'fk'` habría que inventar un tercer valor `'pk-fk'` que
 * luego hay que desarmar en cada sitio que lo mire.
 *
 * Van sin poner cuando son falsas: el fichero de la nota se escribe con
 * `to_string_pretty`, y un `"pk": false` por columna sería ruido en cada diff.
 */
export interface Columna {
  nombre: string;
  /** Tipo de dato, tal cual lo escriba quien dibuja: `int`, `varchar(60)`… */
  tipo?: string;
  /** Clave primaria. */
  pk?: boolean;
  /** Clave foránea. */
  fk?: boolean;
}

/** Un nodo. `x`/`y` son su **centro**, que es lo que simplifica toda la geometría. */
export interface Nodo {
  id: string;
  x: number;
  y: number;
  ancho: number;
  alto: number;
  texto: string;
  forma: FormaNodo;
  /** Solo las formas con `columnas` en el catálogo (hoy, la tabla). */
  columnas?: Columna[];
}

/** Una flecha entre dos nodos. `texto` vacío = flecha sin etiqueta. */
export interface Conexion {
  id: string;
  desde: string;
  hasta: string;
  texto: string;
  /** Id del catálogo de conexiones (ver `catalogo-conexiones.ts`). */
  tipo: string;
}

export interface Esquema {
  nodos: Nodo[];
  conexiones: Conexion[];
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

/** Cuerpo de letra de las etiquetas, en unidades del esquema. */
export const TAM_TEXTO = 13;

/**
 * Cuerpo del tipo de dato de una columna, más pequeño que el nombre porque es
 * información de apoyo. Tiene que ir a la par con `.esq-tipo text` en
 * `styles.scss`: aquí se mide y allí se pinta, y si se separan el texto deja de
 * caber en la caja que se le calculó. Hay un test que lo comprueba en el
 * navegador (`extensiones/esquema.spec.ts`).
 */
export const TAM_TIPO = 11;

/** Ancho al que se parte el texto de un nodo en varias líneas. */
const ANCHO_TEXTO_MAX = 150;

/** Aire entre el texto y el borde del nodo. */
const AIRE_X = 18;
const AIRE_Y = 14;

const ANCHO_MIN = 88;
const ALTO_MIN = 44;

/** Los cuatro lados por los que un nodo puede brotar. En orden de reloj. */
export const DIRECCIONES = ['arriba', 'derecha', 'abajo', 'izquierda'] as const;
export type Direccion = (typeof DIRECCIONES)[number];

/** Hueco entre el borde del nodo y el centro de su punto de enganche. */
export const SEPARACION_PUNTO = 15;

/** Aire que queda entre los bordes de un nodo y el que brota de él. */
const HUECO_BROTE = 56;

export function esquemaVacio(): Esquema {
  return { nodos: [], conexiones: [] };
}

/** Identificador corto. Corto a propósito: sale en cada diff de la sincronización. */
export function nuevoId(): string {
  return Math.random().toString(36).slice(2, 8);
}

/**
 * Parte el texto en líneas que quepan en `ANCHO_TEXTO_MAX`.
 *
 * Parte por palabras; una palabra sola más ancha que el límite se queda entera y
 * ensancha el nodo, que es preferible a cortar una palabra por la mitad.
 */
export function envolver(texto: string): string[] {
  const palabras = texto.split(/\s+/).filter(Boolean);
  if (!palabras.length) return [''];

  const lineas: string[] = [];
  let actual = '';
  for (const palabra of palabras) {
    const tentativa = actual ? `${actual} ${palabra}` : palabra;
    if (actual && medirTexto(tentativa, TAM_TEXTO).ancho > ANCHO_TEXTO_MAX) {
      lineas.push(actual);
      actual = palabra;
    } else {
      actual = tentativa;
    }
  }
  lineas.push(actual);
  return lineas;
}

/** Caja que ocupa el texto ya partido en líneas. */
function cajaTexto(texto: string): { ancho: number; alto: number } {
  const lineas = envolver(texto);
  const ancho = Math.max(...lineas.map((l) => medirTexto(l, TAM_TEXTO).ancho));
  return { ancho, alto: lineas.length * TAM_TEXTO * 1.35 };
}

/**
 * Ancho que se reserva a la izquierda de los nombres para las llaves.
 *
 * Se cuentan las casillas que hacen falta en TODA la tabla, no las de cada fila:
 * así las columnas quedan alineadas en vertical, y una tabla sin claves foráneas
 * no gasta el hueco de una casilla vacía. La usan la medida y el dibujo, y tiene
 * que ser la misma función en los dos sitios o el texto se saldría.
 */
export function huecoLlaves(columnas: readonly Columna[]): number {
  const pk = columnas.some((c) => c.pk);
  const fk = columnas.some((c) => c.fk);
  const casillas = Number(pk) + Number(fk);
  // Más un respiro, que no es adorno: el rombo de clave foránea es más ancho que
  // el paletón de la llave y sin él queda pegado a la primera letra del nombre.
  return casillas ? casillas * TABLA.casilla + TABLA.respiro : 0;
}

function tamanoTabla(
  nombre: string,
  min: { ancho: number; alto: number },
  columnas: readonly Columna[],
): { ancho: number; alto: number } {
  // Una tabla sin columnas conserva el alto de una fila: si se encogiera hasta
  // la cabecera, borrar la última columna dejaría un nodo que ya no se parece a
  // una tabla y no se sabría dónde va a volver a aparecer la siguiente.
  const filas = Math.max(1, columnas.length);
  const hueco = huecoLlaves(columnas);

  let ancho = medirTexto(nombre, TAM_TEXTO).ancho;
  for (const c of columnas) {
    const tipo = c.tipo ? TABLA.hueco + medirTexto(c.tipo, TAM_TIPO).ancho : 0;
    ancho = Math.max(ancho, hueco + medirTexto(c.nombre, TAM_TEXTO).ancho + tipo);
  }

  return {
    ancho: Math.max(min.ancho, ancho + TABLA.sangria * 2),
    alto: Math.max(min.alto, TABLA.cabecera + filas * TABLA.fila + TABLA.pie),
  };
}

/**
 * Tamaño que necesita un nodo para que le quepa su texto.
 *
 * Cada forma desperdicia el espacio de otra manera:
 *
 * - El rombo solo contiene un rectángulo centrado si `tw/W + th/H <= 1`, y el
 *   ajuste más pequeño es `W = 2·tw`, `H = 2·th`. De ahí el doble: no es un
 *   margen generoso, es la condición para que el texto no se salga por los lados
 *   inclinados.
 * - La pastilla del terminal se come un semicírculo en cada extremo, y los dos
 *   juntos suman justo su altura.
 */
export function tamanoPara(
  texto: string,
  forma: FormaNodo,
  columnas?: readonly Columna[],
): { ancho: number; alto: number } {
  const def = formaDe(forma);
  const min = def.minimo ?? { ancho: ANCHO_MIN, alto: ALTO_MIN };

  // Las formas de tamaño fijo llevan la etiqueta fuera (un evento BPMN, un
  // actor), así que el texto no las hace crecer.
  if (def.fijo) return { ...min };

  // La tabla no crece por el texto envuelto sino por su lista: una fila por
  // columna a lo alto, y a lo ancho lo que pida la más larga.
  if (def.columnas) return tamanoTabla(texto, min, columnas ?? []);

  const t = cajaTexto(texto);
  const alto = Math.max(min.alto, t.alto * def.holgura.y + AIRE_Y * 2);
  // La pastilla se come su propia altura de ancho, un semicírculo por extremo.
  const extra = def.capsula ? alto : 0;

  return {
    ancho: Math.max(min.ancho, t.ancho * def.holgura.x + AIRE_X * 2 + extra),
    alto,
  };
}

/**
 * Columnas con las que nace una tabla.
 *
 * Con una clave primaria puesta y no vacía: una tabla en blanco no enseña para
 * qué sirve la forma, y la llave de la primera fila es justo lo que la
 * distingue de un rectángulo cualquiera.
 */
function columnasIniciales(forma: FormaNodo): Columna[] | undefined {
  return formaDe(forma).columnas ? [{ nombre: 'id', tipo: 'int', pk: true }] : undefined;
}

export function crearNodo(texto: string, forma: FormaNodo, centro: Punto): Nodo {
  const columnas = columnasIniciales(forma);
  const { ancho, alto } = tamanoPara(texto, forma, columnas);
  return { id: nuevoId(), x: centro.x, y: centro.y, ancho, alto, texto, forma, ...(columnas && { columnas }) };
}

/** Cambia texto, forma o columnas de un nodo y le recalcula el tamaño. */
export function rehacerNodo(
  n: Nodo,
  cambios: Partial<Pick<Nodo, 'texto' | 'forma' | 'columnas'>>,
): Nodo {
  const texto = cambios.texto ?? n.texto;
  const forma = cambios.forma ?? n.forma;
  /* Las columnas se CONSERVAN aunque la forma nueva no las enseñe. Aquí no hay
     deshacer, y en el pie las cinco formas de entidad-relación están una al lado
     de otra: un clic de más en «Entidad» no puede llevarse por delante doce
     columnas escritas a mano. Quedan en el fichero sin pintarse y vuelven a
     salir en cuanto se recupera la forma de tabla. */
  const columnas = cambios.columnas ?? n.columnas ?? columnasIniciales(forma);

  return {
    ...n,
    texto,
    forma,
    ...(columnas && { columnas }),
    ...tamanoPara(texto, forma, columnas),
  };
}

/**
 * Cambia la lista de columnas de un nodo con la función que se le pase, y le
 * recalcula el tamaño. Una sola puerta de entrada para todo lo que hace el panel
 * —añadir, quitar, renombrar, marcar una clave, subir una fila—: así ninguna de
 * esas operaciones puede olvidarse de que la tabla tiene que crecer.
 */
export function editarColumnas(
  e: Esquema,
  id: string,
  cambio: (columnas: readonly Columna[]) => Columna[],
): Esquema {
  return {
    ...e,
    nodos: e.nodos.map((n) =>
      n.id === id ? rehacerNodo(n, { columnas: cambio(n.columnas ?? []) }) : n,
    ),
  };
}

/** Intercambia la columna `i` con su vecina. Fuera de rango, deja la lista igual. */
export function moverColumna(columnas: readonly Columna[], i: number, salto: number): Columna[] {
  const j = i + salto;
  const lista = [...columnas];
  if (i < 0 || i >= lista.length || j < 0 || j >= lista.length) return lista;
  [lista[i], lista[j]] = [lista[j], lista[i]];
  return lista;
}

/**
 * ¿Cae el punto dentro del nodo? De aquí sale todo lo demás: el anclaje de las
 * flechas es una búsqueda binaria sobre esta función.
 *
 * Se resuelve por el `cuerpo` del catálogo y no por la silueta exacta: para
 * apuntar con el ratón, un cilindro se comporta como una caja y un hexágono como
 * un rombo, y afinar más solo daría más sitios donde equivocarse.
 */
export function dentro(n: Nodo, p: Punto): boolean {
  const dx = Math.abs(p.x - n.x);
  const dy = Math.abs(p.y - n.y);
  const hw = n.ancho / 2;
  const hh = n.alto / 2;

  switch (formaDe(n.forma).cuerpo) {
    case 'rombo':
      return dx / hw + dy / hh <= 1;
    case 'elipse':
      return (dx / hw) ** 2 + (dy / hh) ** 2 <= 1;
    case 'pastilla': {
      const r = hh;
      // Punto más cercano del segmento central; si el nodo es más bajo que
      // ancho, la pastilla degenera en un círculo y el segmento mide cero.
      const cx = Math.min(dx, Math.max(0, hw - r));
      return Math.hypot(dx - cx, dy) <= r;
    }
    default:
      return dx <= hw && dy <= hh;
  }
}

/**
 * Punto del borde del nodo por el que sale (o entra) una flecha que apunta a
 * `hacia`.
 *
 * Va por búsqueda binaria sobre `dentro` en vez de por una intersección
 * analítica: una sola implementación sirve para las tres formas, y añadir una
 * cuarta solo pedirá extender `dentro`. Con 24 pasos el error es muy inferior a
 * un píxel para cualquier nodo de un tamaño razonable.
 */
export function anclaje(n: Nodo, hacia: Punto): Punto {
  const dx = hacia.x - n.x;
  const dy = hacia.y - n.y;
  const largo = Math.hypot(dx, dy);
  if (largo === 0) return { x: n.x, y: n.y };

  const ux = dx / largo;
  const uy = dy / largo;
  // La media diagonal deja el punto fuera de cualquiera de las tres formas,
  // también cuando el destino cae dentro del propio nodo (nodos solapados).
  let fuera = Math.hypot(n.ancho, n.alto) / 2 + 1;
  let adentro = 0;

  for (let i = 0; i < 24; i++) {
    const medio = (adentro + fuera) / 2;
    if (dentro(n, { x: n.x + ux * medio, y: n.y + uy * medio })) adentro = medio;
    else fuera = medio;
  }

  return { x: n.x + ux * adentro, y: n.y + uy * adentro };
}

export function nodoPorId(e: Esquema, id: string): Nodo | undefined {
  return e.nodos.find((n) => n.id === id);
}

/** Vector unitario de una dirección. La `y` crece hacia abajo, como en pantalla. */
export function vectorDe(d: Direccion): Punto {
  if (d === 'arriba') return { x: 0, y: -1 };
  if (d === 'abajo') return { x: 0, y: 1 };
  if (d === 'izquierda') return { x: -1, y: 0 };
  return { x: 1, y: 0 };
}

/**
 * Centro del punto de enganche de un lado, un poco por fuera del borde.
 *
 * Se apoya en `anclaje` en vez de en la mitad del ancho para que el punto salga
 * pegado a la silueta de verdad: en un rombo el lado está mucho más adentro que
 * la esquina de su caja, y calculado a ojo el punto quedaría flotando.
 */
export function puntoDe(n: Nodo, d: Direccion): Punto {
  const v = vectorDe(d);
  const borde = anclaje(n, { x: n.x + v.x * 1e4, y: n.y + v.y * 1e4 });
  return { x: borde.x + v.x * SEPARACION_PUNTO, y: borde.y + v.y * SEPARACION_PUNTO };
}

/**
 * El nodo que nacería al tirar de ese punto, **sin añadirlo**: el fantasma que
 * se enseña antes de pulsar es exactamente el mismo que se creará después, así
 * que lo que se ve en la vista previa es lo que se obtiene.
 *
 * Hereda la forma del origen: quien sale de un rombo suele estar dibujando otra
 * decisión, y cambiarla luego es un clic en la barra de abajo.
 */
export function nodoFantasma(origen: Nodo, d: Direccion, texto: string): Nodo {
  const v = vectorDe(d);
  // Hereda la forma, pero NO las columnas del origen: al brotar de una tabla se
  // quiere otra tabla, no una copia de la misma. Nace con su clave primaria,
  // igual que si se hubiera insertado desde el menú.
  const columnas = columnasIniciales(origen.forma);
  const medida = tamanoPara(texto, origen.forma, columnas);
  const horizontal = d === 'izquierda' || d === 'derecha';
  // Se separan las dos mitades más el hueco: así dos nodos anchos no se pisan.
  const salto =
    (horizontal ? origen.ancho : origen.alto) / 2 +
    (horizontal ? medida.ancho : medida.alto) / 2 +
    HUECO_BROTE;

  return {
    id: '',
    x: origen.x + v.x * salto,
    y: origen.y + v.y * salto,
    texto,
    forma: origen.forma,
    ...(columnas && { columnas }),
    ...medida,
  };
}

/**
 * Hasta dónde se busca un nodo con el que enlazar antes de crear uno nuevo.
 *
 * Está en **unidades del esquema**, las mismas del `viewBox` — no son píxeles ni
 * `rem`, porque el SVG se escala y un píxel de pantalla no vale lo mismo según
 * el tamaño de la ventana.
 *
 * Como referencia: el lienzo mide 900 × 620 y un nodo corriente ronda los 90 de
 * ancho, así que 200 son un par de nodos de separación, o cosa de un tercio del
 * alto de la pantalla. Lo bastante para encadenar con algo que se ve cerca, y no
 * tanto como para que uno pegado al borde de arriba enlace con otro pegado al de
 * abajo — que es lo que pasaba con valores más grandes. Es la constante que hay
 * que tocar para afinarlo.
 */
export const ALCANCE_ENLACE = 200;

/** Cuánto puede desviarse del eje un vecino y seguir contando como «enfrente». */
const DESVIO_ENLACE = 20;

/**
 * El nodo que ya está en esa dirección, si lo hay y está lo bastante cerca.
 *
 * Tiene que cumplir tres cosas: estar **delante** (uno detrás no está en esa
 * dirección), estar **enfrente** —que las siluetas se crucen en el eje
 * transversal, con algo de holgura— y quedar dentro de `alcance`, medido de cara
 * a cara y no de centro a centro, que es lo que se ve como «separación».
 *
 * Se descartan los que ya están enlazados desde el origen: si vuelves a pulsar
 * el punto teniendo ya la flecha, lo que quieres es otro nodo, no repetir una
 * conexión que `conectar` rechazaría de todas formas dejando el clic sin efecto.
 */
export function vecinoEn(
  e: Esquema,
  id: string,
  d: Direccion,
  alcance = ALCANCE_ENLACE,
): Nodo | undefined {
  const origen = nodoPorId(e, id);
  if (!origen) return undefined;

  const horizontal = d === 'izquierda' || d === 'derecha';
  const signo = d === 'derecha' || d === 'abajo' ? 1 : -1;

  // Eje de avance y eje transversal, para no repetir la misma cuenta cuatro
  // veces con las coordenadas cambiadas.
  const avance = (n: Nodo) => (horizontal ? n.x : n.y);
  const mitadAvance = (n: Nodo) => (horizontal ? n.ancho : n.alto) / 2;
  const cruce = (n: Nodo) => (horizontal ? n.y : n.x);
  const mitadCruce = (n: Nodo) => (horizontal ? n.alto : n.ancho) / 2;

  let mejor: Nodo | undefined;
  let corta = Infinity;

  for (const n of e.nodos) {
    if (n.id === origen.id) continue;
    if (e.conexiones.some((c) => c.desde === origen.id && c.hasta === n.id)) continue;

    const delante = (avance(n) - avance(origen)) * signo;
    if (delante <= 0) continue;

    // Hueco entre las caras que se miran. Negativo si se solapan, y entonces
    // desde luego está «ahí».
    const hueco = delante - mitadAvance(origen) - mitadAvance(n);
    if (hueco > alcance) continue;

    const desvio = Math.abs(cruce(n) - cruce(origen));
    if (desvio > mitadCruce(n) + mitadCruce(origen) + DESVIO_ENLACE) continue;

    if (hueco < corta) {
      corta = hueco;
      mejor = n;
    }
  }

  return mejor;
}

/**
 * Hace real lo que anunciaba el fantasma.
 *
 * Si en esa dirección ya hay un nodo cerca, **solo se traza la flecha hasta él**:
 * crear otro encima o al lado sería duplicar lo que el usuario ya tiene delante.
 * Si no lo hay, nace uno. `creado` distingue los dos casos para el que llame.
 */
export function brotar(
  e: Esquema,
  id: string,
  d: Direccion,
  texto: string,
): { esquema: Esquema; nuevo: Nodo; creado: boolean } | undefined {
  const origen = nodoPorId(e, id);
  if (!origen) return undefined;

  const vecino = vecinoEn(e, id, d);
  if (vecino) return { esquema: conectar(e, origen.id, vecino.id), nuevo: vecino, creado: false };

  const nuevo = { ...nodoFantasma(origen, d, texto), id: nuevoId() };
  const conNodo = { ...e, nodos: [...e.nodos, nuevo] };
  return { esquema: conectar(conNodo, origen.id, nuevo.id), nuevo, creado: true };
}

/**
 * Punto de enganche más cercano al ratón, entre los nodos que los estén
 * enseñando. `undefined` si no hay ninguno a tiro.
 */
export function engancheEn(
  e: Esquema,
  ids: readonly string[],
  p: Punto,
  alcance: number,
): { nodo: string; dir: Direccion } | undefined {
  let mejor: { nodo: string; dir: Direccion } | undefined;
  let corta = alcance;

  for (const id of ids) {
    const n = nodoPorId(e, id);
    if (!n) continue;
    for (const dir of DIRECCIONES) {
      const q = puntoDe(n, dir);
      const dist = Math.hypot(p.x - q.x, p.y - q.y);
      // `<=` y no `<`: con varios empatados gana el último mirado, y el orden de
      // `DIRECCIONES` es estable, así que no parpadea entre dos.
      if (dist <= corta) {
        corta = dist;
        mejor = { nodo: id, dir };
      }
    }
  }

  return mejor;
}

/** Nodo bajo el punto, el último dibujado primero (es el que se ve encima). */
export function nodoEn(e: Esquema, p: Punto): Nodo | undefined {
  for (let i = e.nodos.length - 1; i >= 0; i--) {
    if (dentro(e.nodos[i], p)) return e.nodos[i];
  }
  return undefined;
}

/** Los dos extremos de una conexión, ya apoyados en el borde de cada nodo. */
/**
 * Cuánto sale la línea en perpendicular antes de girar.
 *
 * Sin este tramo recto, un codo pegado al borde parece que la flecha se dobla
 * dentro del propio nodo. Es lo que da el aire de diagrama de base de datos.
 */
const ESPOLON = 22;

/**
 * Qué parte del lado se reparte entre varias flechas.
 *
 * El resto queda de margen con las esquinas, donde una flecha se vería
 * despegada de la silueta. Con 0,8 tres flechas abarcan un 40% del lado, que es
 * lo que hace falta para que se lean como tres y no como un trazo gordo.
 */
const REPARTO = 0.8;

/** Por qué lado sale cada extremo, mirando dónde cae el otro nodo. */
function ladosEntre(a: Nodo, b: Nodo): { ladoA: Direccion; ladoB: Direccion } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  // Manda el eje en el que están más separados: dos tablas una al lado de la
  // otra se unen de costado, y una encima de otra por arriba y abajo.
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { ladoA: 'derecha', ladoB: 'izquierda' }
      : { ladoA: 'izquierda', ladoB: 'derecha' };
  }
  return dy >= 0 ? { ladoA: 'abajo', ladoB: 'arriba' } : { ladoA: 'arriba', ladoB: 'abajo' };
}

/**
 * Punto de enganche en un lado del nodo. `fraccion` va de 0 a 1 a lo largo del
 * lado, y 0,5 es el centro.
 *
 * Se apoya en `anclaje` para pegarlo a la silueta de verdad: sobre la caja, el
 * punto de un rombo o de una elipse quedaría flotando en el aire.
 */
function puntoDeLado(n: Nodo, lado: Direccion, fraccion: number): Punto {
  const v = vectorDe(lado);
  const desvio = (fraccion - 0.5) * REPARTO;
  /* Media anchura, no una entera: el objetivo tiene que caer JUSTO sobre el
     lado. Puesto más lejos, el rayo que traza `anclaje` desde el centro llega al
     borde habiendo recorrido solo parte del desvío, y el reparto salía a la
     mitad de lo previsto — con tres flechas apenas se distinguían. */
  const objetivo =
    v.x !== 0
      ? { x: n.x + (v.x * n.ancho) / 2, y: n.y + desvio * n.alto }
      : { x: n.x + desvio * n.ancho, y: n.y + (v.y * n.alto) / 2 };
  return anclaje(n, objetivo);
}

/** Quita puntos repetidos y vértices que no doblan nada. */
function simplificar(pts: Punto[]): Punto[] {
  const limpio: Punto[] = [];
  for (const p of pts) {
    const ultimo = limpio[limpio.length - 1];
    if (ultimo && Math.abs(ultimo.x - p.x) < 0.5 && Math.abs(ultimo.y - p.y) < 0.5) continue;
    limpio.push(p);
  }

  // Un vértice alineado con sus dos vecinos no es un codo: sobra, y si se
  // quedara el redondeo de esquinas le pondría una curva a una recta.
  const salida: Punto[] = [];
  for (let i = 0; i < limpio.length; i++) {
    const a = salida[salida.length - 1];
    const b = limpio[i];
    const c = limpio[i + 1];
    if (a && c) {
      const cruz = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      if (Math.abs(cruz) < 0.5) continue;
    }
    salida.push(b);
  }
  return salida;
}

/**
 * Ruta en ángulos rectos entre dos enganches, cada uno con su normal de salida.
 *
 * Tres formas, según cómo se miren los dos extremos: si se dan de frente y hay
 * sitio, una Z con el giro a media distancia; si se dan la espalda, se rodea por
 * el eje contrario; y si uno sale en horizontal y el otro en vertical, basta una
 * L. No esquiva nodos por el camino: eso es otro problema (A\* sobre rejilla) y
 * se puede añadir después sin cambiar nada de lo guardado.
 */
function enCodos(a: Punto, na: Punto, b: Punto, nb: Punto): Punto[] {
  const pa = { x: a.x + na.x * ESPOLON, y: a.y + na.y * ESPOLON };
  const pb = { x: b.x + nb.x * ESPOLON, y: b.y + nb.y * ESPOLON };
  const aHoriz = na.x !== 0;
  const bHoriz = nb.x !== 0;

  if (aHoriz && bHoriz) {
    const deFrente = na.x > 0 ? pb.x >= pa.x : pb.x <= pa.x;
    if (deFrente) {
      const mx = (pa.x + pb.x) / 2;
      return simplificar([a, pa, { x: mx, y: pa.y }, { x: mx, y: pb.y }, pb, b]);
    }
    const my = (pa.y + pb.y) / 2;
    return simplificar([a, pa, { x: pa.x, y: my }, { x: pb.x, y: my }, pb, b]);
  }

  if (!aHoriz && !bHoriz) {
    const deFrente = na.y > 0 ? pb.y >= pa.y : pb.y <= pa.y;
    if (deFrente) {
      const my = (pa.y + pb.y) / 2;
      return simplificar([a, pa, { x: pa.x, y: my }, { x: pb.x, y: my }, pb, b]);
    }
    const mx = (pa.x + pb.x) / 2;
    return simplificar([a, pa, { x: mx, y: pa.y }, { x: mx, y: pb.y }, pb, b]);
  }

  return aHoriz
    ? simplificar([a, pa, { x: pb.x, y: pa.y }, pb, b])
    : simplificar([a, pa, { x: pa.x, y: pb.y }, pb, b]);
}

/** Aire que dejan las rutas alrededor de un nodo al esquivarlo. */
const MARGEN_ESQUIVA = 12;

/** Cuánto se ensancha la zona de búsqueda más allá de los dos extremos. */
const HOLGURA_REGION = 200;

/**
 * Lo que "cuesta" doblar, en unidades de recorrido.
 *
 * Sin castigo, el camino más corto es una escalera de veinte peldaños: para el
 * algoritmo da igual, pero se lee fatal. Con 40, dar un rodeo de hasta 40 sale
 * más barato que un codo de más, y salen rutas con dos o tres tramos largos.
 */
const CASTIGO_GIRO = 40;

/** La caja de un nodo, ensanchada por el margen de esquiva. */
function cajaDe(n: Nodo, margen = MARGEN_ESQUIVA): Caja {
  return {
    x: n.x - n.ancho / 2 - margen,
    y: n.y - n.alto / 2 - margen,
    w: n.ancho + margen * 2,
    h: n.alto + margen * 2,
  };
}

/** ¿Corta el tramo (siempre horizontal o vertical) esa caja? */
function tramoCorta(a: Punto, b: Punto, c: Caja): boolean {
  const x1 = Math.min(a.x, b.x);
  const x2 = Math.max(a.x, b.x);
  const y1 = Math.min(a.y, b.y);
  const y2 = Math.max(a.y, b.y);
  // Con `<` y no `<=`: rozar el borde por fuera no es cruzar, y si contara, las
  // rutas que van pegadas al margen se descartarían solas.
  return x1 < c.x + c.w && x2 > c.x && y1 < c.y + c.h && y2 > c.y;
}

/** Valores ordenados y sin repetir (con holgura, que vienen de cuentas). */
function ordenarUnicos(vs: number[]): number[] {
  const ordenados = [...vs].sort((a, b) => a - b);
  return ordenados.filter((v, i) => i === 0 || v - ordenados[i - 1] > 0.5);
}

/** Índice del valor más cercano en una lista ya ordenada. */
function indiceDe(vs: number[], v: number): number {
  let mejor = 0;
  for (let i = 1; i < vs.length; i++) {
    if (Math.abs(vs[i] - v) < Math.abs(vs[mejor] - v)) mejor = i;
  }
  return mejor;
}

/**
 * Ruta en ángulos rectos que **rodea** los nodos que se cruzan por el camino.
 *
 * No es una rejilla uniforme: las únicas coordenadas que importan son los bordes
 * de los nodos (ya ensanchados) y las de los propios extremos. Entre dos bordes
 * consecutivos no hay ninguna decisión que tomar, así que meter puntos ahí solo
 * multiplicaría el trabajo. Con veinte nodos salen unas cuarenta líneas por eje
 * en vez de las cientos de una rejilla fina, y los caminos tienen menos codos.
 *
 * Encima va un Dijkstra con castigo por giro, que es lo que evita las escaleras.
 * Devuelve `undefined` si no hay paso (un nodo encerrado): el que llama se queda
 * entonces con la ruta simple, que al menos llega.
 */
function esquivando(
  obstaculos: readonly Nodo[],
  a: Punto,
  na: Punto,
  b: Punto,
  nb: Punto,
): Punto[] | undefined {
  const pa = { x: a.x + na.x * ESPOLON, y: a.y + na.y * ESPOLON };
  const pb = { x: b.x + nb.x * ESPOLON, y: b.y + nb.y * ESPOLON };

  /* Solo estorban los nodos de por aquí. Un nodo en la otra punta del esquema no
     puede cambiar una ruta corta, y meter sus bordes en el grafo hace crecer la
     búsqueda con el TAMAÑO DEL DIAGRAMA en vez de con lo que hay en medio — que
     es la diferencia entre repintar en un milisegundo o en veinte. Los bordes de
     la región entran como líneas candidatas, para poder rodear por fuera. */
  const region: Caja = {
    x: Math.min(pa.x, pb.x) - HOLGURA_REGION,
    y: Math.min(pa.y, pb.y) - HOLGURA_REGION,
    w: Math.abs(pa.x - pb.x) + HOLGURA_REGION * 2,
    h: Math.abs(pa.y - pb.y) + HOLGURA_REGION * 2,
  };
  const cajas = obstaculos
    .map((n) => cajaDe(n))
    .filter(
      (c) =>
        c.x < region.x + region.w &&
        c.x + c.w > region.x &&
        c.y < region.y + region.h &&
        c.y + c.h > region.y,
    );

  const xs = ordenarUnicos([
    pa.x,
    pb.x,
    region.x,
    region.x + region.w,
    ...cajas.flatMap((c) => [c.x, c.x + c.w]),
  ]);
  const ys = ordenarUnicos([
    pa.y,
    pb.y,
    region.y,
    region.y + region.h,
    ...cajas.flatMap((c) => [c.y, c.y + c.h]),
  ]);
  const ancho = xs.length;
  const alto = ys.length;

  const punto = (i: number, j: number): Punto => ({ x: xs[i], y: ys[j] });
  const libre = (p: Punto, q: Punto) => !cajas.some((c) => tramoCorta(p, q, c));

  /* El estado lleva la orientación con la que se llega, que es lo que permite
     cobrar el giro. Sin ella no habría forma de distinguir «seguir recto» de
     «doblar aquí». 0 = horizontal, 1 = vertical. */
  const total = ancho * alto * 2;
  const clave = (i: number, j: number, o: number) => (j * ancho + i) * 2 + o;
  const coste = new Float64Array(total).fill(Infinity);
  const previo = new Int32Array(total).fill(-1);

  const ia = indiceDe(xs, pa.x);
  const ja = indiceDe(ys, pa.y);
  const ib = indiceDe(xs, pb.x);
  const jb = indiceDe(ys, pb.y);

  const inicio = clave(ia, ja, na.x !== 0 ? 0 : 1);
  coste[inicio] = 0;

  // Montón binario mínimo: la cola de prioridad del Dijkstra.
  const monton: { c: number; k: number }[] = [{ c: 0, k: inicio }];
  const meter = (c: number, k: number) => {
    monton.push({ c, k });
    let i = monton.length - 1;
    while (i > 0) {
      const padre = (i - 1) >> 1;
      if (monton[padre].c <= monton[i].c) break;
      [monton[padre], monton[i]] = [monton[i], monton[padre]];
      i = padre;
    }
  };
  const sacar = () => {
    const primero = monton[0];
    const ultimo = monton.pop()!;
    if (monton.length) {
      monton[0] = ultimo;
      let i = 0;
      for (;;) {
        const iz = i * 2 + 1;
        const de = i * 2 + 2;
        let menor = i;
        if (iz < monton.length && monton[iz].c < monton[menor].c) menor = iz;
        if (de < monton.length && monton[de].c < monton[menor].c) menor = de;
        if (menor === i) break;
        [monton[menor], monton[i]] = [monton[i], monton[menor]];
        i = menor;
      }
    }
    return primero;
  };

  let fin = -1;
  while (monton.length) {
    const { c, k } = sacar();
    if (c > coste[k]) continue;

    const o = k % 2;
    const celda = (k - o) / 2;
    const i = celda % ancho;
    const j = (celda - i) / ancho;

    if (i === ib && j === jb) {
      fin = k;
      break;
    }

    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const ni = i + di;
      const nj = j + dj;
      if (ni < 0 || ni >= ancho || nj < 0 || nj >= alto) continue;

      const desde = punto(i, j);
      const hasta = punto(ni, nj);
      if (!libre(desde, hasta)) continue;

      const no = di !== 0 ? 0 : 1;
      const paso = Math.hypot(hasta.x - desde.x, hasta.y - desde.y) + (no === o ? 0 : CASTIGO_GIRO);
      const nk = clave(ni, nj, no);
      if (c + paso < coste[nk]) {
        coste[nk] = c + paso;
        previo[nk] = k;
        meter(c + paso, nk);
      }
    }
  }

  if (fin < 0) return undefined;

  const camino: Punto[] = [];
  for (let k = fin; k >= 0; k = previo[k]) {
    const o = k % 2;
    const celda = (k - o) / 2;
    const i = celda % ancho;
    camino.push(punto(i, (celda - i) / ancho));
  }
  camino.reverse();

  return simplificar([a, ...camino, b]);
}

/** ¿Pasa la ruta limpia, sin meterse en ningún nodo? */
function rutaLibre(pts: Punto[], obstaculos: readonly Nodo[]): boolean {
  const cajas = obstaculos.map((n) => cajaDe(n, MARGEN_ESQUIVA / 2));
  for (let i = 1; i < pts.length; i++) {
    if (cajas.some((c) => tramoCorta(pts[i - 1], pts[i], c))) return false;
  }
  return true;
}

/**
 * La ruta definitiva entre dos enganches: la simple si pasa limpia, y si no, la
 * que rodea.
 *
 * Se prueba primero la simple a propósito. Es el caso corriente, cuesta cuatro
 * cuentas, y el Dijkstra solo se paga cuando de verdad hay algo en medio — que
 * importa porque esto se recalcula en cada repintado, también mientras se
 * arrastra un nodo.
 */
function trazar(
  obstaculos: readonly Nodo[],
  a: Punto,
  na: Punto,
  b: Punto,
  nb: Punto,
  extremos: readonly string[],
): Punto[] {
  const simple = enCodos(a, na, b, nb);
  // Los dos nodos que une no cuentan: la ruta nace y muere pegada a ellos.
  const estorbo = obstaculos.filter((n) => !extremos.includes(n.id));
  if (rutaLibre(simple, estorbo)) return simple;

  return esquivando(estorbo, a, na, b, nb) ?? simple;
}

/** Ruta entre dos nodos sueltos, sin repartir ranuras. */
export function rutaEntre(a: Nodo, b: Nodo, obstaculos: readonly Nodo[] = []): Punto[] {
  const { ladoA, ladoB } = ladosEntre(a, b);
  return trazar(
    obstaculos,
    puntoDeLado(a, ladoA, 0.5),
    vectorDe(ladoA),
    puntoDeLado(b, ladoB, 0.5),
    vectorDe(ladoB),
    [a.id, b.id],
  );
}

/**
 * La ruta de **todas** las conexiones, de una vez.
 *
 * Se calculan juntas y no una a una porque el reparto es cosa del conjunto: las
 * flechas que salen por el mismo lado del mismo nodo tienen que escalonarse, o
 * saldrían todas del mismo punto y se solaparían. Y se ordenan por dónde queda
 * el otro extremo, que es lo que evita que se crucen entre ellas nada más
 * salir.
 */
let ultimoEsquema: Esquema | null = null;
let ultimasRutas: Map<string, Punto[]> | null = null;

export function rutas(e: Esquema): Map<string, Punto[]> {
  /* Memoria de una sola entrada, por identidad. El esquema es inmutable —toda
     operación devuelve uno nuevo—, así que si es el mismo objeto las rutas son
     las mismas. Sirve porque en un repintado esto se pide varias veces: lo llama
     el dibujo, lo llama `conexionEn` al mover el ratón y lo llama `medio`. */
  if (ultimoEsquema === e && ultimasRutas) return ultimasRutas;

  const mapa = calcularRutas(e);
  ultimoEsquema = e;
  ultimasRutas = mapa;
  return mapa;
}

function calcularRutas(e: Esquema): Map<string, Punto[]> {
  type Ranura = { c: Conexion; lado: Direccion; propio: boolean };
  const porLado = new Map<string, Ranura[]>();
  const lados = new Map<string, { ladoA: Direccion; ladoB: Direccion }>();

  for (const c of e.conexiones) {
    const a = nodoPorId(e, c.desde);
    const b = nodoPorId(e, c.hasta);
    if (!a || !b) continue;

    const par = ladosEntre(a, b);
    lados.set(c.id, par);
    for (const [nodo, lado, propio] of [
      [c.desde, par.ladoA, true],
      [c.hasta, par.ladoB, false],
    ] as const) {
      const clave = `${nodo}|${lado}`;
      const lista = porLado.get(clave) ?? [];
      lista.push({ c, lado, propio });
      porLado.set(clave, lista);
    }
  }

  /** Fracción asignada a cada (conexión, extremo). */
  const fracciones = new Map<string, number>();
  for (const [clave, lista] of porLado) {
    const [nodoId, lado] = clave.split('|');
    const vertical = lado === 'izquierda' || lado === 'derecha';

    lista.sort((x, y) => {
      const otroX = nodoPorId(e, x.propio ? x.c.hasta : x.c.desde);
      const otroY = nodoPorId(e, y.propio ? y.c.hasta : y.c.desde);
      if (!otroX || !otroY) return 0;
      // Por el eje transversal al lado: así el de más arriba sale más arriba.
      return vertical ? otroX.y - otroY.y : otroX.x - otroY.x;
    });

    lista.forEach((r, i) => {
      fracciones.set(`${r.c.id}|${nodoId}|${r.propio}`, (i + 1) / (lista.length + 1));
    });
  }

  const salida = new Map<string, Punto[]>();
  for (const c of e.conexiones) {
    const a = nodoPorId(e, c.desde);
    const b = nodoPorId(e, c.hasta);
    const par = lados.get(c.id);
    if (!a || !b || !par) continue;

    const fa = fracciones.get(`${c.id}|${c.desde}|true`) ?? 0.5;
    const fb = fracciones.get(`${c.id}|${c.hasta}|false`) ?? 0.5;
    salida.set(
      c.id,
      trazar(
        e.nodos,
        puntoDeLado(a, par.ladoA, fa),
        vectorDe(par.ladoA),
        puntoDeLado(b, par.ladoB, fb),
        vectorDe(par.ladoB),
        [a.id, b.id],
      ),
    );
  }

  return salida;
}

/** Largo total de una ruta. */
function largoDe(pts: Punto[]): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return total;
}

/** El punto que queda a mitad de recorrido, donde se apoya la etiqueta. */
export function medioDeRuta(pts: Punto[]): Punto {
  if (pts.length < 2) return pts[0] ?? { x: 0, y: 0 };

  let restante = largoDe(pts) / 2;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x;
    const dy = pts[i].y - pts[i - 1].y;
    const tramo = Math.hypot(dx, dy);
    if (restante <= tramo) {
      const t = tramo === 0 ? 0 : restante / tramo;
      return { x: pts[i - 1].x + dx * t, y: pts[i - 1].y + dy * t };
    }
    restante -= tramo;
  }
  return pts[pts.length - 1];
}

/** Distancia de un punto al segmento a–b. */
function distanciaASegmento(p: Punto, a: Punto, b: Punto): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const largo2 = vx * vx + vy * vy;
  if (largo2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / largo2));
  return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
}

export function conexionEn(e: Esquema, p: Punto, tolerancia: number): Conexion | undefined {
  const mapa = rutas(e);
  for (let i = e.conexiones.length - 1; i >= 0; i--) {
    const ruta = mapa.get(e.conexiones[i].id);
    if (!ruta) continue;
    // Contra CADA tramo: con codos, medir solo la recta entre extremos dejaría
    // fuera del alcance justo los trozos por los que va la línea.
    for (let j = 1; j < ruta.length; j++) {
      if (distanciaASegmento(p, ruta[j - 1], ruta[j]) <= tolerancia) return e.conexiones[i];
    }
  }
  return undefined;
}

/** Punto medio de una conexión, donde se apoya su etiqueta. */
export function medio(e: Esquema, c: Conexion): Punto | undefined {
  const ruta = rutas(e).get(c.id);
  return ruta && medioDeRuta(ruta);
}

/** Desplaza a la vez todos los nodos cuyos ids se den. */
export function moverNodos(e: Esquema, ids: ReadonlySet<string>, dx: number, dy: number): Esquema {
  if (!ids.size) return e;
  return {
    ...e,
    nodos: e.nodos.map((n) => (ids.has(n.id) ? { ...n, x: n.x + dx, y: n.y + dy } : n)),
  };
}

export function moverNodo(e: Esquema, id: string, dx: number, dy: number): Esquema {
  return moverNodos(e, new Set([id]), dx, dy);
}

/** La caja que abarcan dos puntos, en cualquier orden. */
export function cajaEntre(a: Punto, b: Punto): Caja {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

/**
 * Nodos que **tocan** la caja, no solo los que quedan dentro del todo.
 *
 * Rodear por completo obligaría a barrer siempre desde fuera del grupo, y con
 * un nodo grande cerca del borde es un gesto incómodo. Tocando basta, que es lo
 * que hacen los editores de dibujo.
 */
export function nodosEnCaja(e: Esquema, c: Caja): Nodo[] {
  return e.nodos.filter(
    (n) =>
      n.x + n.ancho / 2 >= c.x &&
      n.x - n.ancho / 2 <= c.x + c.w &&
      n.y + n.alto / 2 >= c.y &&
      n.y - n.alto / 2 <= c.y + c.h,
  );
}

/**
 * Quita un nodo y, con él, las conexiones que lo tocaban.
 *
 * Dejarlas huérfanas sería peor que un dibujo raro: `extremos` las descartaría
 * en silencio, así que sobrevivirían en el fichero sin verse nunca, y volverían
 * a aparecer si alguien reutilizara el id.
 */
export function borrarNodo(e: Esquema, id: string): Esquema {
  return borrarVarios(e, new Set([id]));
}

/** Cambia el tipo de una conexión. */
export function cambiarTipoConexion(e: Esquema, id: string, tipo: string): Esquema {
  return {
    ...e,
    conexiones: e.conexiones.map((c) => (c.id === id ? { ...c, tipo } : c)),
  };
}

/**
 * Da la vuelta a una conexión.
 *
 * Solo intercambia los extremos, y con eso basta: las marcas van pegadas a
 * `desde` y `hasta`, así que un «uno a muchos» pasa a leerse «muchos a uno» sin
 * tocar el tipo. Es lo que se espera de invertir, y evita tener que borrar la
 * flecha y volver a trazarla del revés.
 */
export function invertirConexion(e: Esquema, id: string): Esquema {
  return {
    ...e,
    conexiones: e.conexiones.map((c) =>
      c.id === id ? { ...c, desde: c.hasta, hasta: c.desde } : c,
    ),
  };
}

export function borrarConexion(e: Esquema, id: string): Esquema {
  return borrarVarios(e, new Set([id]));
}

/**
 * Quita de una vez todo lo seleccionado, sean nodos o conexiones, y de paso las
 * conexiones que se quedan sin uno de sus extremos.
 *
 * Un solo paso para las dos cosas porque la selección las mezcla: pedir al
 * llamante que las separe antes solo repartiría la misma comprobación por todos
 * los sitios que borran.
 */
export function borrarVarios(e: Esquema, ids: ReadonlySet<string>): Esquema {
  if (!ids.size) return e;

  const nodos = e.nodos.filter((n) => !ids.has(n.id));
  const vivos = new Set(nodos.map((n) => n.id));

  return {
    nodos,
    conexiones: e.conexiones.filter(
      (c) => !ids.has(c.id) && vivos.has(c.desde) && vivos.has(c.hasta),
    ),
  };
}

/**
 * Conecta dos nodos. Devuelve el esquema sin tocar si la conexión no tiene
 * sentido: un nodo consigo mismo, una que ya existía (dibujaría dos flechas
 * exactamente encima la una de la otra), o un extremo que ya no está.
 *
 * Lo del extremo que no está no es defensa por si acaso: si se borra el nodo de
 * origen con un trazo a medias, el clic siguiente llegaría aquí con su id ya
 * difunto y guardaría en la nota una conexión que no se dibuja nunca.
 */
export function conectar(e: Esquema, desde: string, hasta: string): Esquema {
  if (desde === hasta) return e;
  if (!nodoPorId(e, desde) || !nodoPorId(e, hasta)) return e;
  if (e.conexiones.some((c) => c.desde === desde && c.hasta === hasta)) return e;
  return {
    ...e,
    conexiones: [
      ...e.conexiones,
      { id: nuevoId(), desde, hasta, texto: '', tipo: CONEXION_POR_DEFECTO },
    ],
  };
}

/** Caja que envuelve todo el esquema, con un margen de aire alrededor. */
export function envolvente(e: Esquema, margen = 16): Caja {
  if (!e.nodos.length) return { x: 0, y: 0, w: 1, h: 1 };

  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const n of e.nodos) {
    x1 = Math.min(x1, n.x - n.ancho / 2);
    y1 = Math.min(y1, n.y - n.alto / 2);
    x2 = Math.max(x2, n.x + n.ancho / 2);
    y2 = Math.max(y2, n.y + n.alto / 2);
  }
  return { x: x1 - margen, y: y1 - margen, w: x2 - x1 + margen * 2, h: y2 - y1 + margen * 2 };
}

/** Todo el texto legible del esquema, para el índice de búsqueda. */
export function textoDe(e: Esquema): string {
  return [...e.nodos.map((n) => n.texto), ...e.conexiones.map((c) => c.texto)]
    .filter((t) => t.trim())
    .join(' ');
}

function numero(v: unknown, porDefecto: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : porDefecto;
}

function texto(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * Las columnas de una tabla venidas del documento. `undefined` si no había
 * lista, para no meter un `columnas: []` en cada nodo del fichero.
 *
 * Una fila sin nombre ni tipo se tira: en el dibujo sería un renglón en blanco
 * que ocupa alto y no dice nada, y no hay forma de distinguirlo de un fallo.
 */
function columnasDe(valor: unknown): Columna[] | undefined {
  if (!Array.isArray(valor)) return undefined;

  const columnas: Columna[] = [];
  for (const c of valor as Record<string, unknown>[]) {
    const nombre = texto(c?.['nombre']);
    const tipo = texto(c?.['tipo']);
    if (!nombre && !tipo) continue;
    columnas.push({
      nombre,
      ...(tipo && { tipo }),
      ...(c?.['pk'] === true && { pk: true }),
      ...(c?.['fk'] === true && { fk: true }),
    });
  }
  return columnas;
}

/**
 * Reconstruye un esquema desde lo que hubiera guardado en el documento.
 *
 * Desconfía a propósito. El contenido de una nota puede venir de otro equipo con
 * otra versión de la app, de una rama de git resuelta a mano, o de alguien que
 * abrió el fichero con un editor. Un `null` en una coordenada no puede tumbar el
 * editor entero: lo peor que debe pasar es que un nodo salga en el origen.
 */
export function normalizar(valor: unknown): Esquema {
  const bruto = (valor ?? {}) as Partial<Record<keyof Esquema, unknown>>;
  const nodosBrutos = Array.isArray(bruto.nodos) ? bruto.nodos : [];
  const conexionesBrutas = Array.isArray(bruto.conexiones) ? bruto.conexiones : [];

  const nodos: Nodo[] = [];
  for (const n of nodosBrutos as Record<string, unknown>[]) {
    const id = texto(n?.['id']);
    // Sin id no hay forma de conectarlo ni de distinguirlo: no es un nodo.
    if (!id || nodos.some((otro) => otro.id === id)) continue;
    // Una forma que no está en el catálogo cae a `proceso`: puede venir de una
    // versión más nueva de la app, y perder el rectángulo es mejor que perder
    // el nodo entero.
    const crudo = texto(n?.['forma']);
    const forma = hayForma(crudo) ? crudo : 'proceso';
    const t = texto(n?.['texto']);
    const columnas = columnasDe(n?.['columnas']);
    const medida = tamanoPara(t, forma, columnas);
    nodos.push({
      id,
      x: numero(n?.['x'], 0),
      y: numero(n?.['y'], 0),
      /* La tabla se mide SIEMPRE al leer, sin hacer caso al tamaño guardado: su
         caja sale entera de la lista de columnas, y así una nota escrita con una
         versión que tuviera otro alto de fila no aparece con las filas
         desbordando el rectángulo. Las demás formas conservan lo suyo. */
      ...(formaDe(forma).columnas
        ? medida
        : {
            ancho: numero(n?.['ancho'], medida.ancho),
            alto: numero(n?.['alto'], medida.alto),
          }),
      texto: t,
      forma,
      ...(columnas && { columnas }),
    });
  }

  const conexiones: Conexion[] = [];
  for (const c of conexionesBrutas as Record<string, unknown>[]) {
    const desde = texto(c?.['desde']);
    const hasta = texto(c?.['hasta']);
    // Una conexión a un nodo que ya no está no se dibuja nunca; se descarta al
    // leer para que no siga viajando en el fichero de por vida.
    if (!nodos.some((n) => n.id === desde) || !nodos.some((n) => n.id === hasta)) continue;
    /* Un tipo desconocido cae a la flecha simple. Pasa con las notas de antes
       de que esto existiera (no traen `tipo`) y con las de una versión más
       nueva: perder el adorno es mejor que perder la conexión. */
    const tipo = texto(c?.['tipo']);
    conexiones.push({
      id: texto(c?.['id']) || nuevoId(),
      desde,
      hasta,
      texto: texto(c?.['texto']),
      tipo: hayConexion(tipo) ? tipo : CONEXION_POR_DEFECTO,
    });
  }

  return { nodos, conexiones };
}
