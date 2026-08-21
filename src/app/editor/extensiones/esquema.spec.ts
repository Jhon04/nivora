import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';

import { BloqueEsquema, PeticionEsquema, PeticionExportar } from './esquema';
import { EVENTO_ESQUEMA, EVENTO_EXPORTAR_ESQUEMA } from './slash-command';
import { Esquema, TAM_TEXTO, TAM_TIPO, tamanoPara } from '../esquema/modelo';
import { TABLA } from '../esquema/catalogo';

const FLUJO: Esquema = {
  nodos: [
    { id: 'a', x: 100, y: 80, ancho: 120, alto: 44, texto: 'Inicio', forma: 'terminal' },
    { id: 'b', x: 100, y: 220, ancho: 120, alto: 60, texto: '¿Hay saldo?', forma: 'decision' },
  ],
  conexiones: [{ id: 'c1', desde: 'a', hasta: 'b', texto: 'sí', tipo: 'flecha' }],
};

function montar(datos: unknown): { editor: Editor; bloque: HTMLElement } {
  const host = document.createElement('div');
  document.body.appendChild(host);

  const editor = new Editor({
    element: host,
    extensions: [StarterKit, BloqueEsquema],
    content: { type: 'doc', content: [{ type: 'esquema', attrs: { datos } }] },
  });

  const bloque = host.querySelector<HTMLElement>('.bloque-esquema');
  if (!bloque) throw new Error('el bloque de esquema no se pintó');
  return { editor, bloque };
}

const COLUMNAS = [
  { nombre: 'id', tipo: 'int', pk: true },
  { nombre: 'cliente_id', tipo: 'int', fk: true },
  { nombre: 'linea_id', tipo: 'int', pk: true, fk: true },
  { nombre: 'total', tipo: 'decimal(10,2)' },
];

const TABLA_FACTURA: Esquema = {
  nodos: [
    {
      id: 't',
      x: 200,
      y: 160,
      texto: 'factura',
      forma: 'erd-tabla',
      ...tamanoPara('factura', 'erd-tabla', COLUMNAS),
      columnas: COLUMNAS,
    },
  ],
  conexiones: [],
};

