import { JSONContent } from '@tiptap/core';

export interface Documento {
  id?: string;
  titulo: string;
  icono?: string | null;
  cover?: string | null;
  /** Etiquetas del documento (nombres normalizados en minúsculas). */
  tags?: string[];
  /** Contenido del documento en JSON de Tiptap (`{ type: 'doc', content: [...] }`). */
  contenido: JSONContent;
  creado?: string;
  modificado?: string;
}

/** Fila ligera para listados (barra lateral, resultados de búsqueda). */
export interface DocumentoResumen {
  id: string;
  titulo: string;
  icono?: string | null;
  modificado: string;
  tags?: string[];
}

/** Etiqueta con su número de usos. */
export interface TagInfo {
  nombre: string;
  usos: number;
}

/**
 * Resultado de búsqueda (FTS5). `fragmento` trae los términos encontrados
 * marcados con U+0002 (inicio) y U+0003 (fin) para resaltarlos en la UI.
 */
export interface ResultadoBusqueda {
  id: string;
  titulo: string;
  icono?: string | null;
  fragmento: string;
  modificado: string;
}
