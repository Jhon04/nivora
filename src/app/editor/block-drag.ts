import { Editor, Extension } from '@tiptap/core';
import { Fragment, Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet, EditorView } from '@tiptap/pm/view';

import { NIVEL_MAX, esBloqueLista } from './lista-plana';
import { SLASH_ITEMS } from './slash-command';

/** Marca el bloque recién soltado. El destello va como DECORACIÓN y no como una
 *  clase puesta a mano: ProseMirror reconcilia el DOM y deshace los cambios que
 *  no vengan de su estado, así que la clase desaparecía sola al instante. */
const destelloKey = new PluginKey<DecorationSet>('blockDragDestello');

/**
 * Reordenar bloques arrastrando un handle, SIN usar el drag & drop nativo
 * de HTML5 — que está roto en WebKitGTK (el webview de Tauri en Linux). Se apoya
 * solo en eventos de puntero, así que funciona en cualquier plataforma.
 *
 * El handle hace tres cosas, al estilo Notion:
 *  - Arrastrar: mueve el bloque. La POSICIÓN HORIZONTAL al soltar decide a qué
 *    nivel cae (sacarlo de la lista, dejarlo como hermano o anidarlo).
 *  - Si hay varios bloques seleccionados, arrastra el grupo entero.
 *  - Clic (sin arrastrar): abre el menú del bloque (duplicar, eliminar,
 *    convertir en…).
 */
export const BlockDrag = Extension.create({
  name: 'blockDrag',
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey('blockDrag'),
        view: (view) => new BlockDragView(view, editor),
      }),
      new Plugin({
        key: destelloKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, anterior) {
            const meta = tr.getMeta(destelloKey) as Rango | null | undefined;
            if (meta === null) return DecorationSet.empty;
            if (!meta) return anterior.map(tr.mapping, tr.doc);

            const decoraciones: Decoration[] = [];
            tr.doc.nodesBetween(meta.from, meta.to, (node, pos) => {
              if (pos >= meta.from && pos + node.nodeSize <= meta.to) {
                decoraciones.push(
                  Decoration.node(pos, pos + node.nodeSize, { class: 'block-soltado' }),
                );
                return false; // no hace falta bajar dentro del bloque
              }
              return true;
            });
            return DecorationSet.create(tr.doc, decoraciones);
          },
        },
        props: {
          decorations: (state) => destelloKey.getState(state),
        },
      }),
    ];
  },
});

interface BlockInfo {
  pos: number;
  node: PMNode;
  dom: HTMLElement;
}

/** Rango de bloques que se está moviendo (uno o varios hermanos). */
interface Rango {
  from: number;
  to: number;
}

/** Un sitio donde se puede soltar. */
interface Destino {
  pos: number;
  /** Sangría que tendrán las líneas de lista al caer (null: no son listas). */
  nivel: number | null;
  /** Borde izquierdo de esa sangría: es donde se pinta la línea azul. */
  left: number;
}

/** Movimiento a partir del cual se considera arrastre y no clic. */
const UMBRAL_ARRASTRE = 4;
/** Escalón de sangría de las listas planas, en em (ver styles.scss). */
const SANGRIA_EM = 1.6;
/** Anchura del canalón izquierdo que también activa el handle. */
const ZONA_IZQUIERDA = 60;
/** Cuánto dura el destello azul del bloque recién soltado (ver styles.scss). */
const DESTELLO_MS = 900;
/** Franja junto a cada borde donde el arrastre empieza a desplazar la vista. */
const BORDE_AUTOSCROLL = 64;
/** Píxeles por fotograma pegado al borde (≈ 840 px/s a 60 fps). */
const VELOCIDAD_AUTOSCROLL = 14;

class BlockDragView {
  private readonly handle: HTMLElement;
  private readonly indicator: HTMLElement;
  private menu: HTMLElement | null = null;
  private bloqueMarcado: HTMLElement | null = null;
  /** Copia semitransparente que viaja con el cursor durante el arrastre. */
  private fantasma: HTMLElement | null = null;
  private fantasmaDX = 0;
  private fantasmaDY = 0;
  private atenuados: HTMLElement[] = [];

  private hoverPos: number | null = null;
  private dragging = false;
  private origen: Rango | null = null;
  private destino: Destino | null = null;
  private hideTimer: number | null = null;
  private timerDestello: number | null = null;

