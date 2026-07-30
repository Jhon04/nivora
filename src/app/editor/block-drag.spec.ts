import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';

import { BlockDrag } from './block-drag';
import { BloqueLista } from './lista-plana';
import { AssetImage } from './asset-image';
import { Secreto } from './secreto';

/** PNG 1x1 transparente: sirve de imagen real sin tocar el disco ni Tauri. */
const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

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

/**
 * Desplazamiento automático al arrastrar cerca de un borde.
 *
 * Sin esto, mover un bloque por debajo de una imagen alta era imposible: el
 * hueco de destino queda fuera de la pantalla y no hay forma de llevar el ratón
 * hasta él, porque para desplazar habría que soltar el botón.
 */
describe('BlockDrag · desplazamiento al arrastrar', () => {
  let caja: HTMLElement;
  let host: HTMLElement;
  let editor: Editor;
  /** Callbacks de rAF pendientes: el bucle se hace correr a mano. */
  let cuadros: FrameRequestCallback[];

  beforeEach(() => {
    cuadros = [];
    spyOn(window, 'requestAnimationFrame').and.callFake((cb: FrameRequestCallback) => {
      cuadros.push(cb);
      return cuadros.length;
    });

    caja = document.createElement('div');
    caja.style.cssText = 'height:300px;width:600px;margin-left:80px;overflow-y:auto';
    document.body.appendChild(caja);
    host = document.createElement('div');
    caja.appendChild(host);

    editor = new Editor({
      element: host,
      extensions: [StarterKit, BlockDrag],
      // Bastantes párrafos para que el contenedor tenga de sobra que desplazar.
      content: Array.from({ length: 40 }, (_, i) => `<p>linea ${i}</p>`).join(''),
    });
  });

  afterEach(() => {
    editor.destroy();
    caja.remove();
    document
      .querySelectorAll('.block-drag-handle, .block-drop-indicator, .block-drag-ghost, .block-menu')
      .forEach((n) => n.remove());
  });

  const pm = (): HTMLElement => host.querySelector('.ProseMirror') as HTMLElement;
  const handle = (): HTMLElement => document.querySelector('.block-drag-handle') as HTMLElement;
  const correr = (n: number): void => {
    for (let i = 0; i < n; i++) cuadros.shift()?.(0);
  };

  /** Agarra el primer bloque y pasa el umbral que distingue arrastre de clic. */
  function empezarArrastre(): void {
    const c = centro(pm().children[0]);
    mover(pm(), c.x, c.y);
    handle().dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    mover(document, c.x, c.y + 10);
  }

  it('desplaza al acercarse al borde inferior', () => {
    empezarArrastre();
    const r = caja.getBoundingClientRect();
    mover(document, r.left + 300, r.bottom - 6);

    const antes = caja.scrollTop;
    correr(6);
    expect(caja.scrollTop).toBeGreaterThan(antes);
  });

  it('vuelve hacia arriba en el borde de arriba', () => {
    empezarArrastre();
    caja.scrollTop = 200;
    const r = caja.getBoundingClientRect();
    mover(document, r.left + 300, r.top + 6);

    correr(6);
    expect(caja.scrollTop).toBeLessThan(200);
  });

  it('no desplaza nada en el centro', () => {
    empezarArrastre();
    const r = caja.getBoundingClientRect();
    mover(document, r.left + 300, r.top + r.height / 2);

    const antes = caja.scrollTop;
    correr(6);
    expect(caja.scrollTop).toBe(antes);
  });

  it('para al soltar', () => {
    empezarArrastre();
    const r = caja.getBoundingClientRect();
    mover(document, r.left + 300, r.bottom - 6);
    correr(3);
    const alSoltar = caja.scrollTop;

    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    correr(6); // los fotogramas que quedaran en la cola no deben mover nada

    expect(caja.scrollTop).toBe(alSoltar);
  });

  /** Rueda mientras se arrastra: la forma precisa de elegir el destino. */
  const rueda = (deltaY: number): WheelEvent => {
    const e = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true });
    document.dispatchEvent(e);
    return e;
  };

  it('la rueda desplaza la vista sin soltar el bloque', () => {
    empezarArrastre();
    const antes = caja.scrollTop;

    rueda(120);
    expect(caja.scrollTop).toBe(antes + 120);

    rueda(-40);
    expect(caja.scrollTop).toBe(antes + 80);
  });

  it('la rueda no la atiende nadie más', () => {
    empezarArrastre();
    // Sin `preventDefault` el navegador desplazaría ADEMÁS por su cuenta y la
    // vista se movería el doble.
    expect(rueda(120).defaultPrevented).toBeTrue();
  });

  it('la rueda cambia el destino, no solo la vista', () => {
    empezarArrastre();
    const r = caja.getBoundingClientRect();
    const y = r.top + r.height / 2;
    mover(document, r.left + 300, y);

    /* Ojo con lo que se mide aquí: el indicador es `fixed`, así que con líneas
       de la misma altura el hueco cae en el MISMO píxel de pantalla aunque el
       destino haya cambiado. Lo que hay que comprobar es dónde acaba el bloque,
       no dónde se pintó la línea. */
    rueda(600);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

    const textos = Array.from(pm().children).map((n) => n.textContent);
    expect(textos[0]).not.toBe('linea 0', 'se soltó en la parte a la que se desplazó');
    expect(textos).toContain('linea 0');
  });

  it('fuera del arrastre la rueda se comporta como siempre', () => {
    const c = centro(pm().children[0]);
    mover(pm(), c.x, c.y);
    handle().dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    // Pulsado pero sin pasar el umbral: todavía no es un arrastre.
    const antes = caja.scrollTop;

    expect(rueda(120).defaultPrevented).toBeFalse();
    expect(caja.scrollTop).toBe(antes);
  });
});

