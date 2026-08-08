import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Editor, JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';

import { EditorComponent } from './editor';
import { extraerIndice } from './indice';

function nuevoEditor(html: string): Editor {
  const host = document.createElement('div');
  document.body.appendChild(host);
  return new Editor({
    element: host,
    extensions: [StarterKit.configure({ heading: { levels: [1, 2, 3, 4] } })],
    content: html,
  });
}

describe('extraerIndice (índice de la nota)', () => {
  let editor: Editor;

  afterEach(() => {
    const host = editor.view.dom.parentElement;
    editor.destroy();
    host?.remove();
  });

  it('recoge los títulos en orden, con su nivel y su texto', () => {
    editor = nuevoEditor(`
      <h1>Introducción</h1>
      <p>algo de texto</p>
      <h2>Antecedentes</h2>
      <h3>Detalle</h3>
      <h1>Conclusiones</h1>
    `);

    const indice = extraerIndice(editor.state.doc);

    expect(indice.map((t) => t.texto)).toEqual([
      'Introducción',
      'Antecedentes',
      'Detalle',
      'Conclusiones',
    ]);
    expect(indice.map((t) => t.nivel)).toEqual([1, 2, 3, 1]);
  });

  it('la posición apunta al título, que es lo que permite saltar ahí', () => {
    editor = nuevoEditor('<p>previo</p><h2>Metodología</h2>');

    const [entrada] = extraerIndice(editor.state.doc);
    const nodo = editor.state.doc.nodeAt(entrada.pos);

    expect(nodo?.type.name).toBe('heading');
    expect(nodo?.textContent).toBe('Metodología');
    // Y su elemento del DOM existe: es al que se hace scroll.
    expect(editor.view.nodeDOM(entrada.pos) instanceof HTMLElement).toBeTrue();
  });

  it('deja fuera los títulos vacíos', () => {
    // Pasa siempre que se crea uno nuevo: durante un rato no tiene texto, y
    // aparecería como una entrada en blanco en el panel.
    editor = nuevoEditor('<h1>Con texto</h1><h2></h2><h2>   </h2>');

    expect(extraerIndice(editor.state.doc).map((t) => t.texto)).toEqual(['Con texto']);
  });

  it('la sangría se cuenta desde el título más alto de la nota', () => {
    // Una nota que arranca en H2 se pinta pegada al margen, no ya sangrada.
    editor = nuevoEditor('<h2>Uno</h2><h3>Uno punto uno</h3><h2>Dos</h2>');

    expect(extraerIndice(editor.state.doc).map((t) => t.sangria)).toEqual([0, 1, 0]);
  });

  it('también entran los títulos dentro de otros bloques', () => {
    editor = nuevoEditor('<h1>Fuera</h1><blockquote><h2>Dentro de una cita</h2></blockquote>');

    expect(extraerIndice(editor.state.doc).map((t) => t.texto)).toEqual([
      'Fuera',
      'Dentro de una cita',
    ]);
  });

  it('una nota sin títulos no tiene índice', () => {
    editor = nuevoEditor('<p>solo texto</p><p>y más texto</p>');

    expect(extraerIndice(editor.state.doc)).toEqual([]);
  });
});

/** Documento con tres secciones separadas por relleno, para que haya scroll. */
function docConSecciones(): JSONContent {
  const relleno = Array.from({ length: 12 }, () => ({
    type: 'paragraph',
    content: [{ type: 'text', text: 'relleno para dar altura a la sección' }],
  }));
  const seccion = (texto: string): JSONContent[] => [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: texto }] },
    ...relleno,
  ];
  return {
    type: 'doc',
    content: [...seccion('Primera'), ...seccion('Segunda'), ...seccion('Tercera')],
  };
}