  /** Última posición del ratón dentro del editor: el handle vive fuera de él,
   *  así que al pulsarlo hay que resolver el bloque con estas coordenadas. Y al
   *  desplazar hace falta para recolocarlo sin que el ratón se mueva. */
  private puntero: { x: number; y: number } | null = null;
  /** Punto donde se pulsó el handle, para distinguir clic de arrastre. */
  private downX = 0;
  private downY = 0;
  private armado = false;

  /** Contenedor con scroll donde vive el editor, resuelto al empezar a arrastrar. */
  private scroller: HTMLElement | null = null;
  /** Última posición del puntero durante el arrastre. Hace falta guardarla: si
   *  el ratón se queda quieto en el borde no llegan más `mousemove`, pero el
   *  desplazamiento automático sigue y la línea tiene que recalcularse. */
  private raton: { x: number; y: number } | null = null;
  private rafScroll = 0;

  constructor(
    private readonly view: EditorView,
    private readonly editor: Editor,
  ) {
    this.handle = document.createElement('div');
    // Icono de la fuente Material (ya autoalojada): el carácter ⠿ que había
    // antes no existe en Roboto, así que caía en una fuente del sistema con
    // métricas impredecibles y el glifo salía descentrado en su caja.
    this.handle.className = 'block-drag-handle material-icons';
    this.handle.textContent = 'drag_indicator';
    this.handle.setAttribute('aria-label', 'Opciones del bloque o arrastrar para mover');
    this.handle.title =
      'Clic: opciones del bloque\nArrastrar: mover (a la derecha anida, a la izquierda saca)';
    this.handle.style.display = 'none';

    this.indicator = document.createElement('div');
    this.indicator.className = 'block-drop-indicator';
    this.indicator.style.display = 'none';

    document.body.append(this.handle, this.indicator);

    /* El listener va en el documento y no en el editor a propósito: la banda
       sensible tiene que incluir el margen izquierdo, donde vive el propio
       handle. Con el listener en el editor, al mover el ratón hacia el handle
       se salía de él y empezaba a ocultarse (aparecía y desaparecía). */
    document.addEventListener('mousemove', this.onEditorMove, true);
    // `capture` porque `scroll` no burbujea: así se oye el de cualquier
    // contenedor. `passive` porque solo se lee, nunca se cancela.
    document.addEventListener('scroll', this.onScroll, { capture: true, passive: true });
    this.handle.addEventListener('mouseenter', this.clearHideTimer);
    this.handle.addEventListener('mouseleave', this.scheduleHide);
    this.handle.addEventListener('mousedown', this.onHandleDown);
  }

  // --- Hover: mostrar el handle junto al bloque bajo el cursor ---
  private onEditorMove = (e: MouseEvent): void => {
    if (this.dragging || this.menu) return;
    // Sobre el propio handle no se recalcula nada: ya está donde toca.
    if (e.target === this.handle) return;
    this.puntero = { x: e.clientX, y: e.clientY };
    this.situar(false);
  };

  /**
   * Al desplazar, el documento se mueve pero el ratón no, así que **no llega
   * ningún `mousemove`** y el handle se quedaba clavado en la pantalla, ya sin
   * relación con ningún bloque. Y al mover luego el ratón sin salir del mismo
   * bloque, el atajo de «mismo bloque, no recoloco» le impedía volver a su
   * sitio: había que ir a otro bloque para recuperarlo.
   *
   * Se escucha en `document` con captura porque el evento `scroll` **no
   * burbujea**: así vale cualquier contenedor que desplace, sin nombrarlo.
   */
  private onScroll = (): void => {
    if (this.dragging || this.menu || !this.puntero) return;
    this.situar(true);
  };

