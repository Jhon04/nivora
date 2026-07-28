import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';

import { BlockDrag } from './block-drag';
import { BloqueLista } from './lista-plana';

function mover(el: Element | Document, x: number, y: number): void {
  el.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));
}

function centro(el: Element): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/**
 * Suelta lo agarrado en la mitad inferior de `destino`. `x` es absoluta; si no
 * se indica, se suelta al principio de la línea (sangría 0).
 */
function soltarBajo(destino: Element, x?: number): void {
  const r = destino.getBoundingClientRect();
  document.dispatchEvent(
    new MouseEvent('mousemove', {
      clientX: x ?? r.left + 2,
      clientY: r.bottom - 2,
      bubbles: true,
    }),
  );
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
}

/**
 * Hoja de estilos donde vive la regla del fantasma. La regla rival se inserta
 * ahí mismo y al final: así se garantiza que va DESPUÉS en la cascada, sin
 * depender de en qué orden inyecte los estilos el navegador de los tests.
 */
function hojaDelFantasma(): CSSStyleSheet {
  for (const hoja of Array.from(document.styleSheets)) {
    let reglas: CSSRuleList;
    try {
      reglas = hoja.cssRules;
    } catch {
      continue;
    }
    for (const r of Array.from(reglas)) {
      if ((r as CSSStyleRule).selectorText?.includes('block-drag-ghost')) return hoja;
    }
  }
  throw new Error('no se encontró la hoja con los estilos del fantasma');
}

const LISTA = (texto: string, nivel = 0): string =>
  `<div data-tipo="vinetas" data-nivel="${nivel}">${texto}</div>`;

