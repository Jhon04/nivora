import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';

import { BloqueLista } from './lista-plana';

function nuevoEditor(html = '<p>uno</p>'): Editor {
  const host = document.createElement('div');
  document.body.appendChild(host);
  return new Editor({
    element: host,
    extensions: [
      StarterKit.configure({
        bulletList: false,
        orderedList: false,
        listItem: false,
        listKeymap: false,
      }),
      BloqueLista,
    ],
    content: html,
  });
}

/**
 * Tipos y niveles de los bloques del documento, para leer de un vistazo. Se
 * descarta el párrafo vacío final que añade TrailingNode (StarterKit) cuando el
 * documento termina en algo que no es un párrafo.
 */
function estructura(editor: Editor): string[] {
  const bloques = [...(editor.getJSON().content ?? [])];
  const ultimo = bloques.at(-1);
  if (bloques.length > 1 && ultimo?.type === 'paragraph' && !ultimo.content) bloques.pop();
  return bloques.map((n) =>
    n.type === 'bloqueLista'
      ? `${n.attrs?.['tipo']}${n.attrs?.['nivel']}${n.attrs?.['marcada'] ? '✓' : ''}:${texto(n)}`
      : `${n.type}:${texto(n)}`,
  );
}

function texto(n: unknown): string {
  const contenido = (n as { content?: { text?: string }[] }).content ?? [];
  return contenido.map((c) => c.text ?? '').join('');
}