  /**
   * Coloca el handle junto al bloque que haya bajo la última posición conocida
   * del ratón. `forzar` se salta el atajo del «mismo bloque», que existe para
   * no recolocar en cada píxel al recorrer una línea pero estorba cuando lo que
   * se movió fue el documento.
   */
  private situar(forzar: boolean): void {
    if (!this.puntero) return;
    const { x, y } = this.puntero;
    const er = this.view.dom.getBoundingClientRect();
    /* Basta con estar a la ALTURA de la línea: sirve el texto, el hueco a su
       derecha y el canalón de la izquierda (donde se dibuja el handle). */
    const enBanda =
      y >= er.top && y <= er.bottom && x >= er.left - ZONA_IZQUIERDA && x <= er.right + 8;
    if (!enBanda) {
      this.scheduleHide();
      return;
    }

    /* Fuera del ancho del texto el bloque se resuelve por su ALTURA. Se usa el
       centro de la columna y no el borde: pegado al margen izquierdo se cae en
       la zona de los números, donde posAtCoords devuelve la línea vecina. */
    const dentro = x >= er.left + 6 && x <= er.right - 6;
    const info = this.blockAt(dentro ? x : er.left + er.width / 2, y);
    if (!info) {
      this.scheduleHide();
      return;
    }
    this.clearHideTimer();
    // Si sigue siendo el mismo bloque no se recoloca: evita el parpadeo al
    // recorrer un ítem con el ratón.
    if (!forzar && info.pos === this.hoverPos && this.handle.style.display !== 'none') return;
    this.hoverPos = info.pos;

    const rect = info.dom.getBoundingClientRect();
    this.handle.style.display = 'flex';
    /* Alineado con la primera línea del bloque, que es lo natural en un párrafo
       largo. Pero un bloque más bajo que el propio handle —una línea horizontal
       mide 2 px y este 24— lo dejaría colgando sobre el bloque de abajo, y
       parecería que es el suyo. En ese caso se centra. */
    const alto = this.handle.offsetHeight || 24;
    this.handle.style.top =
      rect.height >= alto
        ? `${rect.top + 1}px`
        : `${rect.top + (rect.height - alto) / 2}px`;
    /* Columna fija en el margen del documento, no relativa al bloque. Los
       números y viñetas viven en el padding de la propia lista, así que
       colocarlo respecto al <li> lo dejaba justo encima de ellos. */
    this.handle.style.left = `${this.view.dom.getBoundingClientRect().left - 28}px`;
  }

  private scheduleHide = (): void => {
    this.clearHideTimer();
    this.hideTimer = window.setTimeout(() => {
      if (this.menu) return;
      this.handle.style.display = 'none';
      this.hoverPos = null;
    }, 150);
  };

  private clearHideTimer = (): void => {
    if (this.hideTimer != null) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  };

  // --- Pulsar el handle: arma el arrastre; si no hay movimiento, es un clic ---
  private onHandleDown = (e: MouseEvent): void => {
    const origen = this.rangoOrigen();
    if (!origen) return;
    e.preventDefault();
    this.cerrarMenu();
    this.origen = origen;
    this.armado = true;
    this.downX = e.clientX;
    this.downY = e.clientY;
    document.addEventListener('mousemove', this.onDragMove, true);
    document.addEventListener('mouseup', this.onDragEnd, true);
    // `passive: false` es imprescindible: sin él el navegador ignora el
    // `preventDefault()` y desplaza además por su cuenta, con lo que la vista
    // se movería el doble.
    document.addEventListener('wheel', this.onDragWheel, { capture: true, passive: false });
  };

  /**
   * Rueda durante el arrastre: desplaza la vista sin soltar el bloque.
   *
   * Es la forma **precisa** de llegar al hueco que se quiere — la franja de los
   * bordes sirve para cruzar de largo, pero afinar con ella es incómodo porque
   * la velocidad depende de lo pegado al borde que esté el ratón. Con la rueda
   * el usuario decide cuánto avanza y para donde quiere.
   */
  private onDragWheel = (e: WheelEvent): void => {
    if (!this.dragging || !this.scroller) return;
    /* Se toma el control en vez de dejar hacer al navegador: durante el
       arrastre, bajo el cursor puede haber cualquier cosa (la barra de
       herramientas, que también desborda), y desplazaría lo que no toca. */
    e.preventDefault();
    this.scroller.scrollTop += this.pasoRueda(e);
    this.repintarDestino();
  };

