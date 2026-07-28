import { Component, computed, HostListener, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { JSONContent } from '@tiptap/core';
import { ConnectedPosition, OverlayModule } from '@angular/cdk/overlay';
import { open } from '@tauri-apps/plugin-dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatDialog } from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';

import { ConfirmarDatos, ConfirmarDialog } from './shared/confirmar-dialog';
import { EditorComponent } from './editor/editor';
import { EmojiPicker } from './documento/emoji-picker';
import { DragScrollDirective } from './shared/drag-scroll';
import { DocumentosService } from './core/documentos.service';
import { AssetsService } from './core/assets.service';
import { PreferenciasService } from './core/preferencias.service';
import { TemaService } from './core/tema.service';
import { migrarAssetsARelativo, nombreRelativo, resolverSrc } from './core/asset-path';
import { migrarListas } from './core/migrar-listas';
import {
  Documento,
  DocumentoResumen,
  ResultadoBusqueda,
  TagInfo,
} from './models/documento.model';

const DOC_VACIO: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] };

/** Milisegundos de inactividad antes de guardar automáticamente. */
const RETRASO_GUARDADO = 800;

type EstadoGuardado = 'idle' | 'pendiente' | 'guardando' | 'guardado' | 'error';

@Component({
  selector: 'app-root',
  imports: [
    FormsModule,
    EditorComponent,
    EmojiPicker,
    DragScrollDirective,
    OverlayModule,
    MatButtonModule,
    MatIconModule,
    MatListModule,
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App implements OnInit {
  private readonly docs = inject(DocumentosService);
  private readonly assets = inject(AssetsService);
  private readonly dialog = inject(MatDialog);
  private readonly prefs = inject(PreferenciasService);
  protected readonly tema = inject(TemaService);

  protected readonly documentos = signal<DocumentoResumen[]>([]);
  protected readonly actual = signal<Documento | null>(null);
  protected readonly estadoGuardado = signal<EstadoGuardado>('idle');
  protected readonly error = signal<string | null>(null);
  protected readonly iconoAbierto = signal(false);
  protected readonly enlaceAbierto = signal(false);
  protected readonly enlaceUrl = signal('');

  /** Menús desplegables del toolbar (títulos, listas, alineación, colores). */
  protected readonly menuTitulos = signal(false);
  protected readonly menuListas = signal(false);
  protected readonly menuAlinear = signal(false);
  protected readonly menuColorTexto = signal(false);
  protected readonly menuResaltado = signal(false);

  /** Selector de tema (pie de la barra lateral). */
  protected readonly menuTema = signal(false);

  protected readonly iconoTema = computed(() => {
    switch (this.tema.tema()) {
      case 'claro':
        return 'light_mode';
      case 'oscuro':
        return 'dark_mode';
      default:
        return 'brightness_auto';
    }
  });

  /** Paletas para color de texto y resaltado. */
  protected readonly coloresTexto = [
    '#000000', '#495057', '#e03131', '#e8590c', '#f08c00', '#2f9e44',
    '#0ca678', '#1971c2', '#4263eb', '#7048e8', '#ae3ec9', '#c2255c',
  ];
  protected readonly coloresResaltado = [
    '#ffec99', '#ffd8a8', '#ffc9c9', '#eebefa', '#d0bfff', '#bac8ff',
    '#a5d8ff', '#99e9f2', '#c3fae8', '#b2f2bb', '#d8f5a2', '#dee2e6',
  ];

  /** Posiciones para los desplegables del toolbar (CDK Overlay): debajo del
   *  botón y, si no cabe, encima; el CDK elige la que entre en pantalla. */
  protected readonly posicionesMenu: ConnectedPosition[] = [
    { originX: 'start', originY: 'bottom', overlayX: 'start', overlayY: 'top', offsetY: 6 },
    { originX: 'start', originY: 'top', overlayX: 'start', overlayY: 'bottom', offsetY: -6 },
    { originX: 'end', originY: 'bottom', overlayX: 'end', overlayY: 'top', offsetY: 6 },
    { originX: 'end', originY: 'top', overlayX: 'end', overlayY: 'bottom', offsetY: -6 },
  ];

  private timerGuardado?: ReturnType<typeof setTimeout>;

  protected readonly busqueda = signal('');
  protected readonly resultados = signal<ResultadoBusqueda[]>([]);
  private timerBusqueda?: ReturnType<typeof setTimeout>;

  protected readonly etiquetas = signal<TagInfo[]>([]);
  protected readonly filtroTag = signal<string | null>(null);
  protected readonly nuevaEtiqueta = signal('');

  /** Sidebar colapsada (solo iconos). Arranca como la dejó el usuario. */
  protected readonly sidebarColapsada = signal(this.prefs.obtener().sidebarColapsada);

  /** Documentos visibles en la barra lateral, aplicando el filtro por etiqueta. */
  protected readonly documentosVisibles = computed(() => {
    const f = this.filtroTag();
    const docs = this.documentos();
    return f ? docs.filter((d) => (d.tags ?? []).includes(f)) : docs;
  });

  /** URL del webview para la portada (el documento guarda el nombre relativo). */
  protected readonly coverUrl = computed(() => {
    const cover = this.actual()?.cover;
    return cover ? resolverSrc(cover) : null;
  });

  ngOnInit(): void {
    void this.iniciar();
  }

  private async iniciar(): Promise<void> {
    await this.assets.iniciar(); // fija la carpeta base de assets antes de pintar
    await this.refrescar();
  }

  async refrescar(): Promise<void> {
    try {
      const [docs, tags] = await Promise.all([this.docs.listar(), this.docs.listarTags()]);
      this.documentos.set(docs);
      this.etiquetas.set(tags);
      // Si el filtro activo ya no existe (etiqueta podada), quitarlo.
      if (this.filtroTag() && !tags.some((t) => t.nombre === this.filtroTag())) {
        this.filtroTag.set(null);
      }
      this.error.set(null);
    } catch (e) {
      this.error.set(this.msg(e));
    }
  }

  async nuevo(): Promise<void> {
    await this.flushGuardado();
    this.iconoAbierto.set(false);
    this.enlaceAbierto.set(false);
    this.menuTitulos.set(false);
    this.menuListas.set(false);
    this.menuAlinear.set(false);
    this.menuColorTexto.set(false);
    this.menuResaltado.set(false);
    this.nuevaEtiqueta.set('');
    this.estadoGuardado.set('idle');
    this.actual.set({ titulo: '', contenido: structuredClone(DOC_VACIO) });
  }

  async abrir(id: string): Promise<void> {
    await this.flushGuardado();
    this.iconoAbierto.set(false);
    this.enlaceAbierto.set(false);
    this.menuTitulos.set(false);
    this.menuListas.set(false);
    this.menuAlinear.set(false);
    this.menuColorTexto.set(false);
    this.menuResaltado.set(false);
    this.nuevaEtiqueta.set('');
    try {
      const doc = await this.docs.obtener(id);
      if (doc) {
        // Migra rutas absolutas antiguas a nombre relativo (portabilidad).
        migrarAssetsARelativo(doc.contenido);
        // Y las listas anidadas del esquema antiguo a bloques planos.
        migrarListas(doc.contenido);
        if (doc.cover) doc.cover = nombreRelativo(doc.cover);
        this.actual.set(doc);
        this.estadoGuardado.set('guardado');
      }
    } catch (e) {
      this.error.set(this.msg(e));
    }
  }

  onTitulo(titulo: string): void {
    const a = this.actual();
    if (!a) return;
    this.actual.set({ ...a, titulo });
    this.programarGuardado();
  }

  toggleIcono(): void {
    this.iconoAbierto.update((v) => !v);
  }

  /** Abre el popover de enlace (CDK Overlay), precargando la URL bajo el cursor. */
  abrirEnlace(urlActual: string): void {
    this.enlaceUrl.set(urlActual);
    this.enlaceAbierto.set(true);
    setTimeout(() => document.querySelector<HTMLInputElement>('.enlace-input')?.focus(), 0);
  }

  onIcono(icono: string | null): void {
    const a = this.actual();
    if (!a) return;
    this.actual.set({ ...a, icono });
    this.programarGuardado();
  }

  async elegirPortada(): Promise<void> {
    const ruta = await open({
      multiple: false,
      filters: [
        { name: 'Imágenes', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] },
      ],
    });
    if (typeof ruta !== 'string') return;
    try {
      const asset = await this.assets.importarDesdeRuta(ruta);
      const a = this.actual();
      if (!a) return;
      // Guardamos el nombre relativo (portable), no la ruta absoluta.
      this.actual.set({ ...a, cover: asset.nombre });
      this.programarGuardado();
    } catch (e) {
      this.error.set(this.msg(e));
    }
  }

  quitarPortada(): void {
    const a = this.actual();
    if (!a) return;
    this.actual.set({ ...a, cover: null });
    this.programarGuardado();
  }

  // --- Etiquetas ---
  agregarEtiqueta(nombre: string): void {
    const a = this.actual();
    this.nuevaEtiqueta.set('');
    if (!a) return;
    const tag = nombre.trim().replace(/\s+/g, ' ').toLowerCase();
    if (!tag) return;
    const actuales = a.tags ?? [];
    if (actuales.includes(tag)) return;
    this.actual.set({ ...a, tags: [...actuales, tag] });
    this.programarGuardado();
  }

  quitarEtiqueta(nombre: string): void {
    const a = this.actual();
    if (!a) return;
    this.actual.set({ ...a, tags: (a.tags ?? []).filter((t) => t !== nombre) });
    this.programarGuardado();
  }

  alternarFiltro(nombre: string): void {
    this.filtroTag.update((f) => (f === nombre ? null : nombre));
  }

  toggleSidebar(): void {
    this.sidebarColapsada.update((v) => !v);
    this.prefs.fijar('sidebarColapsada', this.sidebarColapsada());
  }

  /** Color estable derivado del nombre de la etiqueta. */
  private hueTag(nombre: string): number {
    let h = 0;
    for (const ch of nombre) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return h;
  }

  /* Se emite light-dark() en vez de mirar el tema desde TypeScript: así el
     color lo resuelve el navegador y sigue al vuelo los cambios de tema. */
  bgTag(nombre: string): string {
    const h = this.hueTag(nombre);
    return `light-dark(hsl(${h} 65% 92%), hsl(${h} 42% 24%))`;
  }

  fgTag(nombre: string): string {
    const h = this.hueTag(nombre);
    return `light-dark(hsl(${h} 45% 32%), hsl(${h} 70% 80%))`;
  }

  onBuscar(texto: string): void {
    this.busqueda.set(texto);
    clearTimeout(this.timerBusqueda);
    if (!texto.trim()) {
      this.resultados.set([]);
      return;
    }
    this.timerBusqueda = setTimeout(() => {
      void this.docs
        .buscar(texto)
        .then((r) => this.resultados.set(r))
        .catch((e) => this.error.set(this.msg(e)));
    }, 200);
  }

  limpiarBusqueda(): void {
    clearTimeout(this.timerBusqueda);
    this.busqueda.set('');
    this.resultados.set([]);
  }

  /** Parte el fragmento en segmentos, marcando (hl) los términos encontrados
   *  (delimitados por U+0002/U+0003), para resaltarlos sin usar innerHTML. */
  partesFragmento(fragmento: string): { t: string; hl: boolean }[] {
    const partes: { t: string; hl: boolean }[] = [];
    let buffer = '';
    let hl = false;
    for (const ch of fragmento) {
      const code = ch.charCodeAt(0);
      if (code === 2 || code === 3) {
        // 2 = U+0002 (inicio de término encontrado), 3 = U+0003 (fin)
        if (buffer) partes.push({ t: buffer, hl });
        buffer = '';
        hl = code === 2;
      } else {
        buffer += ch;
      }
    }
    if (buffer) partes.push({ t: buffer, hl });
    return partes;
  }

  onContenido(contenido: JSONContent): void {
    const a = this.actual();
    if (!a) return;
    this.actual.set({ ...a, contenido });
    this.programarGuardado();
  }

  /** Ctrl/Cmd+S: fuerza el guardado inmediato del documento actual. */
  @HostListener('document:keydown', ['$event'])
  protected onKeydown(ev: KeyboardEvent): void {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') {
      ev.preventDefault();
      void this.guardarAuto();
    }
  }

  /** Reprograma el guardado automático tras cada edición del usuario. */
  private programarGuardado(): void {
    if (!this.actual()) return;
    this.estadoGuardado.set('pendiente');
    clearTimeout(this.timerGuardado);
    this.timerGuardado = setTimeout(() => void this.guardarAuto(), RETRASO_GUARDADO);
  }

  /** Persiste el documento actual. Al volver fusiona SOLO id/fechas para no
   *  pisar lo que el usuario haya escrito durante el guardado. */
  private async guardarAuto(): Promise<void> {
    clearTimeout(this.timerGuardado);
    this.timerGuardado = undefined;
    const doc = this.actual();
    if (!doc) return;

    this.estadoGuardado.set('guardando');
    this.error.set(null);
    try {
      const guardado = await this.docs.guardar(doc);
      const ahora = this.actual();
      if (ahora) {
        this.actual.set({
          ...ahora,
          id: guardado.id,
          creado: guardado.creado,
          modificado: guardado.modificado,
        });
      }
      // Si el usuario siguió escribiendo, ya hay otro guardado en cola.
      this.estadoGuardado.set(this.timerGuardado ? 'pendiente' : 'guardado');
      await this.refrescar();
    } catch (e) {
      this.estadoGuardado.set('error');
      this.error.set(this.msg(e));
    }
  }

  /** Vacía cualquier guardado pendiente (al cambiar/crear documento). */
  private async flushGuardado(): Promise<void> {
    if (this.timerGuardado != null) {
      await this.guardarAuto();
    }
  }

  async eliminar(id: string, ev: Event): Promise<void> {
    ev.stopPropagation();

    const titulo = this.documentos().find((d) => d.id === id)?.titulo?.trim() || 'Sin título';
    const confirmado = await firstValueFrom(
      this.dialog
        .open<ConfirmarDialog, ConfirmarDatos, boolean>(ConfirmarDialog, {
          width: '380px',
          data: {
            titulo: 'Eliminar documento',
            mensaje: `Se eliminará «${titulo}». Esta acción no se puede deshacer.`,
            aceptar: 'Eliminar',
            peligro: true,
          },
        })
        .afterClosed(),
    );
    if (!confirmado) return;

    try {
      await this.docs.eliminar(id);
      if (this.actual()?.id === id) {
        clearTimeout(this.timerGuardado);
        this.timerGuardado = undefined;
        this.actual.set(null);
        this.estadoGuardado.set('idle');
      }
      await this.refrescar();
    } catch (e) {
      this.error.set(this.msg(e));
    }
  }

  private msg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }
}
