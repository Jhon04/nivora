import { JSONContent } from '@tiptap/core';

/**
 * Pasa las listas anidadas del esquema antiguo (bulletList → listItem →
 * paragraph) a los bloques planos de `lista-plana.ts`.
 *
 * Se aplica al abrir un documento, igual que `migrarAssetsARelativo`: los
 * documentos ya guardados siguen abriéndose bien y se re-guardan ya en el
 * formato nuevo la primera vez que se editan.
 */

const LISTAS: Record<string, 'vinetas' | 'numerada' | 'tarea'> = {
  bulletList: 'vinetas',
  orderedList: 'numerada',
  taskList: 'tarea',
};

const NIVEL_MAX = 5;

/** Convierte in situ el contenido de un documento. Devuelve true si cambió. */
export function migrarListas(doc: JSONContent): boolean {
  if (!doc.content) return false;
  const antes = JSON.stringify(doc.content);
  doc.content = aplanar(doc.content, 0);
  return JSON.stringify(doc.content) !== antes;
}

function aplanar(nodos: JSONContent[], nivel: number): JSONContent[] {
  const salida: JSONContent[] = [];
  for (const nodo of nodos) {
    const tipo = nodo.type ? LISTAS[nodo.type] : undefined;
    if (tipo) {
      salida.push(...itemsDeLista(nodo, tipo, nivel));
      continue;
    }
    // Bloques normales: se recorre por si llevan listas dentro (una cita, p.ej.).
    if (nodo.content) nodo.content = aplanar(nodo.content, nivel);
    salida.push(nodo);
  }
  return salida;
}

/** Convierte los ítems de una lista antigua en bloques planos consecutivos. */
function itemsDeLista(
  lista: JSONContent,
  tipo: 'vinetas' | 'numerada' | 'tarea',
  nivel: number,
): JSONContent[] {
  const salida: JSONContent[] = [];
  for (const item of lista.content ?? []) {
    const marcada = item.attrs?.['checked'] === true;
    let primero = true;

    for (const hijo of item.content ?? []) {
      const anidada = hijo.type ? LISTAS[hijo.type] : undefined;
      if (anidada) {
        // Sublista: mismos ítems, un nivel más adentro.
        salida.push(...itemsDeLista(hijo, anidada, Math.min(nivel + 1, NIVEL_MAX)));
        continue;
      }
      if (primero && hijo.type === 'paragraph') {
        // El primer párrafo ES la línea de la lista.
        salida.push({
          type: 'bloqueLista',
          attrs: { tipo, nivel, marcada },
          content: hijo.content,
        });
        primero = false;
        continue;
      }
      // Párrafos extra del ítem: quedan como bloques sueltos a esa altura.
      if (hijo.content) hijo.content = aplanar(hijo.content, nivel);
      salida.push(hijo);
    }

    // Ítem vacío: al menos deja la línea.
    if (primero) salida.push({ type: 'bloqueLista', attrs: { tipo, nivel, marcada } });
  }
  return salida;
}