describe('bloque de esquema', () => {
  let editor: Editor | undefined;

  afterEach(() => {
    editor?.destroy();
    editor = undefined;
    document.querySelectorAll('.ProseMirror').forEach((e) => e.parentElement?.remove());
  });

  it('los estilos le llegan de verdad', () => {
    const m = montar(FLUJO);
    editor = m.editor;

    // Mismo tropiezo que con el bloque cifrado y el de Mermaid: el DOM lo crea
    // el NodeView, así que estas reglas tienen que vivir en `src/styles.scss`.
    const css = getComputedStyle(m.bloque);
    expect(css.borderTopStyle).toBe('solid');
    expect(css.borderRadius).not.toBe('0px');
  });

  /*
   * Que el nodo esté en el DOM no quiere decir que se vea. Con `light-dark()` en
   * `stroke` el borde se quedaba en `unset`, heredaba, y acababa en el valor
   * inicial de SVG —`none`—, así que el nodo salía sin borde y del color del
   * fondo: invisible, pero seleccionable. Este test mira el color resuelto.
   */
  it('las formas se pintan de verdad: borde y relleno con color resuelto', () => {
    const m = montar(FLUJO);
    editor = m.editor;

    const forma = m.bloque.querySelector<SVGElement>('.esq-forma')!;
    const css = getComputedStyle(forma);

    expect(css.stroke).not.toBe('none', 'sin borde el nodo no se distingue del fondo');
    expect(css.stroke).toMatch(/^rgb/, `el borde no resolvió a un color: ${css.stroke}`);
    expect(css.fill).toMatch(/^rgb/, `el relleno no resolvió a un color: ${css.fill}`);
    expect(parseFloat(css.strokeWidth)).toBeGreaterThan(0);

    const texto = getComputedStyle(m.bloque.querySelector<SVGElement>('.esq-texto text')!);
    expect(texto.fill).toMatch(/^rgb/, `el texto no resolvió a un color: ${texto.fill}`);

    const linea = getComputedStyle(m.bloque.querySelector<SVGElement>('.esq-linea')!);
    expect(linea.stroke).not.toBe('none', 'la flecha también tiene que verse');
  });

  /*
   * Un SVG con solo `viewBox` no tiene tamaño intrínseco, y cada motor lo
   * resuelve a su manera: Chrome deduce el ancho del alto por la proporción, el
   * WebKit de Tauri lo deja en cero — y con `overflow: hidden` el dibujo entero
   * desaparece, aunque los nodos sigan ahí y se puedan seleccionar.
   *
   * Se comprueban los ATRIBUTOS y no el tamaño calculado a propósito: el tamaño
   * calculado sale bien en Chrome de las dos formas, así que no distinguiría
   * nada. Los atributos sí, y son lo que arregla el caso en los dos motores.
   */
  it('el SVG lleva medidas explícitas, no solo viewBox', () => {
    const m = montar(FLUJO);
    editor = m.editor;

    const svg = m.bloque.querySelector('svg')!;
    expect(svg.getAttribute('width')).toBeTruthy('sin width, WebKit lo colapsa a cero');
    expect(svg.getAttribute('height')).toBeTruthy();
    expect(parseFloat(svg.getAttribute('width')!)).toBeGreaterThan(0);
    expect(parseFloat(svg.getAttribute('height')!)).toBeGreaterThan(0);
  });

  it('dibuja un grupo por nodo y otro por conexión', () => {
    const m = montar(FLUJO);
    editor = m.editor;

    expect(m.bloque.querySelectorAll('.esq-nodo').length).toBe(2);
    expect(m.bloque.querySelectorAll('.esq-conexion').length).toBe(1);
    // La etiqueta de la flecha se pinta dentro de su grupo.
    expect(m.bloque.textContent).toContain('sí');
  });

  describe('tabla', () => {
    it('pinta una fila por columna, con su nombre y su tipo', () => {
      const m = montar(TABLA_FACTURA);
      editor = m.editor;

      const filas = m.bloque.querySelectorAll('.esq-columna');
      expect(filas.length).toBe(4);
      expect([...filas].map((f) => f.textContent)).toEqual([
        'id',
        'cliente_id',
        'linea_id',
        'total',
      ]);
      expect(m.bloque.querySelector('.esq-tipo')?.textContent).toBe('int');
    });

    it('marca la primaria con llave y la foránea con rombo', () => {
      const m = montar(TABLA_FACTURA);
      editor = m.editor;

      // Dos primarias (`id` y `linea_id`) y dos foráneas (`cliente_id` y
      // `linea_id`): una columna puede ser las dos cosas.
      expect(m.bloque.querySelectorAll('.esq-llave').length).toBe(2);
      expect(m.bloque.querySelectorAll('.esq-foranea').length).toBe(2);
    });

    /* Las llaves se dibujan con `createElementNS`, así que —como el resto del
       SVG— sus estilos tienen que vivir en `styles.scss` o no llegan. Y sin
       relleno resuelto, la llave existe en el DOM pero no se ve. */
    it('las llaves se pintan de verdad', () => {
      const m = montar(TABLA_FACTURA);
      editor = m.editor;

      const llave = getComputedStyle(m.bloque.querySelector<SVGElement>('.esq-llave')!);
      expect(llave.fill).toMatch(/^rgb/, `la llave no resolvió a un color: ${llave.fill}`);

      const rombo = getComputedStyle(m.bloque.querySelector<SVGElement>('.esq-foranea')!);
      expect(rombo.stroke).toMatch(/^rgb/, `el rombo no resolvió a un color: ${rombo.stroke}`);
      expect(parseFloat(rombo.strokeWidth)).toBeGreaterThan(0);
      expect(rombo.fill).toBe('none', 'hueco: es lo que lo distingue de la llave');
    });

    /* El ancho de la caja se calcula midiendo el texto con `TAM_TEXTO` y
       `TAM_TIPO`, y el tamaño real lo pone el CSS. Si los dos se separan, el
       texto deja de caber en la tabla que se le midió. */
    it('el cuerpo de letra de las filas es el que se usó para medirlas', () => {
      const m = montar(TABLA_FACTURA);
      editor = m.editor;

      const nombre = getComputedStyle(m.bloque.querySelector('.esq-columna text')!);
      expect(parseFloat(nombre.fontSize)).toBe(TAM_TEXTO);

      const tipo = getComputedStyle(m.bloque.querySelector('.esq-tipo text')!);
      expect(parseFloat(tipo.fontSize)).toBe(TAM_TIPO);
    });

    it('las filas caben dentro de la caja de la tabla', () => {
      const m = montar(TABLA_FACTURA);
      editor = m.editor;

      const n = TABLA_FACTURA.nodos[0];
      const arriba = n.y - n.alto / 2;
      const abajo = n.y + n.alto / 2;

      for (const t of m.bloque.querySelectorAll<SVGTextElement>('.esq-columna text')) {
        const y = parseFloat(t.getAttribute('y')!);
        expect(y).toBeGreaterThan(arriba + TABLA.cabecera, `«${t.textContent}» pisa la cabecera`);
        expect(y).toBeLessThan(abajo, `«${t.textContent}» se sale por abajo`);
      }
    });

    /* El chequeo de «dentro de la caja» no basta: el nombre va anclado a la
       izquierda y el tipo a la derecha, así que si la tabla sale estrecha los dos
       siguen dentro del rectángulo y lo que hacen es pisarse el uno al otro.
       Esto es lo que fija que `TABLA.hueco` y el margen de las llaves se estén
       contando de verdad al medir el ancho. */
    it('el nombre de la columna y su tipo no se pisan', () => {
      const largas = [
        { nombre: 'descripcion_larga_del_producto', tipo: 'varchar(255)' },
        { nombre: 'id', tipo: 'int', pk: true, fk: true },
      ];
      const m = montar({
        nodos: [
          {
            id: 't', x: 300, y: 200, texto: 'factura', forma: 'erd-tabla',
            ...tamanoPara('factura', 'erd-tabla', largas),
            columnas: largas,
          },
        ],
        conexiones: [],
      });
      editor = m.editor;

      const nombres = m.bloque.querySelectorAll<SVGGElement>('.esq-columna');
      const tipos = m.bloque.querySelectorAll<SVGGElement>('.esq-tipo');
      expect(nombres.length).toBe(2);

      for (let i = 0; i < nombres.length; i++) {
        const n = nombres[i].getBBox();
        const t = tipos[i].getBBox();
        const hueco = t.x - (n.x + n.width);
        expect(hueco).toBeGreaterThanOrEqual(0, `«${nombres[i].textContent}» pisa a su tipo`);
      }
    });

    it('una forma que no lista columnas no las pinta aunque las lleve', () => {
      const m = montar({
        nodos: [{ ...TABLA_FACTURA.nodos[0], forma: 'erd-entidad' }],
        conexiones: [],
      });
      editor = m.editor;

      // Se conservan en el documento —cambiar de forma no borra el trabajo— pero
      // no salen dibujadas.
      expect(m.bloque.querySelectorAll('.esq-columna').length).toBe(0);
    });
  });

  it('el esquema vacío avisa en vez de dejar un recuadro en blanco', () => {
    const m = montar({ nodos: [], conexiones: [] });
    editor = m.editor;

    expect(m.bloque.querySelector('svg')).toBeNull();
    expect(m.bloque.querySelector('.esquema-vacio')?.textContent).toContain('vacío');
  });

  /*
   * Los ficheros de las notas se escriben con `to_string_pretty`. Como objeto, el
   * esquema sale indentado y mover un nodo da un diff de una línea; metido en una
   * cadena JSON sería un renglón entero ilegible en cada arrastre.
   */
  it('guarda el grafo como objeto, no como cadena', () => {
    const m = montar(FLUJO);
    editor = m.editor;

    const nodo = (m.editor.getJSON().content ?? []).find((n) => n.type === 'esquema');
    expect(typeof nodo?.attrs?.['datos']).toBe('object');
    expect(nodo?.attrs?.['datos'].nodos.length).toBe(2);
  });

  it('aguanta un grafo con basura dentro', () => {
    const m = montar({ nodos: [{ sin: 'id' }, null], conexiones: 'ninguna' });
    editor = m.editor;

    expect(m.bloque.querySelector('.esquema-vacio')).not.toBeNull();
  });

  describe('exportar', () => {
    const menu = (b: HTMLElement) => b.querySelector<HTMLElement>('.esquema-formatos')!;
    const boton = (b: HTMLElement) => b.querySelector<HTMLButtonElement>('.esquema-exportar')!;

    it('el menú sale cerrado y se abre con el botón', () => {
      const m = montar(FLUJO);
      editor = m.editor;

      expect(menu(m.bloque).hidden).toBe(true);
      boton(m.bloque).click();
      expect(menu(m.bloque).hidden).toBe(false);
      expect(menu(m.bloque).textContent).toContain('SVG');
      expect(menu(m.bloque).textContent).toContain('PNG');
    });

    it('elegir un formato lo pide y cierra el menú', () => {
      const m = montar(FLUJO);
      editor = m.editor;

      const pedidos: PeticionExportar[] = [];
      m.editor.view.dom.addEventListener(EVENTO_EXPORTAR_ESQUEMA, (e) =>
        pedidos.push((e as CustomEvent<PeticionExportar>).detail),
      );

      boton(m.bloque).click();
      menu(m.bloque).querySelectorAll('button')[1].click();

      expect(pedidos.length).toBe(1);
      expect(pedidos[0].formato).toBe('png');
      expect(pedidos[0].datos).toEqual(FLUJO);
      expect(menu(m.bloque).hidden).toBe(true);
    });

    it('Escape y un clic fuera lo cierran', () => {
      const m = montar(FLUJO);
      editor = m.editor;

      boton(m.bloque).click();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(menu(m.bloque).hidden).toBe(true);

      boton(m.bloque).click();
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      expect(menu(m.bloque).hidden).toBe(true);
    });

    /* Un fichero en blanco no le sirve a nadie, y el botón sugeriría que sí. */
    it('un esquema vacío no ofrece exportar', () => {
      const m = montar({ nodos: [], conexiones: [] });
      editor = m.editor;

      expect(boton(m.bloque).hidden).toBe(true);
    });

    /* Sin esto, ProseMirror se queda los eventos del menú y elegir un formato
       movería además el cursor del documento. */
    it('el menú no le roba el sitio al cursor', () => {
      const m = montar(FLUJO);
      editor = m.editor;

      boton(m.bloque).click();
      const opcion = menu(m.bloque).querySelector('button')!;
      const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
      opcion.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
    });

    it('el icono confirma en su sitio cuando el fichero se escribe', (hecho) => {
      const m = montar(FLUJO);
      editor = m.editor;

      m.editor.view.dom.addEventListener(EVENTO_EXPORTAR_ESQUEMA, (e) =>
        (e as CustomEvent<PeticionExportar>).detail.hecho?.(true),
      );

      boton(m.bloque).click();
      menu(m.bloque).querySelector('button')!.click();

      expect(boton(m.bloque).textContent).toBe('check');
      hecho();
    });
  });

  it('el doble clic pide abrir el editor, con la posición del bloque', () => {
    const m = montar(FLUJO);
    editor = m.editor;

    let peticion: PeticionEsquema | undefined;
    m.editor.view.dom.addEventListener(EVENTO_ESQUEMA, (e) => {
      peticion = (e as CustomEvent<PeticionEsquema>).detail;
    });

    m.bloque.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

    // Sin la posición, `editor.ts` no sabría qué nodo reemplazar al guardar.
    expect(peticion?.pos).toBe(0);
    expect(peticion?.datos).toEqual(FLUJO);
  });
});