describe('BloqueLista (listas planas)', () => {
  let editor: Editor;

  /** Manda la tecla como lo haría el navegador; devuelve si se consumió. */
  function pulsar(key: string, shift = false): boolean {
    const ev = new KeyboardEvent('keydown', {
      key,
      shiftKey: shift,
      bubbles: true,
      cancelable: true,
    });
    editor.view.dom.dispatchEvent(ev);
    return ev.defaultPrevented;
  }

  afterEach(() => {
    const el = editor.options.element as HTMLElement;
    editor.destroy();
    el.remove();
  });

  it('las líneas son bloques hermanos, no una lista anidada', () => {
    editor = nuevoEditor('<p>uno</p><p>dos</p>');
    editor.commands.selectAll();
    editor.commands.alternarLista('vinetas');

    expect(estructura(editor)).toEqual(['vinetas0:uno', 'vinetas0:dos']);
    // Ni rastro de contenedores de lista.
    expect(editor.getHTML()).not.toContain('<ul');
    expect(editor.getHTML()).not.toContain('<li');
  });

  it('alternar dos veces devuelve a párrafo', () => {
    editor = nuevoEditor('<p>uno</p>');
    // Con el cursor dentro de la línea, que es como se usa desde el toolbar.
    editor.commands.setTextSelection(2);
    editor.commands.alternarLista('numerada');
    expect(estructura(editor)).toEqual(['numerada0:uno']);
    editor.commands.alternarLista('numerada');
    expect(estructura(editor)).toEqual(['paragraph:uno']);
  });

  it('cambia de tipo sin perder la sangría', () => {
    editor = nuevoEditor('<p>uno</p><p>dos</p>');
    editor.commands.selectAll();
    editor.commands.alternarLista('vinetas');
    editor.commands.setTextSelection(9); // dentro de "dos"
    editor.commands.cambiarNivel(1);
    editor.commands.alternarLista('tarea');

    expect(estructura(editor)).toEqual(['vinetas0:uno', 'tarea1:dos']);
  });

  it('la sangría no puede saltar más de un escalón', () => {
    editor = nuevoEditor('<p>uno</p><p>dos</p>');
    editor.commands.selectAll();
    editor.commands.alternarLista('vinetas');
    editor.commands.setTextSelection(9);

    editor.commands.cambiarNivel(1);
    expect(estructura(editor)[1]).toBe('vinetas1:dos');
    // El anterior sigue en 0, así que no puede pasar de 1.
    expect(editor.commands.cambiarNivel(1)).toBe(false);
    expect(estructura(editor)[1]).toBe('vinetas1:dos');
  });

  it('la primera línea nunca se sangra', () => {
    editor = nuevoEditor('<p>uno</p>');
    editor.commands.selectAll();
    editor.commands.alternarLista('vinetas');
    expect(editor.commands.cambiarNivel(1)).toBe(false);
    expect(estructura(editor)).toEqual(['vinetas0:uno']);
  });

  it('pega listas anidadas de fuera aplanándolas', () => {
    editor = nuevoEditor(
      '<ul><li>a<ul><li>a1</li></ul></li><li>b</li></ul><ol><li>n1</li></ol>',
    );
    expect(estructura(editor)).toEqual([
      'vinetas0:a',
      'vinetas1:a1',
      'vinetas0:b',
      'numerada0:n1',
    ]);
  });

  it('reconoce las tareas al pegarlas', () => {
    editor = nuevoEditor(
      '<ul data-type="taskList"><li data-checked="true"><input type="checkbox"><span>hecho</span></li></ul>',
    );
    expect(estructura(editor)).toEqual(['tarea0✓:hecho']);
  });

  it('sobrevive a la ida y vuelta por HTML', () => {
    editor = nuevoEditor('<p>uno</p><p>dos</p>');
    editor.commands.selectAll();
    editor.commands.alternarLista('numerada');
    editor.commands.setTextSelection(9);
    editor.commands.cambiarNivel(1);

    const html = editor.getHTML();
    const otro = nuevoEditor(html);
    expect(estructura(otro)).toEqual(estructura(editor));
    const el = otro.options.element as HTMLElement;
    otro.destroy();
    el.remove();
  });

  it('Enter continúa la lista en vez de cortarla', () => {
    editor = nuevoEditor('<p>uno</p>');
    editor.commands.setTextSelection(2);
    editor.commands.alternarLista('numerada');
    // Cursor al final de la línea, que es cuando ProseMirror creaba un párrafo.
    editor.commands.setTextSelection(4);
    pulsar('Enter');

    expect(estructura(editor)).toEqual(['numerada0:uno', 'numerada0:']);

    // Y se puede seguir escribiendo y sangrando la línea nueva.
    editor.commands.insertContent('dos');
    pulsar('Tab');
    expect(estructura(editor)).toEqual(['numerada0:uno', 'numerada1:dos']);
  });

  it('Enter parte la línea por el cursor conservando el tipo', () => {
    editor = nuevoEditor('<p>unodos</p>');
    editor.commands.setTextSelection(2);
    editor.commands.alternarLista('vinetas');
    editor.commands.setTextSelection(4); // entre "uno" y "dos"
    pulsar('Enter');

    expect(estructura(editor)).toEqual(['vinetas0:uno', 'vinetas0:dos']);
  });

  it('Enter en una línea vacía la saca de la lista', () => {
    editor = nuevoEditor('<p>uno</p><p>dos</p>');
    editor.commands.selectAll();
    editor.commands.alternarLista('vinetas');
    editor.commands.setTextSelection(9);
    editor.commands.cambiarNivel(1);

    // Vaciamos la segunda línea y pulsamos Enter: primero pierde sangría…
    editor.commands.setTextSelection({ from: 6, to: 9 }); // todo el texto "dos"
    editor.commands.deleteSelection();
    pulsar('Enter');
    expect(estructura(editor)[1]).toBe('vinetas0:');
    // …y en el nivel 0 deja de ser lista.
    pulsar('Enter');
    expect(estructura(editor)[1]).toBe('paragraph:');
  });

  it('el Tab sangra la línea y nunca deja escapar el foco', () => {
    editor = nuevoEditor('<p>uno</p><p>dos</p>');
    editor.commands.selectAll();
    editor.commands.alternarLista('numerada');

    // Segunda línea: se sangra y la tecla se consume.
    editor.commands.setTextSelection(9);
    expect(pulsar('Tab')).toBe(true);
    expect(estructura(editor)[1]).toBe('numerada1:dos');

    // Ya no puede bajar más, pero la tecla se sigue consumiendo: si no, el
    // navegador movería el foco al siguiente botón.
    expect(pulsar('Tab')).toBe(true);
    expect(estructura(editor)[1]).toBe('numerada1:dos');

    // Shift+Tab la devuelve, y en la primera línea tampoco se escapa.
    expect(pulsar('Tab', true)).toBe(true);
    expect(estructura(editor)[1]).toBe('numerada0:dos');
    editor.commands.setTextSelection(2);
    expect(pulsar('Tab')).toBe(true);
    expect(estructura(editor)[0]).toBe('numerada0:uno');
  });

  it('pinta la casilla solo en las tareas', () => {
    editor = nuevoEditor('<p>uno</p>');
    editor.commands.selectAll();
    editor.commands.alternarLista('tarea');
    const dom = editor.view.dom;
    expect(dom.querySelector('.bl[data-tipo="tarea"] input[type=checkbox]')).toBeTruthy();

    editor.commands.alternarLista('vinetas');
    expect(dom.querySelector('input[type=checkbox]')).toBeNull();
    expect(dom.querySelector('.bl[data-tipo="vinetas"]')).toBeTruthy();
  });
});
