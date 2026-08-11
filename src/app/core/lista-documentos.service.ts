import { computed, inject, Injectable, signal } from '@angular/core';

import { DocumentosService } from './documentos.service';
import { DocumentoResumen, ResultadoBusqueda, TagInfo } from '../models/documento.model';

/** Milisegundos de teclas quietas antes de preguntarle a Rust. */
const RETRASO_BUSQUEDA = 200;

/**
 * El listado de notas de la bóveda abierta: qué hay, cómo está filtrado y qué
 * ha devuelto la búsqueda.
 *
 * Vive en un servicio y no en un componente porque lo miran dos sitios a la vez
 * —la barra lateral lo pinta y el panel del documento lo consulta— y hacerlo
 * viajar entre ellos con inputs y outputs era la mitad de la fachada.
 *
 * No sabe **abrir** ni **guardar** una nota: eso lo lleva quien tiene el
 * documento en pantalla. Aquí solo está la lista.
 */
@Injectable({ providedIn: 'root' })
export class ListaDocumentosService {
  private readonly docs = inject(DocumentosService);

  readonly documentos = signal<DocumentoResumen[]>([]);
  readonly etiquetas = signal<TagInfo[]>([]);
  /** Etiqueta por la que se filtra la lista, o `null`. */
  readonly filtroTag = signal<string | null>(null);

  readonly busqueda = signal('');
  readonly resultados = signal<ResultadoBusqueda[]>([]);
  private timerBusqueda?: ReturnType<typeof setTimeout>;

  /**
   * Último fallo al leer del disco.
   *
   * Lo tiene el servicio y no quien llama porque la búsqueda va con
   * temporizador: cuando falla ya no hay nadie esperando su promesa.
   */
  readonly error = signal<string | null>(null);

  /** Lo que se pinta en la lista, con el filtro por etiqueta aplicado. */
  readonly visibles = computed(() => {
    const f = this.filtroTag();
    const docs = this.documentos();
    return f ? docs.filter((d) => (d.tags ?? []).includes(f)) : docs;
  });

  /** Relee lista y etiquetas. No lanza: el fallo se queda en `error()`. */
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
      this.error.set(e instanceof Error ? e.message : String(e));
    }
  }

  /** Busca con retraso: no se llama a Rust en cada tecla. */
  buscar(texto: string): void {
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
        .catch((e) => this.error.set(e instanceof Error ? e.message : String(e)));
    }, RETRASO_BUSQUEDA);
  }

  limpiarBusqueda(): void {
    clearTimeout(this.timerBusqueda);
    this.busqueda.set('');
    this.resultados.set([]);
  }

  /** La misma etiqueta que ya filtraba, quita el filtro. */
  alternarFiltro(nombre: string): void {
    this.filtroTag.update((f) => (f === nombre ? null : nombre));
  }

  /**
   * Deja la lista como recién abierta. La llama la app al cambiar de bóveda: la
   * búsqueda y el filtro son de la anterior y sus resultados apuntarían a notas
   * que en la nueva no existen.
   */
  reiniciar(): void {
    this.limpiarBusqueda();
    this.filtroTag.set(null);
    this.error.set(null);
  }
}
