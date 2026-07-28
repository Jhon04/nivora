import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';

import {
  Documento,
  DocumentoResumen,
  ResultadoBusqueda,
  TagInfo,
} from '../models/documento.model';

/**
 * Puente Angular ➜ Rust. Cada método es una llamada IPC directa a un
 * `#[tauri::command]`. No hay REST, ni HTTP, ni CORS: es una llamada de función.
 */
@Injectable({ providedIn: 'root' })
export class DocumentosService {
  guardar(documento: Documento): Promise<Documento> {
    return invoke<Documento>('guardar_documento', { documento });
  }

  obtener(id: string): Promise<Documento | null> {
    return invoke<Documento | null>('obtener_documento', { id });
  }

  listar(): Promise<DocumentoResumen[]> {
    return invoke<DocumentoResumen[]>('listar_documentos');
  }

  eliminar(id: string): Promise<void> {
    return invoke<void>('eliminar_documento', { id });
  }

  /**
   * Relee las notas del disco y rehace el índice. Hace falta tras traer cambios
   * de otro equipo (`git pull`, Syncthing) con la app abierta: los ficheros son
   * la fuente de verdad, pero el listado y la búsqueda salen del índice.
   * Devuelve cuántas notas hay ahora en el workspace.
   */
  recargar(): Promise<number> {
    return invoke<number>('recargar_workspace');
  }

  buscar(consulta: string): Promise<ResultadoBusqueda[]> {
    return invoke<ResultadoBusqueda[]>('buscar_documentos', { consulta });
  }

  listarTags(): Promise<TagInfo[]> {
    return invoke<TagInfo[]>('listar_etiquetas');
  }
}
