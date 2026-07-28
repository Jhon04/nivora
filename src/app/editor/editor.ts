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
  viewChild,
} from '@angular/core';
import { Editor, JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import TextAlign from '@tiptap/extension-text-align';
import { TextStyle } from '@tiptap/extension-text-style';
import { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion';
import { MatDialog } from '@angular/material/dialog';
import { open } from '@tauri-apps/plugin-dialog';
import { open as abrirEnSistema } from '@tauri-apps/plugin-shell';
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
import { createSlashCommand, EVENTO_IMAGEN, SlashItem } from './slash-command';

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

interface SlashPos {
  left: number;
  top: number;
  arriba: boolean;
}

@Component({
  selector: 'app-editor',
  imports: [TiptapEditorDirective, TiptapBubbleMenuDirective],
  templateUrl: './editor.html',
  styleUrl: './editor.scss',
})
export class EditorComponent implements OnDestroy {
  /** Contenido a mostrar (JSON de Tiptap). Al cambiar, recarga el editor. */
  readonly content = input<JSONContent | null>(null);
  /** Emite el JSON del documento cada vez que el usuario edita. */
  readonly contentChange = output<JSONContent>();

  protected readonly bubbleOptions = { placement: 'top' as const };

  // --- Estado del slash menu (/) ---
  protected readonly slashOpen = signal(false);
  protected readonly slashItems = signal<SlashItem[]>([]);
  protected readonly slashIndex = signal(0);
  protected readonly slashPos = signal<SlashPos>({ left: 0, top: 0, arriba: false });
  private slashSelect: ((item: SlashItem) => void) | null = null;

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
        AssetImage,
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
      },
    });

    /* La entrada "Imagen" del menú "/" avisa por el DOM: elegir el fichero es
       cosa del componente (diálogo nativo + pantalla de edición), no de una
       extensión de Tiptap. El listener se va con el editor al destruirlo. */
    this.editor.view.dom.addEventListener(EVENTO_IMAGEN, () => void this.elegirImagen());

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
    });
  }

  // --- Slash menu ---
  private slashStart(props: SuggestionProps<SlashItem, SlashItem>): void {
    this.slashItems.set(props.items);
    this.slashIndex.set(0);
    this.slashSelect = props.command;

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
    this.slashIndex.set((this.slashIndex() + delta + n) % n);
  }

  protected slashPick(i: number): void {
    const item = this.slashItems()[i];
    if (item && this.slashSelect) this.slashSelect(item);
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

  ngOnDestroy(): void {
    this.editor.destroy();
  }
}
