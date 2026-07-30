import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { TestBed } from '@angular/core/testing';

import { BlockDrag } from './block-drag';
import { EditorComponent } from './editor';
import { SLASH_ITEMS } from './slash-command';

/** Cuenta de filas y de columnas de la primera tabla del documento. */
function forma(pm: HTMLElement): { filas: number; cols: number } {
  const tabla = pm.querySelector('table');
  const filas = tabla?.querySelectorAll('tr') ?? [];
  return { filas: filas.length, cols: filas[0]?.children.length ?? 0 };
}

describe('tabla', () => {
  let host: HTMLElement;
  let editor: Editor;

  beforeEach(() => {
    host = document.createElement('div');
    host.style.cssText = 'width:600px;margin-left:80px';
    document.body.appendChild(host);
    editor = new Editor({
      element: host,
      extensions: [
        StarterKit,
        Table.configure({ resizable: true }),
        TableRow,
        TableHeader,
        TableCell,
        BlockDrag,
      ],
      content: '<p>antes</p>',
    });
  });

  afterEach(() => {
    editor.destroy();
    host.remove();
    document
      .querySelectorAll('.block-drag-handle, .block-drop-indicator, .block-drag-ghost')
      .forEach((n) => n.remove());
  });

  const pm = (): HTMLElement => host.querySelector('.ProseMirror') as HTMLElement;
  const insertar = (): void => {
    editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
  };

  it('la entrada del menú «/» inserta una tabla 3×3 con cabecera', () => {
    const item = SLASH_ITEMS.find((i) => i.title === 'Tabla');
    expect(item).withContext('la entrada existe').toBeTruthy();

    editor.commands.focus();
    const { from } = editor.state.selection;
    item!.command({ editor, range: { from, to: from } });

    expect(forma(pm())).toEqual({ filas: 3, cols: 3 });
    expect(pm().querySelectorAll('th').length).toBe(3);
    /* Con `resizable`, el nodo lo pinta `TableView`: envuelve la tabla en un
       `div.tableWrapper` propio e ignora `HTMLAttributes`, así que los estilos
       cuelgan de esa clase y no de una nuestra. */
    expect(pm().querySelector('.tableWrapper > table')).withContext('lo que emite TableView').toBeTruthy();
  });

  it('añade y quita filas y columnas', () => {
    insertar();
    expect(forma(pm())).toEqual({ filas: 3, cols: 3 });

    editor.chain().focus().addRowAfter().run();
    expect(forma(pm()).filas).toBe(4);

    editor.chain().focus().addColumnAfter().run();
    expect(forma(pm()).cols).toBe(4);

    editor.chain().focus().deleteRow().run();
    editor.chain().focus().deleteColumn().run();
    expect(forma(pm())).toEqual({ filas: 3, cols: 3 });
  });

  it('la cabecera se puede quitar y volver a poner', () => {
    insertar();
    expect(pm().querySelectorAll('th').length).toBe(3);

    editor.chain().focus().toggleHeaderRow().run();
    expect(pm().querySelectorAll('th').length).toBe(0);

    editor.chain().focus().toggleHeaderRow().run();
    expect(pm().querySelectorAll('th').length).toBe(3);
  });

  it('eliminar la tabla no se lleva el resto de la nota', () => {
    insertar();
    editor.chain().focus().deleteTable().run();

    expect(pm().querySelector('table')).toBeNull();
    expect(pm().textContent).toContain('antes');
  });

  it('el texto de las celdas viaja en el JSON, que es lo que se guarda e indexa', () => {
    insertar();
    editor.commands.insertContent('importe');

    // `db::extraer_texto` recoge las claves `text` del JSON para el índice FTS;
    // si el contenido de la tabla no estuviera ahí, no se podría buscar.
    expect(JSON.stringify(editor.getJSON())).toContain('importe');
  });

  it('el ancho de columna se guarda al redimensionar', () => {
    insertar();
    // Lo que escribe el plugin de `resizable`; sin `colwidth` el ajuste no
    // sobreviviría a guardar y volver a abrir la nota.
    editor
      .chain()
      .focus()
      .setCellAttribute('colwidth', [120])
      .run();

    expect(JSON.stringify(editor.getJSON())).toContain('colwidth');
  });

  it('el handle de arrastre reconoce la tabla como un bloque', () => {
    insertar();
    const tabla = pm().querySelector('table') as HTMLElement;
    const r = tabla.getBoundingClientRect();
    // Sobre una celda: la posición se resuelve dentro de la tabla y hay que
    // subir hasta el bloque de primer nivel, que es la tabla entera.
    document.dispatchEvent(
      new MouseEvent('mousemove', {
        clientX: r.left + 40,
        clientY: r.top + 10,
        bubbles: true,
      }),
    );

    const handle = document.querySelector('.block-drag-handle') as HTMLElement;
    expect(handle.style.display).toBe('flex');
    expect(Math.round(handle.getBoundingClientRect().top)).toBe(Math.round(r.top + 1));
  });
});