  /** `deltaY` en píxeles, sea cual sea la unidad que mande el sistema. */
  private pasoRueda(e: WheelEvent): number {
    if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) return e.deltaY * 16;
    if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
      return e.deltaY * (this.scroller?.clientHeight ?? 400);
    }
    return e.deltaY;
  }

  /**
   * Qué se va a mover: la selección de varios bloques si el bloque señalado
   * está dentro de ella; con Shift, el bloque de nivel superior (la lista
   * entera); si no, el bloque bajo el cursor.
   */
  private rangoOrigen(): Rango | null {
    const sel = this.view.state.selection;
    if (!sel.empty && this.hoverPos != null) {
      const rango = sel.$from.blockRange(sel.$to);
      if (
        rango &&
        rango.endIndex - rango.startIndex > 1 &&
        this.hoverPos >= rango.start &&
        this.hoverPos < rango.end
      ) {
        return { from: rango.start, to: rango.end };
      }
    }

    const pos = this.hoverPos;
    if (pos == null) return null;
    const node = this.view.state.doc.nodeAt(pos);
    if (!node) return null;
    return { from: pos, to: pos + node.nodeSize };
  }

  private onDragMove = (e: MouseEvent): void => {
    if (this.armado && !this.dragging) {
      const lejos =
        Math.abs(e.clientX - this.downX) > UMBRAL_ARRASTRE ||
        Math.abs(e.clientY - this.downY) > UMBRAL_ARRASTRE;
      if (!lejos) return;
      this.dragging = true;
      this.handle.classList.add('activo');
      document.body.style.cursor = 'grabbing';
      document.body.style.userSelect = 'none';
      this.crearFantasma(e);
      this.scroller = this.buscarScroller();
      this.raton = { x: e.clientX, y: e.clientY };
      if (!this.rafScroll) this.rafScroll = requestAnimationFrame(this.autoScroll);
    }
    if (!this.dragging) return;

    this.raton = { x: e.clientX, y: e.clientY };
    if (this.fantasma) {
      this.fantasma.style.transform = `translate(${e.clientX + this.fantasmaDX}px, ${
        e.clientY + this.fantasmaDY
      }px)`;
    }
    this.repintarDestino();
  };

  private pararAutoScroll(): void {
    if (this.rafScroll) cancelAnimationFrame(this.rafScroll);
    this.rafScroll = 0;
    this.scroller = null;
    this.raton = null;
  }

  /** Recalcula y repinta la línea de destino con la última posición del ratón. */
  private repintarDestino(): void {
    if (!this.raton) return;
    const plan = this.planSoltar(this.raton.x, this.raton.y);
    this.destino = plan;
    if (!plan) {
      this.indicator.style.display = 'none';
      return;
    }
    this.indicator.style.display = 'block';
    this.indicator.style.left = `${plan.left}px`;
    this.indicator.style.width = `${this.view.dom.getBoundingClientRect().right - plan.left}px`;
    this.indicator.style.top = `${plan.y}px`;
  }

  /**
   * Desplaza solo el contenedor cuando el puntero se acerca a un borde.
   *
   * Sin esto, mover un bloque por debajo de una imagen alta era imposible: el
   * hueco de destino queda fuera de la pantalla y no se puede llevar el ratón
   * hasta él, porque para desplazar habría que soltar el botón.
   *
   * El bucle vive mientras dure el arrastre y no se enciende y apaga al entrar
   * y salir de la franja: así no hay estado que se quede desincronizado, y un
   * fotograma que no desplaza nada no cuesta nada.
   */
  private autoScroll = (): void => {
    if (!this.dragging) {
      this.rafScroll = 0;
      return;
    }
    const paso = this.velocidadScroll();
    if (paso !== 0 && this.scroller) {
      const antes = this.scroller.scrollTop;
      this.scroller.scrollTop += paso;
      // Al llegar al tope deja de moverse: repintar entonces sería trabajo
      // inútil en cada fotograma.
      if (this.scroller.scrollTop !== antes) this.repintarDestino();
    }
    this.rafScroll = requestAnimationFrame(this.autoScroll);
  };

  /** Píxeles a desplazar este fotograma; negativo hacia arriba, 0 si no toca. */
  private velocidadScroll(): number {
    if (!this.scroller || !this.raton) return 0;
    const r = this.scroller.getBoundingClientRect();
    const desdeArriba = this.raton.y - r.top;
    const desdeAbajo = r.bottom - this.raton.y;

    /* Rampa cuadrática: al entrar en la franja apenas se mueve y pegado al
       borde va rápido. Con velocidad constante o se pasa de largo el destino o
       tarda demasiado en cruzar una imagen grande. */
    const rampa = (dentro: number) => {
      const t = Math.min(Math.max(dentro, 0), BORDE_AUTOSCROLL) / BORDE_AUTOSCROLL;
      return Math.max(1, Math.round(t * t * VELOCIDAD_AUTOSCROLL));
    };

    if (desdeArriba < BORDE_AUTOSCROLL) return -rampa(BORDE_AUTOSCROLL - desdeArriba);
    if (desdeAbajo < BORDE_AUTOSCROLL) return rampa(BORDE_AUTOSCROLL - desdeAbajo);
    return 0;
  }

  /**
   * Antecesor con scroll propio del editor. Se busca en vez de fijar la clase
   * del contenedor (`.pane-scroll`) para no atar esta extensión a la plantilla
   * de la app: si mañana el editor se mete en otro sitio, sigue funcionando.
   */
  private buscarScroller(): HTMLElement | null {
    let el = this.view.dom.parentElement;
    while (el && el !== document.body) {
      const desborde = getComputedStyle(el).overflowY;
      if (
        (desborde === 'auto' || desborde === 'scroll') &&
        el.scrollHeight > el.clientHeight + 1
      ) {
        return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  private onDragEnd = (e: MouseEvent): void => {
    document.removeEventListener('mousemove', this.onDragMove, true);
    document.removeEventListener('mouseup', this.onDragEnd, true);
    document.removeEventListener('wheel', this.onDragWheel, true);
    this.pararAutoScroll();
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    this.indicator.style.display = 'none';
    this.handle.classList.remove('activo');
    this.quitarFantasma();

    const arrastraba = this.dragging;
    const origen = this.origen;
    const destino = this.destino;
    this.dragging = false;
    this.armado = false;
    this.origen = null;
    this.destino = null;

    if (!arrastraba) {
      // No se movió: fue un clic → menú del bloque.
      this.abrirMenu(e);
      return;
    }
    this.scheduleHide();
    if (origen && destino) this.mover(origen, destino);
  };

  /**
   * Copia semitransparente de lo que se arrastra, que sigue al cursor, y el
   * original atenuado en su sitio: da la sensación de estar llevándose el
   * bloque en vez de mover solo una línea.
   */
  private crearFantasma(e: MouseEvent): void {
    if (!this.origen) return;
    const doc = this.view.state.doc;
    const g = document.createElement('div');
    /* Lleva también la clase ProseMirror para que los estilos del contenido
       (títulos, listas, marcas…) se le apliquen fuera del editor. */
    g.className = 'block-drag-ghost ProseMirror';

    let pos = this.origen.from;
    let ancho = 0;
    let primero: DOMRect | null = null;
    while (pos < this.origen.to) {
      const node = doc.nodeAt(pos);
      if (!node) break;
      const dom = this.view.nodeDOM(pos);
      if (dom instanceof HTMLElement) {
        const r = dom.getBoundingClientRect();
        primero ??= r;
        ancho = Math.max(ancho, r.width);
        g.appendChild(clonarBloque(dom));
        dom.classList.add('block-arrastrando');
        this.atenuados.push(dom);
      }
      pos += node.nodeSize;
    }
    if (!g.childElementCount) return;

    if (ancho) g.style.width = `${ancho}px`;
    /* Se agarra por donde estaba: el bloque mantiene su posición relativa al
       cursor, como si lo hubieras levantado. Si no se pudo medir el original
       (algún nodo sin DOM), cuelga del cursor y ya. */
    this.fantasmaDX = primero ? primero.left - e.clientX : 12;
    this.fantasmaDY = primero ? primero.top - e.clientY : 12;
    g.style.transform = `translate(${e.clientX + this.fantasmaDX}px, ${
      e.clientY + this.fantasmaDY
    }px)`;
    document.body.appendChild(g);
    // Si no cabe entero, se difumina el corte inferior (ver .recortado).
    if (g.scrollHeight > g.clientHeight + 1) g.classList.add('recortado');
    this.fantasma = g;
  }

  private quitarFantasma(): void {
    this.fantasma?.remove();
    this.fantasma = null;
    for (const dom of this.atenuados) dom.classList.remove('block-arrastrando');
    this.atenuados = [];
  }

  // --- Dónde se puede soltar ---
  /**
   * Sitio de destino para (x, y). La Y elige el hueco entre bloques; la X
   * elige la SANGRÍA con la que caerán las líneas de lista: a la derecha se
   * anidan, a la izquierda salen. Es el Tab, pero durante el arrastre.
   */
  private planSoltar(x: number, y: number): (Destino & { y: number }) | null {
    if (!this.origen) return null;

    const er = this.view.dom.getBoundingClientRect();
    const cx = Math.min(Math.max(x, er.left + 6), er.right - 6);
    const cy = Math.min(Math.max(y, er.top + 6), er.bottom - 6);
    const bloque = this.blockAt(cx, cy);
    if (!bloque) return null;

    const rect = bloque.dom.getBoundingClientRect();
    const antes = cy < rect.top + rect.height / 2;
    const pos = antes ? bloque.pos : bloque.pos + bloque.node.nodeSize;

    /* Justo antes o justo después de lo que se mueve el documento queda igual:
       son huecos muertos y no se ofrece línea. */
    if (pos >= this.origen.from && pos <= this.origen.to) return null;

    const nivel = this.nivelPorX(x, pos);
    return {
      pos,
      nivel,
      left: er.left + (nivel ?? 0) * this.sangria(),
      y: this.yDelHueco(pos),
    };
  }

  /** Ancho en píxeles de un escalón de sangría (1,6em del editor). */
  private sangria(): number {
    const fuente = parseFloat(getComputedStyle(this.view.dom).fontSize) || 16;
    return fuente * SANGRIA_EM;
  }

  /**
   * Sangría que corresponde a la x del cursor, recortada a lo que permite el
   * bloque anterior (no se puede saltar más de un escalón). Devuelve null si lo
   * que se arrastra no son líneas de lista: un párrafo no se sangra.
   */
  private nivelPorX(x: number, pos: number): number | null {
    if (!this.origen) return null;
    const doc = this.view.state.doc;
    const contenido = doc.slice(this.origen.from, this.origen.to).content;
    let hayLista = false;
    contenido.forEach((n) => {
      if (esBloqueLista(n)) hayLista = true;
    });
    if (!hayLista) return null;

    const er = this.view.dom.getBoundingClientRect();
    const pedido = Math.round((x - er.left) / this.sangria());
    const anterior = doc.resolve(pos).nodeBefore;
    const tope = esBloqueLista(anterior) ? (anterior?.attrs['nivel'] ?? 0) + 1 : 0;
    return Math.max(0, Math.min(Math.min(pedido, tope), NIVEL_MAX));
  }

  /**
   * Altura a la que se pinta la línea: el centro del hueco entre los dos
   * bloques que rodean la posición de inserción.
   *
   * Se calcula desde la POSICIÓN y no desde el bloque señalado a propósito.
   * "Después de la fila 1" y "antes de la fila 2" son la misma posición en el
   * documento; si se dibujara en el borde del bloque saldrían dos líneas
   * distintas para un único hueco, y no se sabe cuál es cuál.
   */
  private yDelHueco(pos: number): number {
    const $ins = this.view.state.doc.resolve(pos);
    const anterior = $ins.nodeBefore;
    const siguiente = $ins.nodeAfter;

    const domAnterior = anterior ? this.view.nodeDOM(pos - anterior.nodeSize) : null;
    const domSiguiente = siguiente ? this.view.nodeDOM(pos) : null;
    const abajo =
      domAnterior instanceof HTMLElement ? domAnterior.getBoundingClientRect().bottom : null;
    const arriba =
      domSiguiente instanceof HTMLElement ? domSiguiente.getBoundingClientRect().top : null;

    if (abajo != null && arriba != null) return (abajo + arriba) / 2;
    return abajo ?? arriba ?? 0;
  }

  // --- Utilidades de posición ---
  /**
   * Bloque bajo (x, y). Con las listas planas todos los bloques son hermanos de
   * nivel superior, así que no hay que elegir entre el ítem y la lista que lo
   * contiene: solo hay un objetivo posible.
   */
  private blockAt(x: number, y: number): BlockInfo | null {
    const posInfo = this.view.posAtCoords({ left: x, top: y });
    if (!posInfo) return null;

    const doc = this.view.state.doc;
    const $pos = doc.resolve(posInfo.pos);
    let pos: number;
    if ($pos.depth > 0) {
      pos = $pos.before(1);
    } else if (posInfo.inside >= 0) {
      /* Un nodo `atom` de primer nivel —imagen, bloque cifrado, línea
         horizontal— no tiene contenido dentro del que resolver, así que
         `posAtCoords` devuelve una posición del propio documento (profundidad
         0) en vez de una interior. Ahí el bloque es el que señala `inside`.
         Sin esto esos bloques se quedaban SIN handle y no había forma de
         moverlos. */
      const $dentro = doc.resolve(posInfo.inside);
      pos = $dentro.depth > 0 ? $dentro.before(1) : posInfo.inside;
    } else {
      /* El punto cayó en el HUECO entre dos bloques: los párrafos llevan margen
         y ahí no hay nada. `posAtCoords` devuelve entonces una posición del
         documento sin nodo dentro (`inside === -1`), y devolver null hacía
         desaparecer el handle al pasar por cualquier separación — se notaba
         sobre todo al desplazar, cuando el ratón se queda quieto justo ahí.
         Se elige el bloque vecino más cercano. */
      const i = $pos.index();
      const vecino = this.vecinoMasCercano(y, [
        i > 0 ? $pos.posAtIndex(i - 1) : null,
        i < doc.childCount ? $pos.posAtIndex(i) : null,
      ]);
      if (vecino == null) return null;
      pos = vecino;
    }

    const node = this.view.state.doc.nodeAt(pos);
    const dom = this.view.nodeDOM(pos);
    if (!node || !(dom instanceof HTMLElement)) return null;
    return { pos, node, dom };
  }

  /** De las posiciones dadas, la del bloque cuya caja está más cerca de `y`. */
  private vecinoMasCercano(y: number, posiciones: (number | null)[]): number | null {
    let mejor: number | null = null;
    let cerca = Infinity;
    for (const p of posiciones) {
      if (p == null) continue;
      const dom = this.view.nodeDOM(p);
      if (!(dom instanceof HTMLElement)) continue;
      const r = dom.getBoundingClientRect();
      const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
      if (d < cerca) {
        cerca = d;
        mejor = p;
      }
    }
    return mejor;
  }

  private mover(origen: Rango, destino: Destino): void {
    const { state } = this.view;
    // Soltar dentro de lo que se está moviendo no hace nada.
    if (destino.pos > origen.from && destino.pos < origen.to) return;
    let contenido = state.doc.slice(origen.from, origen.to).content;
    if (!contenido.childCount) return;

    /* La sangría que marcó el cursor se aplica a las líneas de lista, y las que
       venían más adentro conservan su desnivel relativo. */
    if (destino.nivel != null) {
      let base: number | null = null;
      contenido.forEach((n) => {
        if (esBloqueLista(n) && base == null) base = n.attrs['nivel'];
      });
      const salto = destino.nivel - (base ?? 0);
      if (salto !== 0) {
        const hijos: PMNode[] = [];
        contenido.forEach((n) => {
          hijos.push(
            esBloqueLista(n)
              ? n.type.create(
                  { ...n.attrs, nivel: Math.max(0, Math.min(NIVEL_MAX, n.attrs['nivel'] + salto)) },
                  n.content,
                  n.marks,
                )
              : n,
          );
        });
        contenido = Fragment.fromArray(hijos);
      }
    }

    try {
      let tr = state.tr.delete(origen.from, origen.to);
      const pos = tr.mapping.map(destino.pos);
      // Revalidar contra el documento ya sin el origen.
      const $ins = tr.doc.resolve(pos);
      const idx = $ins.index();
      if (!$ins.parent.canReplace(idx, idx, contenido)) return;
      tr = tr.insert(pos, contenido);
      tr.setMeta(destelloKey, { from: pos, to: pos + contenido.size });
      this.view.dispatch(tr.scrollIntoView());
      this.programarFinDestello();
    } catch {
      /* movimiento inválido (contexto incompatible): se ignora */
    }
  }

  /**
   * Quita el destello pasado un rato. Tiñe de azul un momento lo que se acaba
   * de soltar: tras un arrastre no siempre es evidente dónde ha caído el
   * bloque, y menos si cambió de sangría o si se movieron varios a la vez.
   */
  private programarFinDestello(): void {
    if (this.timerDestello != null) clearTimeout(this.timerDestello);
    this.timerDestello = window.setTimeout(() => {
      this.timerDestello = null;
      this.view.dispatch(this.view.state.tr.setMeta(destelloKey, null));
    }, DESTELLO_MS);
  }

  // --- Menú del bloque (clic en el handle) ---
  private abrirMenu(e: MouseEvent): void {
    if (this.hoverPos == null) return;
    const pos = this.hoverPos;
    const node = this.view.state.doc.nodeAt(pos);
    if (!node) return;

    const menu = document.createElement('div');
    menu.className = 'menu-titulos block-menu';

    menu.append(
      this.opcion('content_copy', 'Duplicar', () => this.duplicar(pos)),
      this.opcion('delete', 'Eliminar', () => this.eliminar(pos)),
      separador(),
      etiqueta('Convertir en'),
    );
    // Se reutilizan las entradas del menú "/" para no duplicar la lista de
    // tipos de bloque, quitando las que insertan algo nuevo (divisor, imagen):
    // aquí se trata de CONVERTIR el bloque, no de añadir otro.
    for (const item of SLASH_ITEMS.filter((i) => !i.insercion)) {
      menu.append(
        this.opcion(item.icon, item.title, () => {
          const dentro = pos + 1;
          this.editor.chain().focus().setTextSelection(dentro).run();
          item.command({ editor: this.editor, range: { from: dentro, to: dentro } });
        }),
      );
    }

    document.body.appendChild(menu);
    this.menu = menu;

    // Deja claro a qué bloque se aplica.
    const dom = this.view.nodeDOM(pos);
    if (dom instanceof HTMLElement) {
      dom.classList.add('block-activo');
      this.bloqueMarcado = dom;
    }

    // Junto al handle, y sin salirse por abajo.
    const h = this.handle.getBoundingClientRect();
    const alto = menu.offsetHeight;
    menu.style.position = 'fixed';
    menu.style.zIndex = '60';
    menu.style.left = `${h.right + 6}px`;
    menu.style.top = `${Math.max(8, Math.min(h.top, window.innerHeight - alto - 8))}px`;

    e.stopPropagation();
    document.addEventListener('mousedown', this.onClicFuera, true);
    document.addEventListener('keydown', this.onTeclaMenu, true);
  }

  private opcion(icono: string, texto: string, accion: () => void): HTMLElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'menu-item';
    const i = document.createElement('span');
    // Los iconos del menú "/" son texto (¶, H1, •…); los propios, ligaduras.
    i.className = /^[a-z_]+$/.test(icono) ? 'menu-ico material-icons' : 'menu-ico ico-txt';
    i.textContent = icono;
    const t = document.createElement('span');
    t.className = 'menu-txt';
    t.textContent = texto;
    b.append(i, t);
    b.addEventListener('click', () => {
      this.cerrarMenu();
      accion();
    });
    return b;
  }

  private onClicFuera = (e: MouseEvent): void => {
    if (this.menu && !this.menu.contains(e.target as Node)) this.cerrarMenu();
  };

  private onTeclaMenu = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.cerrarMenu();
    }
  };

  private cerrarMenu(): void {
    document.removeEventListener('mousedown', this.onClicFuera, true);
    document.removeEventListener('keydown', this.onTeclaMenu, true);
    this.bloqueMarcado?.classList.remove('block-activo');
    this.bloqueMarcado = null;
    this.menu?.remove();
    this.menu = null;
    this.scheduleHide();
  }

  private duplicar(pos: number): void {
    const { state } = this.view;
    const node = state.doc.nodeAt(pos);
    if (!node) return;
    this.view.dispatch(state.tr.insert(pos + node.nodeSize, node).scrollIntoView());
  }

  private eliminar(pos: number): void {
    const { state } = this.view;
    const node = state.doc.nodeAt(pos);
    if (!node) return;
    this.view.dispatch(state.tr.delete(pos, pos + node.nodeSize));
  }

  destroy(): void {
    this.clearHideTimer();
    if (this.timerDestello != null) clearTimeout(this.timerDestello);
    this.dragging = false;
    this.pararAutoScroll();
    this.cerrarMenu();
    this.quitarFantasma();
    document.removeEventListener('mousemove', this.onEditorMove, true);
    document.removeEventListener('scroll', this.onScroll, true);
    document.removeEventListener('mousemove', this.onDragMove, true);
    document.removeEventListener('mouseup', this.onDragEnd, true);
    document.removeEventListener('wheel', this.onDragWheel, true);
    this.handle.remove();
    this.indicator.remove();
  }
}

/**
 * Copia de un bloque para el fantasma. Un <li> suelto pierde su viñeta o
 * número, así que se reenvuelve en una lista del mismo tipo (y con el mismo
 * `start`, para que el número que se ve sea el real).
 */
function clonarBloque(dom: HTMLElement): HTMLElement {
  const clon = dom.cloneNode(true) as HTMLElement;
  if (dom.tagName !== 'LI') return clon;

  const lista = dom.parentElement;
  const envoltura = document.createElement(lista?.tagName ?? 'ul');
  if (lista) {
    envoltura.className = lista.className;
    const tipo = lista.getAttribute('data-type');
    if (tipo) envoltura.setAttribute('data-type', tipo);
    const idx = Array.prototype.indexOf.call(lista.children, dom);
    if (envoltura.tagName === 'OL' && idx > 0) envoltura.setAttribute('start', String(idx + 1));
  }
  envoltura.appendChild(clon);
  return envoltura;
}



function separador(): HTMLElement {
  const s = document.createElement('div');
  s.className = 'menu-sep';
  return s;
}

function etiqueta(texto: string): HTMLElement {
  const l = document.createElement('div');
  l.className = 'menu-etiqueta';
  l.textContent = texto;
  return l;
}