/**
 * Bloques `atom` (imagen, bloque cifrado, línea horizontal): no tienen
 * contenido en el que se pueda resolver una posición, así que `posAtCoords`
 * devuelve una posición del documento (profundidad 0) en vez de una interior.
 */
describe('BlockDrag · bloques atom', () => {
  let host: HTMLElement;
  let editor: Editor;

  beforeEach(() => {
    host = document.createElement('div');
    host.style.width = '600px';
    host.style.marginLeft = '80px';
    document.body.appendChild(host);
    editor = new Editor({
      element: host,
      extensions: [StarterKit, Secreto, AssetImage, BlockDrag],
      content: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'uno' }] },
          { type: 'secreto', attrs: { etiqueta: 'BD', datos: 'v1.xxx' } },
          { type: 'horizontalRule' },
          { type: 'paragraph', content: [{ type: 'text', text: 'dos' }] },
        ],
      },
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

  it('el handle sale sobre un bloque cifrado', () => {
    const bloque = pm().querySelector('.bloque-secreto') as HTMLElement;
    const c = centro(bloque);
    mover(pm(), c.x, c.y);

    expect(handle().style.display).toBe('flex');
    expect(Math.round(handle().getBoundingClientRect().top)).toBe(
      Math.round(bloque.getBoundingClientRect().top + 1),
    );
  });

  it('el handle sale sobre una imagen', () => {
    editor.commands.setContent({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'uno' }] },
        { type: 'image', attrs: { src: PIXEL } },
        { type: 'paragraph', content: [{ type: 'text', text: 'dos' }] },
      ],
    });

    /* Tamaño en el propio elemento: el PNG de prueba es de 1x1 y carga de forma
       asíncrona, así que su rectángulo sería de altura CERO cuando el test mira
       y el puntero no caería sobre nada. Con una regla en una hoja no basta:
       `styles.scss` ya trae `.ProseMirror img { height: auto }` con la misma
       especificidad y gana la que vaya después en la cascada. */
    const img = pm().querySelector('img') as HTMLElement;
    img.style.cssText = 'display:block;width:200px;height:120px';

    const c = centro(img);
    mover(pm(), c.x, c.y);

    expect(handle().style.display).toBe('flex');
    expect(Math.round(handle().getBoundingClientRect().top)).toBe(
      Math.round(img.getBoundingClientRect().top + 1),
    );
  });

  it('el handle sale sobre una línea horizontal', () => {
    const hr = pm().querySelector('hr') as HTMLElement;
    mover(pm(), centro(hr).x, centro(hr).y);

    expect(handle().style.display).toBe('flex');
  });

  it('en un bloque más bajo que el handle, lo centra en vez de colgarlo', () => {
    const hr = pm().querySelector('hr') as HTMLElement;
    const r = hr.getBoundingClientRect();
    mover(pm(), centro(hr).x, centro(hr).y);

    const h = handle().getBoundingClientRect();
    expect(h.height).toBeGreaterThan(r.height, 'una línea horizontal mide 2 px');
    // Centrado sobre la línea, no colgando hacia abajo: alineado por arriba
    // invadiría el bloque siguiente y parecería que el handle es de ese.
    expect(Math.round(h.top + h.height / 2)).toBe(Math.round(r.top + r.height / 2));

    const siguiente = pm().querySelector(':scope > p:last-of-type') as HTMLElement;
    expect(h.bottom).toBeLessThan(siguiente.getBoundingClientRect().top + h.height / 2);
  });

  it('un bloque atom se puede arrastrar', () => {
    const bloque = pm().querySelector('.bloque-secreto') as HTMLElement;
    const c = centro(bloque);
    mover(pm(), c.x, c.y);
    handle().dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    /* `:scope >` no es un capricho: sin él, `p:last-of-type` encuentra antes el
       <p class="secreto-nota"> que vive DENTRO del propio bloque cifrado, y
       soltar ahí es soltar sobre uno mismo — el código lo rechaza con razón y
       el test no probaba nada. */
    const parrafos = pm().querySelectorAll(':scope > p');
    soltarBajo(parrafos[parrafos.length - 1]);

    // Empieza ANTES de la línea horizontal y tiene que acabar después: así, si
    // el arrastre no llega a ocurrir, la comprobación no se cumple sola.
    const tipos = editor.getJSON().content?.map((n) => n.type) ?? [];
    expect(tipos.indexOf('secreto')).toBeGreaterThan(tipos.indexOf('horizontalRule'));
  });
});