describe('BlockDrag', () => {
  let host: HTMLElement;
  let editor: Editor;

  beforeEach(() => {
    host = document.createElement('div');
    host.style.width = '600px';
    host.style.marginLeft = '80px'; // deja hueco a la izquierda para el handle
    document.body.appendChild(host);
    editor = new Editor({
      element: host,
      extensions: [
        StarterKit.configure({
          bulletList: false,
          orderedList: false,
          listItem: false,
          listKeymap: false,
        }),
        BloqueLista,
        BlockDrag,
      ],
      content: `<p>uno</p>${LISTA('aaa')}${LISTA('bbb')}<p>dos</p>`,
    });
  });

  afterEach(() => {
    editor.destroy();
    host.remove();
    document
      .querySelectorAll('.block-drag-handle, .block-drop-indicator, .block-drag-ghost, .block-menu')
      .forEach((n) => n.remove());
  });

  const pm = (): HTMLElement => host.querySelector('.ProseMirror') as HTMLElement;
  const handle = (): HTMLElement => document.querySelector('.block-drag-handle') as HTMLElement;
  const lineas = (): HTMLElement[] => Array.from(pm().querySelectorAll('.bl'));
  /** Texto de cada bloque, sin el párrafo vacío que TrailingNode añade al
   *  final cuando el documento no termina en párrafo. */
  const textos = (): string[] => {
    const t = Array.from(pm().children).map((n) => n.textContent ?? '');
    if (t.length > 1 && t.at(-1) === '') t.pop();
    return t;
  };
  const niveles = (): string[] => lineas().map((n) => n.getAttribute('data-nivel') ?? '');
  const indicador = (): HTMLElement =>
    document.querySelector('.block-drop-indicator') as HTMLElement;

  it('coloca el handle en el margen, nunca sobre la viñeta', () => {
    const li = lineas()[1];
    const c = centro(li);
    mover(pm(), c.x, c.y);

    const h = handle().getBoundingClientRect();
    expect(Math.round(h.left)).toBe(Math.round(pm().getBoundingClientRect().left - 28));
    // La viñeta se pinta en el hueco izquierdo del propio bloque.
    expect(h.right).toBeLessThanOrEqual(li.getBoundingClientRect().left);
  });

  it('aparece en cualquier punto de la línea, no solo sobre el texto', () => {
    const r = lineas()[1].getBoundingClientRect();
    const y = r.top + r.height / 2;
    const er = pm().getBoundingClientRect();

    mover(document, er.right - 4, y);
    expect(handle().style.display).toBe('flex');
    const arriba = handle().getBoundingClientRect().top;

    mover(document, er.left - 20, y);
    expect(handle().style.display).toBe('flex');
    expect(handle().getBoundingClientRect().top).toBe(arriba);
  });

  it('reordena la línea al soltarla en otro hueco', () => {
    const c = centro(lineas()[0]);
    mover(pm(), c.x, c.y);
    handle().dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    soltarBajo(lineas()[1]);

    expect(textos()).toEqual(['uno', 'bbb', 'aaa', 'dos']);
    expect(niveles()).toEqual(['0', '0']); // sin cambio de sangría
  });

  it('destaca un momento el bloque recién soltado', () => {
    const c = centro(lineas()[0]);
    mover(pm(), c.x, c.y);
    handle().dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    soltarBajo(lineas()[1]);

    // La línea movida ("aaa") queda marcada tras el salto.
    const marcados = Array.from(pm().querySelectorAll('.block-soltado'));
    expect(marcados.length).toBe(1);
    expect(marcados[0].textContent).toBe('aaa');
  });

  it('soltar más a la derecha sangra la línea', () => {
    const c = centro(lineas()[0]);
    mover(pm(), c.x, c.y);
    handle().dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    const destino = lineas()[1];
    const escalon = parseFloat(getComputedStyle(pm()).fontSize) * 1.6;
    soltarBajo(destino, pm().getBoundingClientRect().left + escalon);

    expect(textos()).toEqual(['uno', 'bbb', 'aaa', 'dos']);
    expect(niveles()).toEqual(['0', '1']); // "aaa" cae dentro de "bbb"
  });

  it('soltar a la izquierda saca la línea de la sangría', () => {
    editor.commands.setContent(`<p>uno</p>${LISTA('aaa')}${LISTA('hijo', 1)}<p>dos</p>`);
    const c = centro(lineas()[1]);
    mover(pm(), c.x, c.y);
    handle().dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    // Al principio de la línea del último párrafo → sangría 0.
    const parrafos = pm().querySelectorAll(':scope > p');
    soltarBajo(parrafos[parrafos.length - 1]);

    expect(textos()).toEqual(['uno', 'aaa', 'dos', 'hijo']);
    expect(niveles()).toEqual(['0', '0']);
  });

  it('no dibuja línea pegada a la fila que se está moviendo', () => {
    const propio = lineas()[0];
    const c = centro(propio);
    mover(pm(), c.x, c.y);
    handle().dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    const irA = (el: Element, borde: 'top' | 'bottom'): void => {
      const r = el.getBoundingClientRect();
      document.dispatchEvent(
        new MouseEvent('mousemove', {
          clientX: r.left + 2,
          clientY: borde === 'top' ? r.top + 2 : r.bottom - 2,
          bubbles: true,
        }),
      );
    };

    irA(propio, 'top');
    expect(indicador().style.display).toBe('none');
    irA(propio, 'bottom');
    expect(indicador().style.display).toBe('none');

    irA(lineas()[1], 'bottom');
    expect(indicador().style.display).toBe('block');

    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });

  it('pinta una sola línea por hueco, se llegue por arriba o por abajo', () => {
    const c = centro(lineas()[0]);
    mover(pm(), c.x, c.y);
    handle().dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    const segunda = lineas()[1].getBoundingClientRect();
    document.dispatchEvent(
      new MouseEvent('mousemove', {
        clientX: segunda.left + 2,
        clientY: segunda.bottom - 2,
        bubbles: true,
      }),
    );
    const porAbajo = indicador().style.top;

    const parrafos = pm().querySelectorAll(':scope > p');
    const ultimo = parrafos[parrafos.length - 1].getBoundingClientRect();
    document.dispatchEvent(
      new MouseEvent('mousemove', {
        clientX: ultimo.left + 2,
        clientY: ultimo.top + 2,
        bubbles: true,
      }),
    );

    expect(indicador().style.top).toBe(porAbajo);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });

  it('muestra una copia del bloque siguiendo al cursor', () => {
    const propio = lineas()[0];
    const c = centro(propio);
    mover(pm(), c.x, c.y);
    handle().dispatchEvent(
      new MouseEvent('mousedown', { clientX: c.x, clientY: c.y, bubbles: true }),
    );

    const destino = lineas()[1].getBoundingClientRect();
    document.dispatchEvent(
      new MouseEvent('mousemove', {
        clientX: destino.left + 2,
        clientY: destino.bottom - 2,
        bubbles: true,
      }),
    );

    const fantasma = document.querySelector('.block-drag-ghost') as HTMLElement;
    expect(fantasma).toBeTruthy();
    expect(fantasma.textContent).toContain('aaa');
    expect(propio.classList.contains('block-arrastrando')).toBe(true);

    /* Que exista no basta: tiene que quedar FLOTANDO sobre el documento. La
       copia lleva también la clase ProseMirror para heredar los estilos del
       contenido, y prosemirror-view inyecta en runtime
       `.ProseMirror { position: relative }`. Esa regla empata en especificidad
       con la nuestra y va después en la cascada, así que si no la ganamos la
       copia cae al flujo del documento y se pinta fuera de la pantalla.
       Aquí se recrea esa competencia insertando la regla rival al final de
       nuestra propia hoja, que es donde peor lo tiene la nuestra. */
    const hoja = hojaDelFantasma();
    const iRival = hoja.insertRule('.ProseMirror { position: relative }', hoja.cssRules.length);
    const posicion = getComputedStyle(fantasma).position;
    hoja.deleteRule(iRival);
    expect(posicion).toBe('fixed');

    const primero = fantasma.style.transform;

    document.dispatchEvent(
      new MouseEvent('mousemove', {
        clientX: destino.left + 60,
        clientY: destino.bottom + 30,
        bubbles: true,
      }),
    );
    expect(fantasma.style.transform).not.toBe(primero);

    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(document.querySelector('.block-drag-ghost')).toBeNull();
    expect(pm().querySelector('.block-arrastrando')).toBeNull();
  });

  it('arrastra el grupo entero si hay varios bloques seleccionados', () => {
    editor.commands.setContent('<p>uno</p><p>dos</p><p>tres</p>');
    editor.commands.setTextSelection({ from: 2, to: 8 });

    const parrafos = Array.from(pm().querySelectorAll(':scope > p')) as HTMLElement[];
    const c = centro(parrafos[0]);
    mover(pm(), c.x, c.y);
    handle().dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    soltarBajo(parrafos[2]);

    expect(textos().slice(0, 3)).toEqual(['tres', 'uno', 'dos']);
  });

  it('clic en el handle abre el menú del bloque', () => {
    const c = centro(lineas()[0]);
    mover(pm(), c.x, c.y);
    handle().dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

    const menu = document.querySelector('.block-menu') as HTMLElement;
    expect(menu).toBeTruthy();
    const opciones = Array.from(menu.querySelectorAll('.menu-txt')).map((b) => b.textContent);
    expect(opciones).toContain('Duplicar');
    expect(opciones).toContain('Eliminar');
    expect(opciones).toContain('Lista de tareas');
    expect(pm().querySelector('.block-activo')).toBeTruthy();
  });

  it('el menú duplica el bloque', () => {
    const c = centro(lineas()[0]);
    mover(pm(), c.x, c.y);
    handle().dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

    const menu = document.querySelector('.block-menu') as HTMLElement;
    const duplicar = Array.from(menu.querySelectorAll('.menu-item')).find(
      (b) => b.querySelector('.menu-txt')?.textContent === 'Duplicar',
    ) as HTMLElement;
    duplicar.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(textos()).toEqual(['uno', 'aaa', 'aaa', 'bbb', 'dos']);
    expect(document.querySelector('.block-menu')).toBeNull();
  });
});
