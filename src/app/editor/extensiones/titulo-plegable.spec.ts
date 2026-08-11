import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';

import { CLASE_OCULTO, TituloPlegable } from './titulo-plegable';

/**
 * Nota de prueba con dos secciones y una subsección:
 *
 *   H1 Uno · p uno-a · H2 Uno-uno · p uno-uno-a · H1 Dos · p dos-a
 */
const NOTA =
  '<h1>Uno</h1><p>uno-a</p><h2>Uno-uno</h2><p>uno-uno-a</p><h1>Dos</h1><p>dos-a</p>';

function montar(html = NOTA): { editor: Editor; host: HTMLElement } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const editor = new Editor({
    element: host,
    extensions: [StarterKit.configure({ heading: false }), TituloPlegable.configure({ levels: [1, 2, 3, 4] })],
    content: html,
  });
  return { editor, host };
}

/** Posición del título cuyo texto se pide. */
function posDe(editor: Editor, texto: string): number {
  let encontrada = -1;
  editor.state.doc.forEach((nodo, pos) => {
    if (nodo.type.name === 'heading' && nodo.textContent === texto) encontrada = pos;
  });
  return encontrada;
}

/**
 * Texto de los bloques que ahora mismo están escondidos. La flecha se quita
 * antes de leer: es un widget que vive dentro del título y su glifo (el nombre
 * del icono Material) contaría como texto del bloque.
 */
function ocultos(host: HTMLElement): string[] {
  return Array.from(host.querySelectorAll(`.${CLASE_OCULTO}`)).map((n) => {
    const copia = n.cloneNode(true) as HTMLElement;
    copia.querySelectorAll('.plegar-caret').forEach((c) => c.remove());
    return copia.textContent ?? '';
  });
}

describe('TituloPlegable', () => {
  let editor: Editor;
  let host: HTMLElement;

  beforeEach(() => ({ editor, host } = montar()));
  afterEach(() => {
    editor.destroy();
    host.remove();
  });

  it('esconde lo que cuelga del título, subsecciones incluidas', () => {
    editor.commands.alternarPlegado(posDe(editor, 'Uno'));

    // Todo lo que hay entre «Uno» y el siguiente H1, sin excepciones.
    expect(ocultos(host)).toEqual(['uno-a', 'Uno-uno', 'uno-uno-a']);
  });

  it('un título de nivel más alto corta la sección', () => {
    editor.commands.alternarPlegado(posDe(editor, 'Uno-uno'));

    // El H2 no se lleva por delante el H1 que viene después, ni lo suyo.
    expect(ocultos(host)).toEqual(['uno-uno-a']);
  });

  it('no cambia la estructura del documento', () => {
    const antes = editor.getJSON().content?.map((n) => n.type);

    editor.commands.alternarPlegado(posDe(editor, 'Uno'));

    /* Lo contrario de Notion a propósito: plegar NO mete los bloques dentro del
       título. La nota sigue siendo la misma lista de hermanos. */
    expect(editor.getJSON().content?.map((n) => n.type)).toEqual(antes);
  });

  it('plegar y desplegar deja la nota como estaba', () => {
    const pos = posDe(editor, 'Uno');
    editor.commands.alternarPlegado(pos);
    editor.commands.alternarPlegado(pos);

    expect(ocultos(host)).toEqual([]);
  });

  it('el título plegado se guarda en la nota', () => {
    editor.commands.alternarPlegado(posDe(editor, 'Uno'));

    // Se guarda para que al reabrirla siga plegada; los demás no ensucian el
    // fichero con un atributo que no hace falta.
    const html = editor.getHTML();
    expect(html).toContain('<h1 data-plegado="true">Uno</h1>');
    expect(html).toContain('<h1>Dos</h1>');
  });

  it('una nota escrita antes de esto se abre sin plegar', () => {
    const { editor: viejo, host: h } = montar('<h1>Uno</h1><p>uno-a</p>');

    expect(ocultos(h)).toEqual([]);
    expect(viejo.getHTML()).toContain('<h1>Uno</h1>');

    viejo.destroy();
    h.remove();
  });

  it('saca el cursor de lo que va a esconder', () => {
    // Cursor dentro del párrafo que está a punto de desaparecer.
    const parrafo = posDe(editor, 'Uno') + editor.state.doc.nodeAt(posDe(editor, 'Uno'))!.nodeSize;
    editor.commands.setTextSelection(parrafo + 2);

    editor.commands.alternarPlegado(posDe(editor, 'Uno'));

    /* Un cursor dentro de un bloque con `display:none` no se ve, pero el
       teclado seguiría escribiendo ahí. Tiene que acabar en el título. */
    const seleccion = editor.state.selection.from;
    expect(seleccion).toBeLessThanOrEqual(posDe(editor, 'Uno') + 'Uno'.length + 1);
  });

  it('desplegarHasta abre las secciones que tapan una posición', () => {
    editor.commands.alternarPlegado(posDe(editor, 'Uno'));
    const escondido = posDe(editor, 'Uno-uno');
    expect(ocultos(host).length).toBeGreaterThan(0);

    editor.commands.desplegarHasta(escondido);

    // Es lo que permite saltar desde el índice a un título tapado.
    expect(ocultos(host)).toEqual([]);
  });

  it('un título sin nada detrás no ofrece flecha', () => {
    const { editor: solo, host: h } = montar('<p>antes</p><h1>Final</h1>');

    expect(h.querySelectorAll('.plegar-caret').length).toBe(0);

    solo.destroy();
    h.remove();
  });

  it('pone flecha en los títulos que sí tienen sección', () => {
    // Los tres títulos de NOTA menos ninguno: los tres llevan algo detrás.
    expect(host.querySelectorAll('.plegar-caret').length).toBe(3);
  });

  /**
   * El camino que recorre de verdad el usuario. Va aparte de los tests del
   * comando porque lo delicado está en el medio: del botón pulsado hay que
   * deducir la posición del título en el documento.
   */
  it('pulsar la flecha pliega ese título y no otro', () => {
    const flechas = host.querySelectorAll<HTMLElement>('.plegar-caret');
    // La segunda es la del H2 «Uno-uno».
    flechas[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(ocultos(host)).toEqual(['uno-uno-a']);
  });

  it('pulsarla otra vez lo despliega', () => {
    const flecha = (): HTMLElement => host.querySelectorAll<HTMLElement>('.plegar-caret')[0];
    flecha().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(ocultos(host).length).toBeGreaterThan(0);

    flecha().dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(ocultos(host)).toEqual([]);
  });
});
