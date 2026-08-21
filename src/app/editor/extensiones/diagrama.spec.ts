import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';

import { Diagrama } from './diagrama';

const FLUJO = 'graph TD\n  A[Servidor web] --> B[Base de datos]';

/** Monta un editor con un único diagrama y devuelve su NodeView. */
function montar(codigo = ''): { editor: Editor; bloque: HTMLElement } {
  const host = document.createElement('div');
  document.body.appendChild(host);

  const editor = new Editor({
    element: host,
    extensions: [StarterKit, Diagrama],
    content: {
      type: 'doc',
      content: [{ type: 'diagrama', attrs: { formato: 'mermaid', codigo } }],
    },
  });

  const bloque = host.querySelector<HTMLElement>('.bloque-diagrama');
  if (!bloque) throw new Error('el bloque de diagrama no se pintó');
  return { editor, bloque };
}

const area = (b: HTMLElement) => b.querySelector<HTMLTextAreaElement>('.diagrama-codigo')!;
const alternar = (b: HTMLElement) => b.querySelector<HTMLButtonElement>('.diagrama-alternar')!;

/** El nodo diagrama tal y como se guardaría en el fichero de la nota. */
function nodoGuardado(editor: Editor): { type?: string; attrs?: Record<string, unknown> } {
  return (editor.getJSON().content ?? []).find((n) => n.type === 'diagrama') ?? {};
}

describe('bloque de diagrama', () => {
  let editor: Editor | undefined;

  afterEach(() => {
    editor?.destroy();
    editor = undefined;
    document.querySelectorAll('.ProseMirror').forEach((e) => e.parentElement?.remove());
  });

  it('los estilos le llegan de verdad', () => {
    const m = montar();
    editor = m.editor;

    /*
     * Mismo tropiezo que con el bloque cifrado: el NodeView crea su DOM con
     * `document.createElement`, así que no lleva el `[_ngcontent-…]` que Angular
     * sella en los selectores de un estilo de componente. Estas reglas tienen
     * que vivir en `src/styles.scss`; en `editor/editor.scss` no alcanzarían
     * nada y el bloque se vería como un textarea suelto.
     */
    const css = getComputedStyle(m.bloque);
    expect(css.borderTopStyle).toBe('solid', 'el recuadro');
    expect(css.borderRadius).not.toBe('0px');
  });

  /*
   * El test que sostiene el contrato con el indexador. Si el código acabara en
   * un nodo de texto, `db::extraer_texto` —que recoge toda clave `text`— metería
   * «graph», «TD» y los identificadores sueltos en el índice FTS, y buscar
   * "graph" devolvería cualquier nota con un diagrama.
   */
  it('guarda el código en attrs y no como texto del documento', () => {
    const m = montar(FLUJO);
    editor = m.editor;

    const nodo = nodoGuardado(m.editor);
    expect(nodo.attrs?.['codigo']).toBe(FLUJO);
    expect(nodo.attrs?.['formato']).toBe('mermaid');
    // Un `atom` no tiene hijos: no hay dónde esconder texto.
    expect(JSON.stringify(m.editor.getJSON())).not.toContain('"text"');
  });

  it('lo que se escribe en el campo acaba en el documento', () => {
    const m = montar();
    editor = m.editor;

    area(m.bloque).value = FLUJO;
    // `blur` vuelca sin esperar al antirrebote, que es justo para lo que está:
    // cerrar la nota recién escrito no puede perder las últimas letras.
    area(m.bloque).dispatchEvent(new Event('blur'));

    expect(nodoGuardado(m.editor).attrs?.['codigo']).toBe(FLUJO);
  });

  it('el diagrama nuevo se abre en el código y el que ya tiene, en el dibujo', () => {
    const vacio = montar();
    expect(vacio.bloque.dataset['modo']).toBe('codigo', 'no hay nada que mirar todavía');
    vacio.editor.destroy();

    const m = montar(FLUJO);
    editor = m.editor;
    expect(m.bloque.dataset['modo']).toBe('vista', 'al abrir la nota se quiere ver el dibujo');
  });

  it('el interruptor cambia de dibujo a código y vuelve', () => {
    const m = montar(FLUJO);
    editor = m.editor;

    alternar(m.bloque).click();
    expect(m.bloque.dataset['modo']).toBe('codigo');

    alternar(m.bloque).click();
    expect(m.bloque.dataset['modo']).toBe('vista');
  });

  it('el tabulador sangra en vez de saltar de control', () => {
    const m = montar();
    editor = m.editor;

    const campo = area(m.bloque);
    campo.value = 'subgraph Red';
    campo.selectionStart = campo.selectionEnd = 0;

    const tab = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
    campo.dispatchEvent(tab);

    // En Mermaid la sangría separa un `subgraph` de lo que contiene.
    expect(campo.value).toBe('  subgraph Red');
    expect(tab.defaultPrevented).toBe(true, 'el foco no puede irse del campo');
  });
});
