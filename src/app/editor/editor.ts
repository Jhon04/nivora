import {
  Component,
  ElementRef,
  effect,
  HostListener,
  inject,
  input,
  OnDestroy,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Editor, JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import TextAlign from '@tiptap/extension-text-align';
import { TextStyle } from '@tiptap/extension-text-style';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { ResolvedPos } from '@tiptap/pm/model';
import { Selection, TextSelection } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';
import { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion';
import { MatDialog } from '@angular/material/dialog';
import { open } from '@tauri-apps/plugin-dialog';
import { open as abrirEnSistema } from '@tauri-apps/plugin-shell';
import { ConnectedPosition, OverlayModule } from '@angular/cdk/overlay';
import { TiptapBubbleMenuDirective, TiptapEditorDirective } from 'ngx-tiptap';
import { firstValueFrom } from 'rxjs';

import { AssetGuardado, AssetsService } from '../core/assets.service';
import { resolverSrc } from '../core/asset-path';
import { AnotarDatos, AnotarImagenDialog, AnotarResultado } from './anotar-imagen';
import { AssetImage } from './asset-image';
import { CodeBlockCopia } from './code-block-copia';
import { BlockDrag } from './block-drag';
import { BloqueLista, TipoLista } from './lista-plana';
import { ColorAdaptable, ResaltadoAdaptable } from './color-adaptable';
import { EntradaIndice, extraerIndice } from './indice';
import {
  createSlashCommand,
  EVENTO_IMAGEN,
  EVENTO_SECRETO,
  EVENTO_SECRETO_ABIERTO,
  EVENTO_SECRETO_ABRIR,
  SlashItem,
} from './slash-command';
import { PeticionSecreto, Secreto } from './secreto';
import { SecretosService } from '../core/secretos.service';
import { SecretoDatos, SecretoDialog, SecretoResultado } from '../shared/secreto-dialog';

/** Documento Tiptap vacío (un párrafo). */
const DOC_VACIO: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] };

