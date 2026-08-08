import { Node as NodoProse } from '@tiptap/pm/model';

/**
 * Un título de la nota, tal y como se pinta en el panel del índice.
 *
 * No hace falta inventar anclas ni `id` en el HTML: `pos` es la posición del
 * nodo en el documento de ProseMirror, y con ella se llega a su elemento del
 * DOM (`view.nodeDOM(pos)`) para saltar. Como el índice se rehace en cada
 * cambio del documento, esas posiciones nunca se quedan viejas.
 */
export interface EntradaIndice {
  pos: number;
  /** Nivel del título tal cual está en el documento (1–4). */
  nivel: number;
  texto: string;
  /**
   * Escalones de sangría en el panel, contados desde el título **más alto que
   * haya en esa nota**. Una nota que solo usa H2 y H3 se pinta pegada al margen
   * (0 y 1) en vez de arrancar ya sangrada, que es lo que pasaría usando el
   * nivel a secas.
   */
  sangria: number;
}

/**
 * Índice de una nota: sus títulos, en el orden en que aparecen.
 *
 * Los títulos **sin texto** se dejan fuera a propósito: mientras se escribe uno
 * nuevo hay un instante en que está vacío, y aparecería como una entrada en
 * blanco que además baila.
 */
export function extraerIndice(doc: NodoProse): EntradaIndice[] {
  const titulos: Omit<EntradaIndice, 'sangria'>[] = [];

  doc.descendants((nodo, pos) => {
    if (nodo.type.name !== 'heading') return true;
    const texto = nodo.textContent.trim();
    if (texto) {
      titulos.push({ pos, nivel: (nodo.attrs['level'] as number) || 1, texto });
    }
    return false; // dentro de un título no hay más títulos
  });

  if (titulos.length === 0) return [];

  const base = Math.min(...titulos.map((t) => t.nivel));
  return titulos.map((t) => ({ ...t, sangria: t.nivel - base }));
}