/**
 * La cabecera se alterna en LA FILA DEL CURSOR.
 *
 * Va contra el componente de verdad y no contra una copia de su lógica: lo que
 * se prueba es el botón «Cabecera» de la barra, no la técnica.
 *
 * `toggleHeaderRow` de prosemirror-tables actúa **siempre sobre la primera
 * fila** de la tabla, esté el cursor donde esté: con el cursor en la segunda se
 * pulsaba «Cabecera» y la que cambiaba era la de arriba.
 */
describe('tabla · cabecera por fila', () => {
  let fix: ReturnType<typeof TestBed.createComponent<EditorComponent>>;
  let comp: EditorComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [EditorComponent] }).compileComponents();
    fix = TestBed.createComponent(EditorComponent);
    fix.detectChanges();
    comp = fix.componentInstance;
    comp.insertarTabla();
  });

  afterEach(() => fix.destroy());

  const pm = (): HTMLElement => fix.nativeElement.querySelector('.ProseMirror') as HTMLElement;
  /** Tipo de celda de cada fila: `['THTHTH', 'TDTDTD', …]`. */
  const forma = (): string[] =>
    Array.from(pm().querySelectorAll('tr')).map((tr) =>
      Array.from(tr.children)
        .map((c) => c.tagName)
        .join(''),
    );
  const irAFila = (n: number): void => {
    const celda = pm().querySelectorAll('tr')[n].children[0] as HTMLElement;
    comp.editor.commands.setTextSelection(comp.editor.view.posAtDOM(celda, 0) + 1);
  };

  it('quita la cabecera de la fila del cursor, no de la primera', () => {
    irAFila(0);
    comp.filaEncima();
    // Insertar encima deja una fila de cuerpo por delante de la cabecera.
    expect(forma()).toEqual(['TDTDTD', 'THTHTH', 'TDTDTD', 'TDTDTD']);

    irAFila(0);
    comp.alternarCabecera();
    expect(forma()[0]).toBe('THTHTH');

    // Aquí estaba el fallo: se pulsaba con el cursor en la fila 1 y la que
    // perdía la cabecera era la 0.
    irAFila(1);
    comp.alternarCabecera();
    expect(forma()).toEqual(['THTHTH', 'TDTDTD', 'TDTDTD', 'TDTDTD']);
  });

  it('convierte la fila entera, no solo la celda del cursor', () => {
    irAFila(2);
    comp.alternarCabecera();

    expect(forma()[2]).toBe('THTHTH');
  });

  it('el cursor se queda donde estaba', () => {
    irAFila(2);
    const antes = comp.editor.state.selection.from;
    comp.alternarCabecera();

    // Seleccionar la fila entera es un medio para el comando, no algo que el
    // usuario haya pedido: al terminar tiene que poder seguir escribiendo.
    expect(comp.editor.state.selection.from).toBe(antes);
    expect(comp.editor.state.selection.empty).toBeTrue();
  });

  it('fuera de una tabla no hace nada', () => {
    comp.editor.commands.setContent('<p>suelto</p>');
    comp.editor.commands.focus();

    expect(() => comp.alternarCabecera()).not.toThrow();
    expect(pm().querySelector('table')).toBeNull();
  });
});