/** Lee un Blob y devuelve solo su parte base64 (sin el prefijo data:). */
function blobABase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = reader.result as string;
      resolve(s.slice(s.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * Formatos que se insertan sin pasar por el editor de imagen. Editar significa
 * rasterizar: un SVG perdería su condición de vectorial y un GIF animado se
 * quedaría en su primer fotograma. Antes que romperlos en silencio, se insertan
 * tal cual.
 */
const SIN_EDITOR = ['svg', 'svg+xml', 'gif'];

/** Tipo MIME a partir de la extensión (para reconstruir el blob de la imagen). */
function mimeDe(ext: string): string {
  if (ext === 'jpg') return 'image/jpeg';
  if (ext === 'svg') return 'image/svg+xml';
  return `image/${ext}`;
}

/** Base64 → Blob, sin pasar por una data: URL gigante. */
function base64ABlob(base64: string, ext: string): Blob {
  const binario = atob(base64);
  const bytes = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i);
  return new Blob([bytes], { type: mimeDe(ext) });
}

/**
 * Posición resuelta **justo antes** de la celda donde está la selección, que es
 * lo que espera `CellSelection`. `null` si no se está dentro de una tabla.
 */
function celdaDe(seleccion: Selection): ResolvedPos | null {
  if (seleccion instanceof CellSelection) return seleccion.$anchorCell;
  const $desde = seleccion.$from;
  for (let d = $desde.depth; d > 0; d--) {
    const rol = $desde.node(d).type.spec['tableRole'];
    if (rol === 'cell' || rol === 'header_cell') return $desde.doc.resolve($desde.before(d));
  }
  return null;
}

interface SlashPos {
  left: number;
  top: number;
  arriba: boolean;
}

/**
 * Margen desde el borde superior del área con scroll a partir del cual se
 * considera que una sección ya ha pasado. Sin holgura, el título que acaba de
 * quedar justo en el borde parpadea entre activo y no activo al desplazarse.
 */
const HOLGURA_ACTIVO = 24;

/** Aire que se deja por encima del título al saltar, para que se vea que empieza. */
const MARGEN_SALTO = 20;

/**
 * Cuánto se da por durado un salto. Mientras tanto no se recalcula la sección
 * activa: ya se sabe cuál es, y medir el DOM en cada fotograma de la animación
 * puede llegar a cortarla.
 */
const DURACION_SALTO = 700;

@Component({
  selector: 'app-editor',
  imports: [TiptapEditorDirective, TiptapBubbleMenuDirective, OverlayModule],
  templateUrl: './editor.html',
  styleUrl: './editor.scss',
})
export class EditorComponent implements OnDestroy {
  /** Contenido a mostrar (JSON de Tiptap). Al cambiar, recarga el editor. */
  readonly content = input<JSONContent | null>(null);
  /** Emite el JSON del documento cada vez que el usuario edita. */
  readonly contentChange = output<JSONContent>();
  /**
   * `false` en las bóvedas de solo lectura (cuadernos que alguien comparte
   * contigo sin permiso de escritura). Se apaga en el propio ProseMirror y no
   * solo en la UI: si únicamente se ocultaran los botones, seguirían entrando
   * cambios por teclado, pegado o el menú «/».
   */
  readonly editable = input(true);

  protected readonly bubbleOptions = { placement: 'top' as const };
  /* Abajo, para no taparse con el menú de texto cuando se selecciona dentro de
     una celda: ahí se ven los dos, uno a cada lado. */
  protected readonly tablaOptions = { placement: 'bottom' as const };
  /**
   * La barra de tabla sale con el **cursor** dentro, sin tener que seleccionar
   * nada: las acciones son de fila y columna, no del texto elegido.
   */
  protected readonly enTabla = (): boolean => this.editor.isActive('table');
  /* Desplegables de fila y de columna. Agrupar sus seis acciones deja la barra
     corta: con todas sueltas ocupaba media pantalla y había que leerlas para
     distinguir «✕ fila» de «✕ col». */
  protected readonly menuFila = signal(false);
  protected readonly menuCol = signal(false);
  /** Mismas posiciones que los desplegables del toolbar, para que caigan igual. */
  protected readonly posicionesMenu: ConnectedPosition[] = [
    { originX: 'start', originY: 'bottom', overlayX: 'start', overlayY: 'top', offsetY: 6 },
    { originX: 'start', originY: 'top', overlayX: 'start', overlayY: 'bottom', offsetY: -6 },
    { originX: 'end', originY: 'bottom', overlayX: 'end', overlayY: 'top', offsetY: 6 },
    { originX: 'end', originY: 'top', overlayX: 'end', overlayY: 'bottom', offsetY: -6 },
  ];

  // --- Estado del slash menu (/) ---
  protected readonly slashOpen = signal(false);
  protected readonly slashItems = signal<SlashItem[]>([]);
  protected readonly slashIndex = signal(0);
  protected readonly slashPos = signal<SlashPos>({ left: 0, top: 0, arriba: false });
  private slashSelect: ((item: SlashItem) => void) | null = null;
  private readonly menuSlash = viewChild<ElementRef<HTMLElement>>('menuSlash');

  // --- Índice de la nota (panel de títulos) ---
  /** Títulos de la nota, en orden. Se rehace en cada cambio del documento. */
  readonly indice = signal<EntradaIndice[]>([]);
  /**
   * Cuál de las entradas del índice se resalta, **por su orden en la lista** y
   * no por su posición en el documento: escribir dentro de una sección desplaza
   * todas las posiciones que hay por debajo, así que guardar un `pos` obligaría
   * a medir el DOM en cada tecla para saber si sigue siendo el mismo título.
   */
  readonly tituloActivo = signal(0);
  /** Contenedor con scroll donde vive el editor (ver `contenedorDeScroll`). */
  private contenedorScroll: HTMLElement | null = null;
  private recalculoPedido = false;
  /** Hasta cuándo hay un salto en curso (ver `alScroll`). */
  private finDelSalto = 0;

  /** URL del original a tamaño completo en el visor (lightbox), o null. */
  protected readonly lightbox = signal<string | null>(null);
  /** Aumento del visor (1 = imagen entera) y cuánto se ha desplazado. */
  protected readonly zoom = signal(1);
  protected readonly desp = signal<{ x: number; y: number }>({ x: 0, y: 0 });
  /** Se acaba de arrastrar: el clic que viene no debe cerrar el visor. */
  private arrastrado = false;

  private readonly visorEl = viewChild<ElementRef<HTMLElement>>('visor');
  private readonly visorImgEl = viewChild<ElementRef<HTMLImageElement>>('visorImg');

  /** Última versión emitida, para no reiniciar el cursor con nuestro propio eco. */
  private ultimoEmitido = '';

  private readonly assets = inject(AssetsService);
  private readonly secretos = inject(SecretosService);
  private readonly dialog = inject(MatDialog);

  readonly editor: Editor;

  constructor() {
    this.editor = new Editor({
      extensions: [
        StarterKit.configure({
          dropcursor: { color: '#3b82f6', width: 3 },
          // openOnClick:false → en el webview de Tauri un clic no debe navegar
          // (reemplazaría la app). autolink → enlaza URLs al escribirlas.
          // El clic con Ctrl/Cmd lo abre en el navegador (ver handleClick).
          link: {
            openOnClick: false,
            autolink: true,
            HTMLAttributes: { title: 'Ctrl+clic para abrir' },
          },
          // Usamos nuestro bloque de código con botón "Copiar".
          codeBlock: false,
          // Títulos H1–H4 (el toolbar ofrece esos cuatro niveles).
          heading: { levels: [1, 2, 3, 4] },
          /* Fuera el esquema de listas anidadas: las nuestras son bloques
             planos (ver lista-plana.ts). */
          bulletList: false,
          orderedList: false,
          listItem: false,
          listKeymap: false,
        }),
        CodeBlockCopia,
        Placeholder.configure({
          placeholder: 'Escribe "/" para insertar un bloque, o simplemente escribe…',
        }),
        BloqueLista,
        TextAlign.configure({ types: ['heading', 'paragraph'] }),
        TextStyle,
        ColorAdaptable,
        ResaltadoAdaptable.configure({ multicolor: true }),
        Secreto,
        AssetImage,
        /* Tabla. `resizable` añade el tirador entre columnas y guarda el ancho
           en `colwidth`; sin él la tabla reparte a partes iguales y no hay forma
           de ajustar una columna estrecha (fechas, importes).
           Ojo: con `resizable` el nodo lo pinta `TableView`, que construye su
           propio DOM (`div.tableWrapper > table`) e **ignora `HTMLAttributes`**.
           Por eso los estilos cuelgan de `.tableWrapper` y no de una clase
           nuestra, que nunca llegaría al elemento. */
        Table.configure({ resizable: true }),
        TableRow,
        TableHeader,
        TableCell,
        BlockDrag,
        createSlashCommand(() => ({
          onStart: (props) => this.slashStart(props),
          onUpdate: (props) => this.slashStart(props),
          onKeyDown: (props) => this.slashKeyDown(props),
          onExit: () => this.slashOpen.set(false),
        })),
      ],
      content: DOC_VACIO,
      editorProps: {
        handlePaste: (_view, event) => {
          const dt = event.clipboardData;
          if (!dt) return false;

          // 1) Imagen como bytes (captura de pantalla, "copiar imagen").
          for (let i = 0; i < dt.items.length; i++) {
            const item = dt.items[i];
            if (item.type.startsWith('image/')) {
              const file = item.getAsFile();
              if (file) {
                event.preventDefault();
                void this.pegarImagenBytes(file);
                return true;
              }
            }
          }

          // 2) Fichero de imagen copiado que sí trae bytes.
          for (let i = 0; i < dt.files.length; i++) {
            if (dt.files[i].type.startsWith('image/')) {
              event.preventDefault();
              void this.pegarImagenBytes(dt.files[i]);
              return true;
            }
          }

          // 3) Ruta/URI a un fichero de imagen (copiado desde el explorador):
          //    que Rust lo lea del disco.
          const ruta = this.rutaImagenLocal(
            dt.getData('text/uri-list') || dt.getData('text/plain'),
          );
          if (ruta) {
            event.preventDefault();
            void this.pegarImagenDesdeRuta(ruta);
            return true;
          }

          return false;
        },
        // Ctrl/Cmd + clic sobre un enlace → abrirlo en el navegador del sistema.
        handleClick: (_view, _pos, event) => {
          if (!(event.ctrlKey || event.metaKey)) return false;
          const enlace = (event.target as HTMLElement | null)?.closest('a');
          const href = enlace?.getAttribute('href');
          if (href) {
            event.preventDefault();
            void abrirEnSistema(href).catch((e) =>
              console.error('No se pudo abrir el enlace:', e),
            );
            return true;
          }
          return false;
        },
        // Doble clic en una imagen → abrir el original a tamaño completo.
        handleDoubleClickOn: (_view, _pos, node) => {
          if (node.type.name === 'image') {
            const src = node.attrs['src'] as string | undefined;
            if (src) {
              this.abrirLightbox(src);
              return true;
            }
          }
          return false;
        },
      },
      onUpdate: ({ editor }) => {
        const json = editor.getJSON();
        this.ultimoEmitido = JSON.stringify(json);
        this.contentChange.emit(json);
        this.actualizarIndice();
      },
    });

    /* La entrada "Imagen" del menú "/" avisa por el DOM: elegir el fichero es
       cosa del componente (diálogo nativo + pantalla de edición), no de una
       extensión de Tiptap. El listener se va con el editor al destruirlo. */
    this.editor.view.dom.addEventListener(EVENTO_IMAGEN, () => void this.elegirImagen());

    // El NodeView del bloque secreto no puede inyectar servicios: se le deja
    // aquí la función de descifrado, que va a Rust (la clave nunca sale de allí),
    // y una forma de saber si el candado está abierto — con eso distingue «se
    // cerró por inactividad» de un error de verdad y ofrece la salida adecuada.
    (this.editor.storage as unknown as Record<string, unknown>)['secreto'] = {
      descifrar: (datos: string) => this.secretos.descifrar(datos),
      desbloqueado: () => this.secretos.desbloqueado(),
    };
    this.editor.view.dom.addEventListener(EVENTO_SECRETO, (ev) =>
      void this.abrirSecreto((ev as CustomEvent<PeticionSecreto>).detail),
    );
    this.editor.view.dom.addEventListener(EVENTO_SECRETO_ABRIR, () => void this.desbloquear());

    // Cargar contenido solo cuando llega de fuera (abrir otro documento),
    // nunca como eco de la edición en curso: eso reiniciaría el cursor.
    effect(() => {
      const entrante = JSON.stringify(this.content() ?? DOC_VACIO);
      if (entrante === this.ultimoEmitido) return;
      if (entrante === JSON.stringify(this.editor.getJSON())) return;
      try {
        this.editor.commands.setContent(this.content() ?? DOC_VACIO, { emitUpdate: false });
      } catch {
        this.editor.commands.setContent(DOC_VACIO, { emitUpdate: false });
      }
      // `emitUpdate: false` deja fuera a `onUpdate`, así que el índice de la
      // nota que se acaba de abrir hay que rehacerlo aquí. Y se empieza por
      // arriba, que es donde queda el documento al abrirlo.
      this.tituloActivo.set(0);
      this.actualizarIndice();
    });

    /* Bóvedas de solo lectura: se apaga ProseMirror entero. Ocultar botones no
       basta — el teclado, el pegado y el menú «/» seguirían editando.

       `setEditable` **emite `update` de forma síncrona**, así que lo que cuelgue
       de `onUpdate` acaba ejecutándose aquí dentro, en pleno contexto reactivo.
       El `untracked` corta eso: sin él, este efecto se suscribía a las señales
       que lee el índice —que él mismo termina escribiendo— y se redisparaba sin
       parar hasta bloquear la aplicación. */
    effect(() => {
      const editable = this.editable();
      untracked(() => this.editor.setEditable(editable));
    });
  }

  // --- Slash menu ---
  private slashStart(props: SuggestionProps<SlashItem, SlashItem>): void {
    this.slashItems.set(props.items);
    this.slashIndex.set(0);
    this.slashSelect = props.command;
    /* Al filtrar, la selección vuelve a la primera entrada: si el usuario había
       bajado, el menú se quedaba desplazado y la entrada elegida no se veía. */
    const menu = this.menuSlash()?.nativeElement;
    if (menu) menu.scrollTop = 0;

    const rect = props.clientRect?.();
    if (rect) {
      const espacioAbajo = window.innerHeight - rect.bottom;
      const arriba = espacioAbajo < 320 && rect.top > espacioAbajo;
      this.slashPos.set({
        left: rect.left,
        top: arriba ? rect.top - 6 : rect.bottom + 6,
        arriba,
      });
    }
    this.slashOpen.set(props.items.length > 0);
  }

  private slashKeyDown(props: SuggestionKeyDownProps): boolean {
    if (!this.slashOpen()) return false;
    switch (props.event.key) {
      case 'ArrowDown':
        this.slashMove(1);
        return true;
      case 'ArrowUp':
        this.slashMove(-1);
        return true;
      case 'Enter':
        if (this.slashItems().length === 0) return false;
        this.slashPick(this.slashIndex());
        return true;
      case 'Escape':
        this.slashOpen.set(false);
        return true;
      default:
        return false;
    }
  }

  protected slashMove(delta: number): void {
    const n = this.slashItems().length;
    if (n === 0) return;
    const i = (this.slashIndex() + delta + n) % n;
    this.slashIndex.set(i);
    this.verEntradaSlash(i);
  }

  /**
   * Trae a la vista la entrada elegida con el teclado.
   *
   * El menú tiene altura máxima y desborda, así que sin esto se podía seguir
   * bajando con las flechas hasta una entrada **que no se veía**: se estaba
   * seleccionando a ciegas.
   *
   * No hace falta esperar a que Angular repinte: los botones ya existen y las
   * flechas solo cambian de sitio la clase `.sel`. Y `block: 'nearest'` desplaza
   * lo mínimo, así que al recorrer la lista no da saltos ni recentra a cada
   * paso; al dar la vuelta del último al primero, salta arriba del todo.
   */
  private verEntradaSlash(i: number): void {
    this.menuSlash()?.nativeElement.children[i]?.scrollIntoView({ block: 'nearest' });
  }

  protected slashPick(i: number): void {
    const item = this.slashItems()[i];
    if (item && this.slashSelect) this.slashSelect(item);
  }

  // --- Índice de la nota ---
  /**
   * Rehace la lista de títulos. Es un recorrido del documento, así que se llama
   * en cada cambio; lo caro (medir el DOM para saber qué sección se está
   * mirando) se deja para cuando de verdad cambia el número de títulos: teclear
   * dentro de una sección no altera el orden de las entradas.
   */
  private actualizarIndice(): void {
    /* `untracked` porque esto cuelga de `onUpdate`, y Tiptap emite ese evento de
       forma síncrona desde comandos que sí se llaman dentro de efectos. Sin él,
       el efecto de turno quedaría suscrito a `indice` —que aquí se escribe— y se
       redispararía en bucle. */
    untracked(() => {
      const antes = this.indice().length;
      this.indice.set(extraerIndice(this.editor.state.doc));
      if (this.indice().length !== antes) this.recalcularActivo();
    });
  }

  /**
   * El ancestro con scroll donde vive el editor (en la app, `.pane-scroll`).
   *
   * Se busca subiendo por el DOM en vez de esperar a que llegue un evento de
   * scroll: si no, saltar a una sección antes de haber desplazado la nota a mano
   * no encontraba contra qué medir. Se recuerda mientras siga montado.
   */
  private contenedorDeScroll(): HTMLElement | null {
    if (this.contenedorScroll?.isConnected) return this.contenedorScroll;
    let el = this.editor.view.dom.parentElement;
    while (el) {
      const desborde = getComputedStyle(el).overflowY;
      if (desborde === 'auto' || desborde === 'scroll') {
        this.contenedorScroll = el;
        return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  /**
   * Llamar desde el contenedor con scroll que envuelve al editor. Se limita a
   * un recálculo por fotograma: el evento de scroll llega decenas de veces por
   * segundo y medir posiciones fuerza al navegador a recalcular el layout.
   */
  alScroll(): void {
    /* Durante un salto no se recalcula nada: ya se sabe a qué sección se va, y
       medir el DOM en cada fotograma de la animación puede llegar a cortarla.
       Vencido el plazo, el seguimiento normal vuelve solo. */
    if (performance.now() < this.finDelSalto) return;
    if (this.recalculoPedido) return;
    this.recalculoPedido = true;
    requestAnimationFrame(() => {
      this.recalculoPedido = false;
      this.recalcularActivo();
    });
  }

  /** Sección activa = el último título que ya ha pasado por el borde de arriba. */
  private recalcularActivo(): void {
    const entradas = this.indice();
    const contenedor = this.contenedorDeScroll();
    if (entradas.length === 0 || !contenedor) {
      this.tituloActivo.set(0);
      return;
    }

    const limite = contenedor.getBoundingClientRect().top + HOLGURA_ACTIVO;
    let activo = 0;
    for (const [i, entrada] of entradas.entries()) {
      const dom = this.editor.view.nodeDOM(entrada.pos);
      if (!(dom instanceof HTMLElement)) continue;
      if (dom.getBoundingClientRect().top > limite) break;
      activo = i;
    }
    this.tituloActivo.set(activo);
  }

  /**
   * Clic en una entrada del índice: lleva la vista —y el cursor— a esa sección.
   *
   * El orden importa y es al revés de lo que parece natural. **Primero el
   * cursor**: al enfocar, el navegador arrastra la vista hasta el punto de
   * inserción por su cuenta, y `scrollIntoView: false` solo frena el scroll de
   * ProseMirror, no el del propio navegador. Poniéndolo después, ese tirón se
   * comía el desplazamiento que acabábamos de pedir. Ahora el tirón ocurre
   * primero y el desplazamiento nuestro es la última palabra.
   *
   * Y se desplaza **el contenedor**, no `dom.scrollIntoView()`: así se sabe
   * exactamente dónde queda el título, sin depender de cómo interprete cada
   * motor `block: 'start'` ni de que el elemento tenga o no `scroll-margin`.
   */
  irATitulo(i: number): void {
    const entrada = this.indice()[i];
    if (!entrada) return;
    this.tituloActivo.set(i);

    const dom = this.editor.view.nodeDOM(entrada.pos);
    if (!(dom instanceof HTMLElement)) return;

    // En una bóveda de solo lectura no se toca el cursor: el editor está
    // apagado y lo único que se quiere es mirar.
    if (this.editable()) {
      this.editor.chain().focus(entrada.pos + 1, { scrollIntoView: false }).run();
    }

    const contenedor = this.contenedorDeScroll();
    if (!contenedor) {
      dom.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

    const desplazamiento =
      dom.getBoundingClientRect().top - contenedor.getBoundingClientRect().top;
    this.finDelSalto = performance.now() + DURACION_SALTO;
    contenedor.scrollTo({
      top: contenedor.scrollTop + desplazamiento - MARGEN_SALTO,
      behavior: 'smooth',
    });
  }

  // --- Acciones de formato (toolbar y bubble menu) ---
  undo(): void { this.editor.chain().focus().undo().run(); }
  redo(): void { this.editor.chain().focus().redo().run(); }
  toggleBold(): void { this.editor.chain().focus().toggleBold().run(); }
  toggleItalic(): void { this.editor.chain().focus().toggleItalic().run(); }
  toggleUnderline(): void { this.editor.chain().focus().toggleUnderline().run(); }
  toggleStrike(): void { this.editor.chain().focus().toggleStrike().run(); }
  toggleCode(): void { this.editor.chain().focus().toggleCode().run(); }
  toggleHeading(level: 1 | 2 | 3 | 4): void { this.editor.chain().focus().toggleHeading({ level }).run(); }
  toggleBullet(): void { this.alternarLista('vinetas'); }
  toggleOrdered(): void { this.alternarLista('numerada'); }
  toggleTasks(): void { this.alternarLista('tarea'); }

  private alternarLista(tipo: TipoLista): void {
    this.editor.chain().focus().alternarLista(tipo).run();
  }

  /** ¿La selección está en una lista del tipo dado? (para el toolbar) */
  listaActiva(tipo: TipoLista): boolean {
    return this.editor.isActive('bloqueLista', { tipo });
  }
  toggleQuote(): void { this.editor.chain().focus().toggleBlockquote().run(); }
  toggleCodeBlock(): void { this.editor.chain().focus().toggleCodeBlock().run(); }

  // --- Tabla ---
  insertarTabla(): void {
    this.editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
  }
  filaEncima(): void { this.editor.chain().focus().addRowBefore().run(); }
  filaDebajo(): void { this.editor.chain().focus().addRowAfter().run(); }
  quitarFila(): void { this.editor.chain().focus().deleteRow().run(); }
  colIzquierda(): void { this.editor.chain().focus().addColumnBefore().run(); }
  colDerecha(): void { this.editor.chain().focus().addColumnAfter().run(); }
  quitarCol(): void { this.editor.chain().focus().deleteColumn().run(); }
  /**
   * Convierte en cabecera —o de vuelta en cuerpo— **la fila donde está el
   * cursor**.
   *
   * No sirve `toggleHeaderRow`: ese comando actúa SIEMPRE sobre la primera fila
   * de la tabla, esté el cursor donde esté. Con el cursor en la segunda fila se
   * pulsaba «Cabecera» y lo que cambiaba era la de arriba.
   *
   * `toggleHeaderCell` sí respeta la selección, pero con el cursor suelto toca
   * una sola celda: hay que seleccionar la fila entera antes y devolver después
   * el cursor a su sitio. Los tipos de celda se cambian con `setNodeMarkup`, que
   * conserva el tamaño de los nodos, así que las posiciones siguen valiendo.
   */
  alternarCabecera(): void {
    const seleccion = this.editor.state.selection;
    const $celda = celdaDe(seleccion);
    if (!$celda) return;
    const volverA = seleccion.from;

    this.editor
      .chain()
      .focus()
      .command(({ tr, dispatch }) => {
        if (dispatch) tr.setSelection(CellSelection.rowSelection($celda));
        return true;
      })
      .toggleHeaderCell()
      .command(({ tr, dispatch }) => {
        if (dispatch) tr.setSelection(TextSelection.near(tr.doc.resolve(volverA)));
        return true;
      })
      .run();
  }
  combinarCeldas(): void { this.editor.chain().focus().mergeOrSplit().run(); }
  /** Combinar necesita varias celdas elegidas; dividir, una ya combinada. */
  puedeCombinar(): boolean { return this.editor.can().mergeOrSplit(); }
  quitarTabla(): void { this.editor.chain().focus().deleteTable().run(); }
  setDivisor(): void { this.editor.chain().focus().setHorizontalRule().run(); }
  setAlineacion(align: 'left' | 'center' | 'right' | 'justify'): void {
    this.editor.chain().focus().setTextAlign(align).run();
  }

  // Color de texto y resaltado
  setColorTexto(color: string): void { this.editor.chain().focus().setColor(color).run(); }
  quitarColorTexto(): void { this.editor.chain().focus().unsetColor().run(); }
  colorTextoActual(): string { return (this.editor.getAttributes('textStyle')['color'] as string) ?? ''; }
  setResaltado(color: string): void { this.editor.chain().focus().setHighlight({ color }).run(); }
  quitarResaltado(): void { this.editor.chain().focus().unsetHighlight().run(); }
  resaltadoActual(): string { return (this.editor.getAttributes('highlight')['color'] as string) ?? ''; }

  isActive(nombreOAtributos: string | Record<string, unknown>, attrs?: Record<string, unknown>): boolean {
    return typeof nombreOAtributos === 'string'
      ? this.editor.isActive(nombreOAtributos, attrs)
      : this.editor.isActive(nombreOAtributos);
  }

  // --- Enlaces ---
  /** href del enlace bajo el cursor (para precargar el campo del toolbar). */
  enlaceActual(): string {
    return (this.editor.getAttributes('link')['href'] as string | undefined) ?? '';
  }

  /** Aplica un enlace a la selección; si no hay selección, inserta la URL como
   *  texto enlazado. Con URL vacía, quita el enlace. */
  aplicarEnlace(url: string): void {
    const href = this.normalizarUrl(url);
    if (!href) {
      this.quitarEnlace();
      return;
    }
    if (this.editor.state.selection.empty) {
      this.editor
        .chain()
        .focus()
        .insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] })
        .run();
    } else {
      this.editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
    }
  }

  quitarEnlace(): void {
    this.editor.chain().focus().extendMarkRange('link').unsetLink().run();
  }

  /** Antepone https:// si el texto no trae esquema (mailto:/tel:/http(s):// o ruta). */
  private normalizarUrl(u: string): string {
    const t = u.trim();
    if (!t) return '';
    return /^(https?:\/\/|mailto:|tel:|\/)/i.test(t) ? t : `https://${t}`;
  }

  /** Abre el diálogo nativo para elegir una imagen del disco e insertarla. */
  async elegirImagen(): Promise<void> {
    try {
      const seleccion = await open({
        multiple: false,
        directory: false,
        filters: [
          { name: 'Imágenes', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'] },
        ],
      });
      if (typeof seleccion === 'string') {
        await this.pegarImagenDesdeRuta(seleccion);
      }
    } catch (e) {
      console.error('No se pudo elegir la imagen:', e);
    }
  }

  /** Pega una imagen a partir de sus bytes (captura, fichero con bytes). */
  private async pegarImagenBytes(file: File): Promise<void> {
    try {
      const ext = (file.type.split('/')[1] || 'png').toLowerCase();
      await this.editarImagen(file, ext, async (res) => {
        this.insertarImagen(
          res.editada
            ? await this.assets.guardar(res.base64, res.ext)
            : await this.assets.guardar(await blobABase64(file), ext),
        );
      });
    } catch (e) {
      console.error('No se pudo pegar la imagen:', e);
    }
  }

  /** Pega una imagen que Rust lee del disco por su ruta. */
  private async pegarImagenDesdeRuta(ruta: string): Promise<void> {
    try {
      const ext = (ruta.split('.').pop() ?? 'png').toLowerCase();
      // Los bytes solo hacen falta si se va a poder editar; si no, que Rust
      // importe el fichero directamente (sin pasearlo por el webview).
      if (SIN_EDITOR.includes(ext)) {
        this.insertarImagen(await this.assets.importarDesdeRuta(ruta));
        return;
      }
      const imagen = await this.assets.leerImagen(ruta);
      await this.editarImagen(base64ABlob(imagen.datos, imagen.ext), imagen.ext, async (res) => {
        this.insertarImagen(
          res.editada
            ? await this.assets.guardar(res.base64, res.ext)
            : await this.assets.importarDesdeRuta(ruta),
        );
      });
    } catch (e) {
      console.error('No se pudo importar la imagen:', e);
    }
  }

  /**
   * Muestra la pantalla de edición antes de insertar la imagen (estilo
   * WhatsApp) y, si el usuario acepta, llama a `guardar`.
   *
   * El guardado se hace DENTRO del diálogo (no después de cerrarlo) para que su
   * pantalla de carga cubra también esa parte: componer la imagen bloquea el
   * hilo y escribirla en disco tarda, y de otro modo la app parecería colgada
   * entre que se cierra la pantalla y aparece la imagen en la nota.
   */
  private async editarImagen(
    imagen: Blob,
    ext: string,
    guardar: (r: AnotarResultado) => Promise<void>,
  ): Promise<void> {
    if (SIN_EDITOR.includes(ext)) {
      await guardar({ editada: false });
      return;
    }

    const url = URL.createObjectURL(imagen);
    try {
      await firstValueFrom(
        this.dialog
          .open<AnotarImagenDialog, AnotarDatos, AnotarResultado>(AnotarImagenDialog, {
            data: { url, ext, guardar },
            panelClass: 'panel-anotar',
            width: '100vw',
            maxWidth: '100vw',
            height: '100vh',
            // Esc lo gestiona el propio diálogo (primero suelta la selección).
            disableClose: true,
            /* Al contenedor, no al primer botón: así ni sale un botón marcado
               con el foco, ni las teclas (Supr, Ctrl+Z) se cuelan en el
               documento que queda debajo. */
            autoFocus: 'dialog',
          })
          .afterClosed(),
      );
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  private insertarImagen(asset: AssetGuardado): void {
    // `src` = nombre del original (portable); `preview` = miniatura ligera que
    // se muestra en el editor. Se inserta con insertContent para fijar ambos.
    this.editor
      .chain()
      .focus()
      .insertContent({
        type: 'image',
        attrs: { src: asset.nombre, preview: asset.preview ?? null },
      })
      .run();
  }

  // --- Visor de imagen a tamaño completo (lightbox) ---
  protected abrirLightbox(nombreOriginal: string): void {
    this.reiniciarZoom();
    this.lightbox.set(resolverSrc(nombreOriginal));
  }

  protected cerrarLightbox(): void {
    this.lightbox.set(null);
    this.reiniciarZoom();
  }

  private reiniciarZoom(): void {
    this.zoom.set(1);
    this.desp.set({ x: 0, y: 0 });
  }

  /**
   * Clic en el fondo del visor: cierra, salvo que venga de soltar un arrastre
   * (si al mover la imagen el puntero se sale de ella, el clic acaba en el
   * fondo y cerraría el visor sin querer).
   */
  protected alClicVisor(): void {
    if (this.arrastrado) {
      this.arrastrado = false;
      return;
    }
    this.cerrarLightbox();
  }

  /** Clic sobre la imagen: ni cierra el visor ni deja la marca de arrastre. */
  protected alClicImagen(ev: MouseEvent): void {
    ev.stopPropagation();
    this.arrastrado = false;
  }

  /**
   * Rueda del ratón: acerca o aleja. El punto que está bajo el cursor se queda
   * donde está (si no, al ampliar te vas al centro y pierdes lo que mirabas).
   */
  protected alRueda(ev: WheelEvent): void {
    ev.preventDefault();
    const z = this.zoom();
    this.aplicarZoom(Math.exp(-ev.deltaY * 0.0015) * z, ev);
  }

  /** Doble clic: alterna entre la imagen entera y un aumento cómodo. */
  protected alternarZoom(ev: MouseEvent): void {
    ev.preventDefault();
    this.aplicarZoom(this.zoom() > 1 ? 1 : 2.5, ev);
  }

  private aplicarZoom(deseado: number, ev: MouseEvent): void {
    const caja = this.visorEl()?.nativeElement.getBoundingClientRect();
    if (!caja) return;
    const nuevo = Math.min(Math.max(deseado, 1), 8);
    const k = nuevo / this.zoom();
    // Posición del cursor respecto al centro (que es donde está la imagen).
    const u = {
      x: ev.clientX - (caja.left + caja.width / 2),
      y: ev.clientY - (caja.top + caja.height / 2),
    };
    const d = this.desp();
    this.zoom.set(nuevo);
    this.desp.set(
      nuevo === 1
        ? { x: 0, y: 0 } // de vuelta al tamaño completo, se recentra
        : this.limitar({ x: u.x - k * (u.x - d.x), y: u.y - k * (u.y - d.y) }, nuevo),
    );
  }

  /** Arrastrar con la imagen ampliada la desplaza. */
  protected alPulsarVisor(ev: MouseEvent): void {
    if (this.zoom() === 1 || ev.button !== 0) return;
    ev.preventDefault(); // y de paso, nada de arrastre nativo de la imagen
    this.arrastrado = false; // cada gesto empieza limpio
    const inicio = { x: ev.clientX, y: ev.clientY };
    const desde = this.desp();

    const mover = (e: MouseEvent): void => {
      this.arrastrado = true;
      this.desp.set(
        this.limitar(
          { x: desde.x + e.clientX - inicio.x, y: desde.y + e.clientY - inicio.y },
          this.zoom(),
        ),
      );
    };
    const soltar = (): void => {
      document.removeEventListener('mousemove', mover);
      document.removeEventListener('mouseup', soltar);
    };
    document.addEventListener('mousemove', mover);
    document.addEventListener('mouseup', soltar);
  }

  /** Recorta el desplazamiento para que la imagen no se pueda sacar de la vista. */
  private limitar(d: { x: number; y: number }, z: number): { x: number; y: number } {
    const img = this.visorImgEl()?.nativeElement;
    const caja = this.visorEl()?.nativeElement.getBoundingClientRect();
    if (!img || !caja) return d;
    // offsetWidth/Height son los de antes de la transformación.
    const topeX = Math.max(0, (img.offsetWidth * z - caja.width) / 2);
    const topeY = Math.max(0, (img.offsetHeight * z - caja.height) / 2);
    return {
      x: Math.min(Math.max(d.x, -topeX), topeX),
      y: Math.min(Math.max(d.y, -topeY), topeY),
    };
  }

  protected porcentajeZoom(): string {
    return `${Math.round(this.zoom() * 100)}%`;
  }

  @HostListener('document:keydown.escape')
  protected onEscapeGlobal(): void {
    if (this.lightbox()) this.cerrarLightbox();
  }

  /** Extrae una ruta local de imagen de un texto/URI, o null si no lo es. */
  private rutaImagenLocal(texto: string): string | null {
    if (!texto) return null;
    const primera = texto
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s && !s.startsWith('#'));
    if (!primera) return null;

    let ruta = primera;
    if (ruta.startsWith('file://')) {
      try {
        ruta = decodeURIComponent(new URL(ruta).pathname);
      } catch {
        return null;
      }
    }
    if (!ruta.startsWith('/')) return null; // solo rutas absolutas locales
    return /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(ruta) ? ruta : null;
  }

  /**
   * Pide el valor del bloque secreto y lo inserta ya cifrado.
   *
   * El texto en claro vive solo dentro del diálogo: aquí llega el resultado del
   * cifrado, así que nunca entra en el documento ni, por tanto, en disco.
   */
  /**
   * Abre el candado de la bóveda desde un bloque cifrado, sin pasar por la
   * pantalla de cambiar el valor: lo único que quiere el usuario es poder leer
   * el que ya hay.
   *
   * Al terminar avisa a **todos** los bloques de la nota, que estaban diciendo
   * «Bloqueado» y vuelven solos a su estado normal.
   */
  private async desbloquear(): Promise<void> {
    await this.secretos.cargarEstado().catch(() => undefined);
    if (this.secretos.desbloqueado()) {
      // `bubbles`: los bloques escuchan en `document`, porque cuando se montan
      // la vista del editor todavía no existe.
      this.editor.view.dom.dispatchEvent(
        new CustomEvent(EVENTO_SECRETO_ABIERTO, { bubbles: true }),
      );
      return;
    }

    const ref = this.dialog.open<SecretoDialog, SecretoDatos, SecretoResultado>(SecretoDialog, {
      data: { etiqueta: '', datos: '', soloAbrir: true },
      autoFocus: 'dialog',
    });
    await firstValueFrom(ref.afterClosed());
    if (this.secretos.desbloqueado()) {
      // `bubbles`: los bloques escuchan en `document`, porque cuando se montan
      // la vista del editor todavía no existe.
      this.editor.view.dom.dispatchEvent(
        new CustomEvent(EVENTO_SECRETO_ABIERTO, { bubbles: true }),
      );
    }
  }

  private async abrirSecreto(peticion: PeticionSecreto): Promise<void> {
    // El estado puede haber cambiado solo (cierre por inactividad), así que se
    // consulta antes de decidir qué pantalla enseñar.
    await this.secretos.cargarEstado().catch(() => undefined);

    const ref = this.dialog.open<SecretoDialog, unknown, SecretoResultado>(SecretoDialog, {
      data: { etiqueta: peticion.etiqueta, datos: peticion.datos },
      autoFocus: 'dialog',
    });
    const res = await firstValueFrom(ref.afterClosed());
    if (!res) return;

    const attrs = { etiqueta: res.etiqueta, datos: res.datos };
    if (peticion.pos == null) {
      this.editor.chain().focus().insertContent({ type: 'secreto', attrs }).run();
    } else {
      // Reemplazar el nodo entero: `atom`, así que ocupa una sola posición.
      this.editor
        .chain()
        .focus()
        .command(({ tr }) => {
          tr.setNodeMarkup(peticion.pos as number, undefined, attrs);
          return true;
        })
        .run();
    }
  }

  ngOnDestroy(): void {
    this.editor.destroy();
  }
}
