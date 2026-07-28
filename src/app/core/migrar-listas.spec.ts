import { JSONContent } from '@tiptap/core';

import { migrarListas } from './migrar-listas';

/** Resumen legible de los bloques de nivel superior. */
function resumen(doc: JSONContent): string[] {
  return (doc.content ?? []).map((n) =>
    n.type === 'bloqueLista'
      ? `${n.attrs?.['tipo']}${n.attrs?.['nivel']}${n.attrs?.['marcada'] ? '✓' : ''}:${(
          n.content ?? []
        )
          .map((c) => c['text'] ?? '')
          .join('')}`
      : (n.type ?? '?'),
  );
}

/** Ítem del esquema antiguo: listItem con un párrafo dentro. */
function item(texto: string, extra: JSONContent[] = []): JSONContent {
  return {
    type: 'listItem',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: texto }] },
      ...extra,
    ],
  };
}

describe('migrarListas', () => {
  it('aplana una lista con viñetas', () => {
    const doc: JSONContent = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'antes' }] },
        { type: 'bulletList', content: [item('a'), item('b')] },
      ],
    };
    expect(migrarListas(doc)).toBe(true);
    expect(resumen(doc)).toEqual(['paragraph', 'vinetas0:a', 'vinetas0:b']);
  });

  it('convierte el anidamiento en niveles', () => {
    const doc: JSONContent = {
      type: 'doc',
      content: [
        {
          type: 'orderedList',
          content: [
            item('a', [{ type: 'orderedList', content: [item('a1'), item('a2')] }]),
            item('b'),
          ],
        },
      ],
    };
    migrarListas(doc);
    expect(resumen(doc)).toEqual([
      'numerada0:a',
      'numerada1:a1',
      'numerada1:a2',
      'numerada0:b',
    ]);
  });

  it('conserva el estado de las tareas', () => {
    const doc: JSONContent = {
      type: 'doc',
      content: [
        {
          type: 'taskList',
          content: [
            { ...item('hecha'), attrs: { checked: true } },
            { ...item('pendiente'), attrs: { checked: false } },
          ],
        },
      ],
    };
    migrarListas(doc);
    expect(resumen(doc)).toEqual(['tarea0✓:hecha', 'tarea0:pendiente']);
  });

  it('no toca un documento que ya está migrado', () => {
    const doc: JSONContent = {
      type: 'doc',
      content: [
        { type: 'bloqueLista', attrs: { tipo: 'vinetas', nivel: 0 }, content: [] },
        { type: 'paragraph' },
      ],
    };
    expect(migrarListas(doc)).toBe(false);
  });
});