/**
 * El handle tiene que seguir al bloque cuando se desplaza la vista.
 *
 * Al desplazar, el documento se mueve pero el ratón no, así que no llega ningún
 * `mousemove`: sin escuchar el `scroll`, el handle se quedaba clavado en la
 * pantalla y ya no correspondía a ningún bloque.
 */
describe('BlockDrag · el handle sigue al desplazar', () => {
  let caja: HTMLElement;
  let host: HTMLElement;
  let editor: Editor;

  beforeEach(() => {
    caja = document.createElement('div');
    caja.style.cssText = 'height:200px;width:600px;margin-left:80px;overflow-y:auto';
    document.body.appendChild(caja);
    host = document.createElement('div');
    caja.appendChild(host);

    editor = new Editor({
      element: host,
      extensions: [StarterKit, BlockDrag],
      content: Array.from({ length: 40 }, (_, i) => `<p>linea ${i}</p>`).join(''),
    });
  });

  afterEach(() => {
    editor.destroy();
    caja.remove();
    document
      .querySelectorAll('.block-drag-handle, .block-drop-indicator, .block-drag-ghost, .block-menu')
      .forEach((n) => n.remove());
  });

  const pm = (): HTMLElement => host.querySelector('.ProseMirror') as HTMLElement;
  const handle = (): HTMLElement => document.querySelector('.block-drag-handle') as HTMLElement;
  const desplazar = (a: number): void => {
    caja.scrollTop = a;
    caja.dispatchEvent(new Event('scroll', { bubbles: false }));
  };

  /**
   * A qué bloque está apuntando el handle ahora mismo.
   *
   * Se deduce de su posición en vez de rehacer aquí la búsqueda por
   * coordenadas: entre párrafos hay margen, así que un punto cualquiera puede
   * no caer dentro de ninguno y el test mediría otra cosa.
   */
  const bloqueDelHandle = (): Element | undefined => {
    const t = handle().getBoundingClientRect().top;
    return Array.from(pm().children).find(
      (n) => Math.abs(n.getBoundingClientRect().top + 1 - t) < 1.5,
    );
  };

  it('se recoloca sobre el bloque que queda debajo del ratón', () => {
    const r = caja.getBoundingClientRect();
    mover(pm(), r.left + 300, r.top + 100);
    expect(handle().style.display).toBe('flex');
    const antes = bloqueDelHandle();
    expect(antes).withContext('apunta a algún bloque').toBeTruthy();

    desplazar(240);

    // El ratón no se ha movido, pero debajo hay otro bloque: el handle es suyo.
    const ahora = bloqueDelHandle();
    expect(handle().style.display).toBe('flex');
    expect(ahora).withContext('sigue apuntando a un bloque').toBeTruthy();
    expect(ahora?.textContent).not.toBe(antes?.textContent);
  });

  it('no se esconde en el hueco entre dos bloques', () => {
    const a = pm().children[1].getBoundingClientRect();
    const b = pm().children[2].getBoundingClientRect();
    expect(b.top - a.bottom).withContext('los párrafos llevan margen').toBeGreaterThan(2);

    // Justo en la separación: ahí no hay nodo y `posAtCoords` devuelve una
    // posición del documento con `inside: -1`. Antes el handle desaparecía.
    mover(pm(), a.left + 300, (a.bottom + b.top) / 2);

    expect(handle().style.display).toBe('flex');
    expect(bloqueDelHandle()).toBeTruthy();
  });

  it('sigue al mismo bloque cuando el desplazamiento es corto', () => {
    const r = caja.getBoundingClientRect();
    /* Al centro de un bloque concreto: con un desplazamiento corto el bloque de
       debajo NO cambia, que es justo el caso que el atajo de «mismo bloque, no
       recoloco» se saltaba dejando el handle donde estaba. */
    const bloque = pm().children[2] as HTMLElement;
    const b = bloque.getBoundingClientRect();
    mover(pm(), r.left + 300, b.top + b.height / 2);
    const antes = handle().getBoundingClientRect().top;

    desplazar(8);

    expect(bloqueDelHandle()).toBe(bloque);
    expect(Math.round(handle().getBoundingClientRect().top)).toBe(Math.round(antes - 8));
  });

  it('no se queda clavado donde estaba', () => {
    const r = caja.getBoundingClientRect();
    mover(pm(), r.left + 300, r.top + 100);
    const antes = handle().getBoundingClientRect().top;

    // Un desplazamiento que no es múltiplo del alto de línea: el bloque de
    // debajo cambia de sitio, así que el handle no puede quedarse igual.
    desplazar(133);

    expect(handle().getBoundingClientRect().top).not.toBe(antes);
  });
});