describe('Panel del índice · saltar y resaltar', () => {
  let fix: ComponentFixture<EditorComponent>;
  let comp: EditorComponent;
  let contenedor: HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [EditorComponent] }).compileComponents();
    fix = TestBed.createComponent(EditorComponent);
    comp = fix.componentInstance;
    fix.componentRef.setInput('content', docConSecciones());
    fix.detectChanges();

    /* El editor va dentro de una caja con scroll, como el `.pane-scroll` de la
       app: es lo que hace que «qué sección se está mirando» signifique algo. */
    contenedor = document.createElement('div');
    contenedor.style.cssText = 'height:200px;overflow-y:auto;position:relative';
    document.body.appendChild(contenedor);
    contenedor.appendChild(fix.nativeElement);
  });

  afterEach(() => {
    fix.destroy();
    contenedor.remove();
  });

  /** Deja pasar dos fotogramas: `alScroll` recalcula dentro de un rAF. */
  const dosFotogramas = () =>
    new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

  function desplazarA(top: number): Promise<void> {
    contenedor.scrollTop = top;
    comp.alScroll();
    return dosFotogramas();
  }

  const domDe = (i: number) => comp.editor.view.nodeDOM(comp.indice()[i].pos) as HTMLElement;

  /**
   * Distancia del título `i` al borde superior de la zona visible. Se mide con
   * rectángulos y no con `offsetTop`, que se cuenta desde el ancestro posicionado
   * más cercano y aquí no es el contenedor.
   */
  const distancia = (i: number): number =>
    domDe(i).getBoundingClientRect().top - contenedor.getBoundingClientRect().top;

  /** Deja el título `i` justo por encima del borde: se está leyendo su sección. */
  const dejarArriba = (i: number): Promise<void> =>
    desplazarA(contenedor.scrollTop + distancia(i) + 5);

  it('el índice sale del documento que se abre', () => {
    expect(comp.indice().map((t) => t.texto)).toEqual(['Primera', 'Segunda', 'Tercera']);
  });

  it('desplazarse por la nota va marcando la sección que se lee', async () => {
    expect(comp.tituloActivo()).toBe(0);

    // Con el segundo título ya pasado por arriba, se está leyendo su sección.
    await dejarArriba(1);
    expect(comp.tituloActivo()).toBe(1);

    // Y al final de la nota, la última.
    await desplazarA(contenedor.scrollHeight);
    expect(comp.tituloActivo()).toBe(2);

    // Volver arriba devuelve el resaltado a la primera.
    await desplazarA(0);
    expect(comp.tituloActivo()).toBe(0);
  });

  it('pulsar una entrada lleva la vista a esa sección', async () => {
    expect(distancia(2)).toBeGreaterThan(200); // arranca fuera de la vista

    comp.irATitulo(2);

    // El desplazamiento es suave (animado), así que hay que esperar a que llegue.
    for (let i = 0; i < 120 && distancia(2) > 60; i++) await dosFotogramas();

    // El título queda arriba del todo, que es lo que se pidió al pulsarlo.
    expect(distancia(2)).toBeGreaterThanOrEqual(0);
    expect(distancia(2)).toBeLessThan(60);
    expect(comp.tituloActivo()).toBe(2);
  });

  it('se puede saltar de una sección a otra las veces que haga falta', async () => {
    /* Regresion: el primer salto iba bien y los siguientes se quedaban a medias
       o se iban a la primera seccion. Al enfocar, el navegador arrastra la vista
       hasta el cursor por su cuenta; si eso pasa DESPUES de pedir el
       desplazamiento, se lo come. */
    for (const i of [1, 2, 1]) {
      comp.irATitulo(i);
      // Se espera a que la animación converja, venga desde arriba o desde abajo.
      for (let f = 0; f < 180 && (distancia(i) > 40 || distancia(i) < -2); f++) {
        await dosFotogramas();
      }

      expect(distancia(i))
        .withContext(`salto al titulo ${i}`)
        .toBeLessThan(40);
      expect(distancia(i))
        .withContext(`el titulo ${i} no puede quedar por encima del borde`)
        .toBeGreaterThanOrEqual(-2);
    }
  });

  it('el cursor se planta en el título al que se salta', () => {
    comp.irATitulo(1);

    // Así lo siguiente que escriba el usuario va donde acaba de mirar; y el
    // toolbar refleja el formato de esa sección.
    const { pos } = comp.indice()[1];
    expect(comp.editor.state.selection.from).toBe(pos + 1);
  });
});