/** La barra agrupa las seis acciones de fila y columna en dos desplegables. */
describe('tabla · barra agrupada', () => {
  let fix: ReturnType<typeof TestBed.createComponent<EditorComponent>>;
  let comp: EditorComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [EditorComponent] }).compileComponents();
    fix = TestBed.createComponent(EditorComponent);
    fix.detectChanges();
    comp = fix.componentInstance;
    comp.insertarTabla();
    fix.detectChanges();
  });

  afterEach(() => {
    fix.destroy();
    document.querySelectorAll('.cdk-overlay-container').forEach((n) => (n.innerHTML = ''));
  });

  const pm = (): HTMLElement => fix.nativeElement.querySelector('.ProseMirror') as HTMLElement;
  const barra = (): HTMLElement => fix.nativeElement.querySelector('.bubble-tabla') as HTMLElement;
  const disparador = (nombre: string): HTMLButtonElement =>
    Array.from(barra().querySelectorAll<HTMLButtonElement>('button.grupo')).find((b) =>
      b.textContent?.includes(nombre),
    )!;
  /** Entradas del desplegable abierto, que vive en el contenedor del CDK. */
  const entradas = (): HTMLButtonElement[] =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('.cdk-overlay-container .menu-item'));
  /* El icono es una ligadura de Material Icons, así que su nombre sale dentro
     del `textContent`: hay que separarlo del rótulo. */
  const contenido = (): { icono: string; texto: string }[] =>
    entradas().map((b) => ({
      icono: b.querySelector('.menu-ico')?.textContent?.trim() ?? '',
      texto: b.lastChild?.textContent?.trim() ?? '',
    }));
  const filas = (): number => pm().querySelectorAll('tr').length;
  const columnas = (): number => pm().querySelector('tr')?.children.length ?? 0;

  const abrir = (nombre: string): void => {
    disparador(nombre).click();
    fix.detectChanges();
  };
  const pulsar = (texto: string): void => {
    entradas().find((b) => b.textContent?.includes(texto))!.click();
    fix.detectChanges();
  };

  it('la barra solo tiene dos desplegables, no seis botones sueltos', () => {
    expect(barra().querySelectorAll('button.grupo').length).toBe(2);
    expect(disparador('Fila').querySelector('.material-icons')?.textContent).toBe('table_rows');
    expect(disparador('Columna').querySelector('.material-icons')?.textContent).toBe('view_column');
  });

  it('el desplegable de fila trae insertar encima, debajo y borrar', () => {
    abrir('Fila');
    expect(contenido()).toEqual([
      { icono: 'arrow_upward', texto: 'Insertar encima de' },
      { icono: 'arrow_downward', texto: 'Insertar debajo de' },
      { icono: 'delete', texto: 'Borrar' },
    ]);
  });

  it('el desplegable de columna trae izquierda, derecha y borrar', () => {
    abrir('Columna');
    expect(contenido()).toEqual([
      { icono: 'arrow_back', texto: 'Insertar a la izquierda' },
      { icono: 'arrow_forward', texto: 'Insertar a la derecha' },
      { icono: 'delete', texto: 'Borrar' },
    ]);
  });

  it('sus entradas actúan sobre la tabla y cierran el menú', () => {
    abrir('Fila');
    pulsar('Insertar debajo');
    expect(filas()).toBe(4);
    expect(entradas().length).withContext('el menú se cierra al elegir').toBe(0);

    abrir('Columna');
    pulsar('Insertar a la derecha');
    expect(columnas()).toBe(4);

    abrir('Fila');
    pulsar('Borrar');
    expect(filas()).toBe(3);
  });
});
