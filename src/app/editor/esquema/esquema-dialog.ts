import {
  Component,
  ElementRef,
  HostListener,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';

import { dibujar } from './dibujo';
import { DefinicionForma, FAMILIAS, formaDe, formasDe } from './catalogo';
import { conexionesDe, previsualizar } from './catalogo-conexiones';
import {
  Caja,
  Columna,
  Direccion,
  Esquema,
  FormaNodo,
  Punto,
  Conexion,
  Nodo,
  borrarVarios,
  brotar,
  cajaEntre,
  cambiarTipoConexion,
  conectar,
  conexionEn,
  crearNodo,
  editarColumnas,
  engancheEn,
  esquemaVacio,
  invertirConexion,
  moverColumna,
  moverNodos,
  nodoEn,
  nodosEnCaja,
  nodoPorId,
  normalizar,
  rehacerNodo,
} from './modelo';

/** Lo que se le abre al diálogo. */
export interface EsquemaDatos {
  esquema: unknown;
}

/** `null` = se canceló y la nota se queda como estaba. */
export type EsquemaResultado = Esquema | null;

/**
 * Zona de trabajo de partida, en unidades del esquema.
 *
 * El **tamaño** no cambia nunca: si el `viewBox` se ajustara al contenido,
 * arrastrar un nodo hacia fuera cambiaría el sistema de coordenadas y todo lo
 * demás daría un salto bajo el ratón. Lo que sí se mueve es su origen, que es lo
 * que hace la herramienta de mano.
 */
const VISTA: Caja = { x: 0, y: 0, w: 900, h: 620 };

/** Cuánto se separa cada nodo nuevo del anterior, para que no se apilen. */
const ESCALON = 26;

/** Holgura para acertar en una conexión con el ratón, en unidades del esquema. */
const TOLERANCIA = 8;

/**
 * A qué distancia se despierta un punto de enganche. Bastante mayor que el disco
 * que se ve (4,5): el punto es pequeño para no ensuciar el dibujo, pero tiene
 * que poder cazarse sin puntería de cirujano.
 */
const ALCANCE_PUNTO = 20;

/** Medidas del menú de la flecha, para no dejarlo salirse de la ventana. */
const ANCHO_MENU = 232;
const ALTO_MENU = 440;

type Herramienta = 'seleccionar' | 'conectar' | 'mover';

@Component({
  selector: 'app-esquema-dialog',
  standalone: true,
  imports: [MatButtonModule],
  templateUrl: './esquema-dialog.html',
  styleUrl: './esquema-dialog.scss',
})
export class EsquemaDialog {
  private readonly datos = inject<EsquemaDatos>(MAT_DIALOG_DATA);
  private readonly ref = inject<MatDialogRef<EsquemaDialog, EsquemaResultado>>(MatDialogRef);

  private readonly lienzoEl = viewChild.required<ElementRef<HTMLDivElement>>('lienzo');

  protected readonly esquema = signal<Esquema>(esquemaVacio());
  /** Todo lo seleccionado: nodos y conexiones mezclados, por id. */
  protected readonly seleccion = signal<ReadonlySet<string>>(new Set());
  protected readonly herramienta = signal<Herramienta>('seleccionar');

  /** Nodo del que sale la flecha que se está trazando, y hasta dónde va. */
  private readonly conectandoDesde = signal<string | null>(null);
  private readonly raton = signal<Punto | null>(null);

  /** Nodo bajo el ratón, y punto de enganche despierto (si hay alguno). */
  private readonly hover = signal<string | null>(null);
  private readonly puntoActivo = signal<{ nodo: string; dir: Direccion } | null>(null);

  /** Origen del `viewBox`. Lo mueve la herramienta de mano. */
  protected readonly vista = signal<Caja>({ ...VISTA });

  protected readonly menuFormas = signal(false);
  protected readonly panelColumnas = signal(false);

  /** Dónde se pulsó la flecha, para sacar el menú flotante justo ahí. */
  private readonly posMenu = signal<{ x: number; y: number } | null>(null);

  /**
   * Los tipos de conexión ya agrupados y con su miniatura calculada. Igual que
   * `grupos`: en la plantilla se recalcularía en cada ciclo de detección.
   */
  protected readonly gruposConexion = FAMILIAS.map((f) => ({
    ...f,
    tipos: conexionesDe(f.id).map((d) => ({ ...d, previa: previsualizar(d) })),
  }));

  /**
   * Las formas ya agrupadas por familia. Se calcula una vez y no en la
   * plantilla: allí devolvería una lista nueva en cada ciclo de detección de
   * cambios, y Angular no podría dar por buena ninguna.
   */
  protected readonly grupos = FAMILIAS.map((f) => ({ ...f, formas: formasDe(f.id) }));

  /** Las formas de la misma familia que la dada, para cambiar de una a otra. */
  protected hermanas(forma: FormaNodo): DefinicionForma[] {
    return this.grupos.find((g) => g.id === formaDe(forma).familia)?.formas ?? [];
  }

  /** Silueta en miniatura para el botón del menú, sacada del propio catálogo. */
  protected miniatura(f: DefinicionForma): string {
    // Las de tamaño fijo (un actor, un evento) se estrecharían de mala manera en
    // una caja apaisada: se les respeta la proporción.
    const proporcion = f.fijo && f.minimo ? f.minimo.ancho / f.minimo.alto : 34 / 22;
    const alto = Math.min(22, 34 / proporcion);
    // `mini` si la forma tiene una: la tabla se reconoce por su cabecera, y esa
    // mide 30 unidades fijas que en una miniatura de 22 caerían fuera.
    const dibuja = f.mini ?? f.contorno;
    return dibuja({ x: 22, y: 15, ancho: alto * proporcion, alto });
  }

  /** Rectángulo del barrido en curso, para que lo pinte `dibujar`. */
  private readonly marquesina = signal<Caja | null>(null);

  /** Arrastre en curso: qué nodos y dónde estaba el ratón la última vez. */
  private arrastre: { ids: ReadonlySet<string>; previo: Punto } | null = null;
  /** Barrido en curso sobre el lienzo vacío. */
  private barrido: { desde: Punto; hasta: Punto; sumando: boolean } | null = null;
  /**
   * Desplazamiento del lienzo. Guarda las coordenadas de PANTALLA, no las del
   * esquema: al mover la vista cambia la conversión entre ambas, así que un
   * punto del esquema tomado antes ya no significa lo mismo después y el lienzo
   * se iría acelerando solo.
   */
  private paneo: { x: number; y: number } | null = null;
  private cuantosNodos = 0;

  constructor() {
    this.esquema.set(normalizar(this.datos.esquema));
    this.cuantosNodos = this.esquema().nodos.length;

    // Puente entre `dibujar`, que es imperativo, y las señales: cada cambio de
    // estado vuelve a pintar el SVG entero. Con esquemas de este tamaño repintar
    // sale más barato que llevar la cuenta de qué elemento cambió.
    effect(() => {
      const conPuntos = this.nodoConPuntos();
      const svg = dibujar(this.esquema(), {
        seleccion: this.seleccion(),
        conectando: this.flechaEnCurso(),
        puntos: conPuntos,
        activo: this.puntoActivo(),
        textoBrote: this.textoDelBrote(conPuntos),
        marquesina: this.marquesina(),
        vista: this.vista(),
      });
      this.lienzoEl().nativeElement.replaceChildren(svg);
    });
  }

  /**
   * Qué nodo enseña sus puntos de enganche.
   *
   * El punto despierto manda sobre todo lo demás: los puntos viven FUERA del
   * nodo, así que en cuanto el ratón llega a uno ya no está encima del nodo, y
   * sin esta preferencia los puntos desaparecerían justo al ir a pulsarlos.
   */
  private nodoConPuntos(): string | null {
    // Con la mano no se toca nada del esquema, así que los puntos solo serían
    // una promesa falsa.
    if (this.herramienta() !== 'seleccionar') return null;
    const id = this.puntoActivo()?.nodo ?? this.hover() ?? this.unico();
    return id && nodoPorId(this.esquema(), id) ? id : null;
  }

  /** Texto con el que nace un nodo brotado: el mismo que pone la barra. */
  private textoDelBrote(id: string | null): string {
    const n = id ? nodoPorId(this.esquema(), id) : undefined;
    return n ? this.textoInicial(n.forma) : '';
  }

  private flechaEnCurso(): { desde: string; hasta: Punto } | null {
    const desde = this.conectandoDesde();
    const hasta = this.raton();
    return desde && hasta ? { desde, hasta } : null;
  }

  /**
   * El id seleccionado, si hay **exactamente uno**.
   *
   * Casi todo lo que edita una cosa concreta —el nombre, la forma, los puntos de
   * enganche— solo tiene sentido con uno: con tres seleccionados no hay «el»
   * texto que cambiar.
   */
  private unico(): string | null {
    const s = this.seleccion();
    return s.size === 1 ? [...s][0] : null;
  }

  protected readonly nodoSel = () => {
    const id = this.unico();
    return id ? nodoPorId(this.esquema(), id) : undefined;
  };

  /** La conexión seleccionada, si lo que hay seleccionado es una sola conexión. */
  protected conexionSel(): Conexion | undefined {
    const id = this.unico();
    return id ? this.esquema().conexiones.find((c) => c.id === id) : undefined;
  }

  /**
   * Dónde va el menú de la flecha, o `null` si no toca enseñarlo.
   *
   * Se recorta contra el borde de la ventana: pulsando una flecha de la derecha
   * o de abajo, un menú anclado a pelo se saldría de la pantalla y la mitad de
   * los tipos quedarían fuera de alcance.
   */
  protected menuFlecha(): { x: number; y: number } | null {
    const pos = this.posMenu();
    if (!pos || !this.conexionSel()) return null;
    return {
      x: Math.max(8, Math.min(pos.x, window.innerWidth - ANCHO_MENU - 12)),
      y: Math.max(8, Math.min(pos.y, window.innerHeight - ALTO_MENU - 12)),
    };
  }

  protected cambiarTipoFlecha(tipo: string): void {
    const id = this.unico();
    if (id) this.esquema.update((e) => cambiarTipoConexion(e, id, tipo));
  }

  protected invertirFlecha(): void {
    const id = this.unico();
    if (id) this.esquema.update((e) => invertirConexion(e, id));
  }

  /**
   * El nodo seleccionado, si es de los que llevan lista de columnas.
   *
   * Todo el panel cuelga de esto: al deseleccionar o al elegir un rombo, el
   * panel se va solo sin que nadie tenga que acordarse de cerrarlo.
   */
  protected tablaSel(): Nodo | undefined {
    const n = this.nodoSel();
    return n && formaDe(n.forma).columnas ? n : undefined;
  }

  protected columnas(): readonly Columna[] {
    return this.tablaSel()?.columnas ?? [];
  }

  /** Aplica un cambio a la lista de columnas de la tabla seleccionada. */
  private editar(cambio: (columnas: readonly Columna[]) => Columna[]): void {
    const id = this.tablaSel()?.id;
    if (id) this.esquema.update((e) => editarColumnas(e, id, cambio));
  }

  protected anadirColumna(): void {
    this.editar((cols) => [...cols, { nombre: 'campo' }]);
  }

  protected quitarColumna(i: number): void {
    this.editar((cols) => cols.filter((_, k) => k !== i));
  }

  protected subirColumna(i: number): void {
    this.editar((cols) => moverColumna(cols, i, -1));
  }

  protected bajarColumna(i: number): void {
    this.editar((cols) => moverColumna(cols, i, 1));
  }

  /** Cambia un campo de la columna `i`. Un `undefined` lo borra del fichero. */
  private cambiarColumna(i: number, cambios: Partial<Columna>): void {
    this.editar((cols) =>
      cols.map((c, k) => {
        if (k !== i) return c;
        const nueva = { ...c, ...cambios };
        // Las banderas y el tipo se quitan en vez de guardarse en falso o vacío:
        // el fichero de la nota se escribe indentado y un `"fk": false` por
        // columna sería ruido en todos los diffs.
        if (!nueva.tipo) delete nueva.tipo;
        if (!nueva.pk) delete nueva.pk;
        if (!nueva.fk) delete nueva.fk;
        return nueva;
      }),
    );
  }

  protected renombrarColumna(i: number, nombre: string): void {
    this.cambiarColumna(i, { nombre });
  }

  protected tiparColumna(i: number, tipo: string): void {
    this.cambiarColumna(i, { tipo });
  }

  /** Marca o desmarca una clave. Una columna puede ser primaria y foránea. */
  protected alternarClave(i: number, clave: 'pk' | 'fk'): void {
    const actual = this.columnas()[i];
    if (actual) this.cambiarColumna(i, { [clave]: !actual[clave] });
  }

  /** Cuántos nodos hay seleccionados (el pie lo dice cuando son varios). */
  protected cuantosSel(): number {
    return this.seleccion().size;
  }

  /** Texto de lo que esté seleccionado (nodo o conexión). */
  protected etiqueta(): string {
    const id = this.unico();
    if (!id) return '';
    const n = nodoPorId(this.esquema(), id);
    if (n) return n.texto;
    return this.esquema().conexiones.find((c) => c.id === id)?.texto ?? '';
  }

  /** Coordenadas del esquema a partir de un evento de ratón. */
  private aCoordenadas(ev: PointerEvent): Punto {
    const svg = this.lienzoEl().nativeElement.querySelector('svg');
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return { x: 0, y: 0 };
    const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }

  protected alPulsar(ev: PointerEvent): void {
    if (this.herramienta() === 'mover') {
      this.paneo = { x: ev.clientX, y: ev.clientY };
      (ev.target as Element).setPointerCapture?.(ev.pointerId);
      return;
    }

    const p = this.aCoordenadas(ev);
    const nodo = nodoEn(this.esquema(), p);

    // El punto de enganche gana a todo: está fuera del nodo y sobre el lienzo
    // vacío, así que si no se mirara primero, pulsarlo solo quitaría la selección.
    const punto = this.puntoActivo();
    if (punto && this.herramienta() === 'seleccionar') {
      const brote = brotar(this.esquema(), punto.nodo, punto.dir, this.textoDelBrote(punto.nodo));
      if (brote) {
        this.esquema.set(brote.esquema);
        // Seleccionado y con los puntos puestos: lo normal es encadenar otro
        // paso, o escribirle el nombre en la barra de abajo. Vale igual si el
        // nodo se acaba de crear que si solo se ha enlazado con uno que ya
        // estaba: en los dos casos el destino es donde sigue el trabajo.
        this.seleccion.set(new Set([brote.nuevo.id]));
        this.hover.set(brote.nuevo.id);
        this.puntoActivo.set(null);
        // La cascada solo cuenta los que nacen; si no, insertar desde la barra
        // se iría desplazando por enlaces que no crearon nada.
        if (brote.creado) this.cuantosNodos++;
      }
      return;
    }

    if (this.herramienta() === 'conectar') {
      if (!nodo) {
        // Pinchar en el vacío cancela el trazo a medias, que es lo que espera
        // cualquiera que se haya arrepentido.
        this.conectandoDesde.set(null);
        return;
      }
      const desde = this.conectandoDesde();
      if (!desde) {
        this.conectandoDesde.set(nodo.id);
        this.raton.set(p);
        return;
      }
      this.esquema.update((e) => conectar(e, desde, nodo.id));
      this.conectandoDesde.set(null);
      this.raton.set(null);
      return;
    }

    // Ctrl o Mayús: sumar o quitar de la selección en vez de empezar otra.
    const sumando = ev.ctrlKey || ev.metaKey || ev.shiftKey;

    if (nodo) {
      const actual = this.seleccion();
      if (sumando) {
        const nueva = new Set(actual);
        if (!nueva.delete(nodo.id)) nueva.add(nodo.id);
        this.seleccion.set(nueva);
        // Sin arrastre: el gesto era elegir, y mover aquí desplazaría el grupo
        // por el temblor de la mano al pulsar con dos dedos.
        return;
      }
      /* Pulsar un nodo que YA está en la selección no la deshace: es como se
         arrastra un grupo entero. Solo pulsando uno de fuera se empieza de
         cero. */
      if (!actual.has(nodo.id)) this.seleccion.set(new Set([nodo.id]));

      this.arrastre = { ids: this.seleccion(), previo: p };
      (ev.target as Element).setPointerCapture?.(ev.pointerId);
      return;
    }

    // Sin nodo: quizá se pinchó la línea de una conexión.
    const c = conexionEn(this.esquema(), p, TOLERANCIA);
    if (c) {
      const nueva = sumando ? new Set(this.seleccion()) : new Set<string>();
      if (!nueva.delete(c.id)) nueva.add(c.id);
      this.seleccion.set(nueva);
      // El menú sale donde se pulsó, no en un sitio fijo: la flecha puede estar
      // en cualquier parte del lienzo.
      this.posMenu.set({ x: ev.clientX, y: ev.clientY });
      return;
    }

    // Lienzo vacío: empieza un barrido. La selección no se limpia hasta soltar,
    // para que un clic con Ctrl no tire lo que ya había elegido.
    if (!sumando) this.seleccion.set(new Set());
    this.barrido = { desde: p, hasta: p, sumando };
    this.marquesina.set(cajaEntre(p, p));
    (ev.target as Element).setPointerCapture?.(ev.pointerId);
  }

  protected alMover(ev: PointerEvent): void {
    if (this.paneo) {
      // Los píxeles de pantalla se pasan a unidades del esquema con la escala
      // de ahora; sin dividir, el lienzo se movería más o menos que el ratón.
      const escala = this.escala();
      const dx = (ev.clientX - this.paneo.x) / escala;
      const dy = (ev.clientY - this.paneo.y) / escala;
      this.paneo = { x: ev.clientX, y: ev.clientY };
      // El contenido sigue al ratón, así que la ventana va al revés.
      this.vista.update((v) => ({ ...v, x: v.x - dx, y: v.y - dy }));
      return;
    }

    const p = this.aCoordenadas(ev);

    if (this.conectandoDesde()) {
      this.raton.set(p);
      return;
    }

    if (this.arrastre) {
      const dx = p.x - this.arrastre.previo.x;
      const dy = p.y - this.arrastre.previo.y;
      this.arrastre.previo = p;
      // Se mueve la selección entera: arrastrar uno del grupo los lleva a todos,
      // que es de lo que va poder elegir varios.
      this.esquema.update((e) => moverNodos(e, this.arrastre!.ids, dx, dy));
      return;
    }

    if (this.barrido) {
      this.barrido.hasta = p;
      this.marquesina.set(cajaEntre(this.barrido.desde, p));
      return;
    }

    this.repasarEnganches(p);
  }

  /**
   * Decide qué nodo enseña sus puntos y cuál de ellos está despierto.
   *
   * Se miran los puntos de los candidatos de siempre —el que ya los enseñaba y
   * el que hay bajo el ratón— y no los de todos los nodos: con todos, cruzar el
   * lienzo encendería puntos de nodos por los que solo se pasa de largo.
   */
  private repasarEnganches(p: Punto): void {
    if (this.herramienta() !== 'seleccionar') {
      this.puntoActivo.set(null);
      return;
    }

    const bajo = nodoEn(this.esquema(), p);
    const candidatos = [this.puntoActivo()?.nodo, this.hover(), this.unico(), bajo?.id].filter(
      (id): id is string => !!id,
    );

    const enganche = engancheEn(this.esquema(), [...new Set(candidatos)], p, ALCANCE_PUNTO);
    // Estando dentro del nodo no se despierta ningún punto: ahí lo que se espera
    // al pulsar es arrastrarlo, no que le brote un vecino.
    this.puntoActivo.set(bajo ? null : (enganche ?? null));
    this.hover.set(bajo?.id ?? enganche?.nodo ?? null);
  }

  protected alSalir(): void {
    this.hover.set(null);
    this.puntoActivo.set(null);
  }

  protected alSoltar(): void {
    if (this.barrido) {
      const caja = cajaEntre(this.barrido.desde, this.barrido.hasta);
      const nueva = this.barrido.sumando ? new Set(this.seleccion()) : new Set<string>();
      for (const n of nodosEnCaja(this.esquema(), caja)) nueva.add(n.id);
      this.seleccion.set(nueva);
      this.barrido = null;
      this.marquesina.set(null);
    }

    this.arrastre = null;
    this.paneo = null;
  }

  /** Píxeles de pantalla por unidad del esquema, con el `meet` ya aplicado. */
  private escala(): number {
    const svg = this.lienzoEl().nativeElement.querySelector('svg');
    if (!svg) return 1;
    const caja = svg.getBoundingClientRect();
    const v = this.vista();
    // `preserveAspectRatio="meet"`: manda el lado que peor encaja.
    return Math.min(caja.width / v.w, caja.height / v.h) || 1;
  }

  protected elegirHerramienta(h: Herramienta): void {
    this.herramienta.set(h);
    this.menuFormas.set(false);
    this.panelColumnas.set(false);
    this.conectandoDesde.set(null);
    this.raton.set(null);
    this.puntoActivo.set(null);
    if (h !== 'seleccionar') this.seleccion.set(new Set());
  }

  /** Centra la vista donde estaba al abrir. La salida de haberse perdido. */
  protected centrar(): void {
    this.vista.set({ ...VISTA });
  }

  protected anadir(forma: FormaNodo): void {
    // En cascada desde el centro de lo que se está viendo —no del esquema—, que
    // es donde el usuario está mirando. Apilarlos todos en el mismo punto
    // obligaría a separarlos a mano antes de poder trabajar.
    const paso = (this.cuantosNodos++ % 8) * ESCALON;
    const v = this.vista();
    const centro = { x: v.x + v.w / 2 - 60 + paso, y: v.y + v.h / 2 - 80 + paso };
    const nodo = crearNodo(this.textoInicial(forma), forma, centro);

    this.esquema.update((e) => ({ ...e, nodos: [...e.nodos, nodo] }));
    this.seleccion.set(new Set([nodo.id]));
    this.herramienta.set('seleccionar');
    this.menuFormas.set(false);
    // Una tabla recién puesta se abre con su lista a la vista: lo siguiente que
    // se va a hacer es escribirle las columnas, y el botón del pie es fácil de
    // no ver la primera vez.
    this.panelColumnas.set(formaDe(forma).columnas === true);
  }

  private textoInicial(forma: FormaNodo): string {
    const def = formaDe(forma);
    return def.ejemplo ?? def.nombre;
  }

  protected cambiarTexto(valor: string): void {
    const id = this.unico();
    if (!id) return;

    this.esquema.update((e) => {
      if (e.nodos.some((n) => n.id === id)) {
        // Por `rehacerNodo` y no cambiando el texto a pelo: al cambiar el texto
        // cambia lo que ocupa, y el nodo tiene que crecer o encogerse con él.
        return { ...e, nodos: e.nodos.map((n) => (n.id === id ? rehacerNodo(n, { texto: valor }) : n)) };
      }
      return {
        ...e,
        conexiones: e.conexiones.map((c) => (c.id === id ? { ...c, texto: valor } : c)),
      };
    });
  }

  protected cambiarForma(forma: FormaNodo): void {
    const id = this.unico();
    if (!id) return;
    this.esquema.update((e) => ({
      ...e,
      nodos: e.nodos.map((n) => (n.id === id ? rehacerNodo(n, { forma }) : n)),
    }));
  }

  protected borrar(): void {
    const ids = this.seleccion();
    if (!ids.size) return;
    this.esquema.update((e) => borrarVarios(e, ids));
    this.seleccion.set(new Set());
    // Si lo borrado era el origen de un trazo a medias, ese trazo ya no lleva a
    // ninguna parte.
    this.conectandoDesde.set(null);
    this.raton.set(null);
  }


  @HostListener('document:keydown', ['$event'])
  protected alTeclear(ev: KeyboardEvent): void {
    // Con el foco en un campo, Supr borra letras. Sería muy desagradable que
    // además se llevara el nodo por delante.
    const dentroDeCampo = (ev.target as HTMLElement)?.closest('input, textarea');
    if (dentroDeCampo) return;

    if (ev.key === 'Delete' || ev.key === 'Backspace') {
      ev.preventDefault();
      this.borrar();
      return;
    }
    if (ev.key === 'Escape') {
      ev.preventDefault();
      /* Escape va soltando de lo más pequeño a lo más grande: primero el trazo a
         medias, luego la selección, y solo entonces cierra. Cerrar de golpe
         perdería el esquema entero por querer cancelar una flecha. */
      if (this.conectandoDesde()) {
        this.conectandoDesde.set(null);
        this.raton.set(null);
      } else if (this.seleccion().size) {
        this.seleccion.set(new Set());
      } else {
        this.cancelar();
      }
    }
  }

  protected guardar(): void {
    this.ref.close(this.esquema());
  }

  protected cancelar(): void {
    this.ref.close(null);
  }
}
