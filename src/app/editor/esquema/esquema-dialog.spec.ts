import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';

import { Esquema } from './modelo';
import { EsquemaDialog } from './esquema-dialog';

/**
 * Pruebas de caja negra: se pulsan los botones y se mueve el ratón como haría
 * una persona, y lo que se mira es el SVG que sale. Nada de tocar el estado por
 * dentro — así lo que queda probado es la interacción de verdad, incluida la
 * conversión de coordenadas de pantalla a coordenadas del esquema.
 */
describe('editor de esquemas', () => {
  let fixture: ComponentFixture<EsquemaDialog>;
  let raiz: HTMLElement;
  let cerradoCon: Esquema | null | undefined;

  beforeEach(async () => {
    cerradoCon = undefined;

    await TestBed.configureTestingModule({
      imports: [EsquemaDialog],
      providers: [
        { provide: MAT_DIALOG_DATA, useValue: { esquema: null } },
        { provide: MatDialogRef, useValue: { close: (v: Esquema | null) => (cerradoCon = v) } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(EsquemaDialog);
    raiz = fixture.nativeElement as HTMLElement;
    // El diálogo real ocupa la pantalla; sin tamaño el SVG no tendría matriz de
    // pantalla y no se podría convertir un clic a coordenadas del esquema.
    raiz.style.display = 'block';
    raiz.style.width = '900px';
    raiz.style.height = '620px';
    document.body.appendChild(raiz);
    fixture.detectChanges();
  });

  afterEach(() => raiz.remove());

  const boton = (titulo: string) => raiz.querySelector<HTMLButtonElement>(`button[title="${titulo}"]`)!;
  const nodos = () => Array.from(raiz.querySelectorAll<SVGGElement>('.esq-nodo'));
  // Sin la tentativa: esa es la flecha que sigue al ratón mientras se traza, y
  // todavía no forma parte del esquema.
  const conexiones = () => raiz.querySelectorAll('.esq-conexion:not(.tentativa)').length;
  const marco = () => raiz.querySelector<HTMLElement>('.marco')!;

  /** Centro de un nodo, en coordenadas de pantalla. */
  function centroDe(g: SVGGElement): { x: number; y: number } {
    const c = g.getBoundingClientRect();
    return { x: c.left + c.width / 2, y: c.top + c.height / 2 };
  }

  function puntero(tipo: string, p: { x: number; y: number }): void {
    marco().dispatchEvent(
      new PointerEvent(tipo, { clientX: p.x, clientY: p.y, bubbles: true, pointerId: 1 }),
    );
    fixture.detectChanges();
  }

  /** Abre el panel de formas y pulsa una por su nombre. */
  function anadirForma(nombre: string): SVGGElement {
    boton('Formas').click();
    fixture.detectChanges();
    raiz.querySelector<HTMLButtonElement>(`.panel-formas button[title="${nombre}"]`)!.click();
    fixture.detectChanges();
    return nodos()[nodos().length - 1];
  }

  const anadirPaso = () => anadirForma('Paso');

  it('empieza vacío y añade nodos con la barra', () => {
    expect(nodos().length).toBe(0);

    anadirPaso();
    expect(nodos().length).toBe(1);

    // En cascada, no apilados: si salieran en el mismo punto habría que
    // separarlos a mano antes de poder trabajar.
    const segundo = anadirPaso();
    expect(nodos().length).toBe(2);
    expect(centroDe(nodos()[0]).x).not.toBe(centroDe(segundo).x);
  });

  it('arrastrar mueve el nodo', () => {
    const nodo = anadirPaso();
    const antes = centroDe(nodo);

    puntero('pointerdown', antes);
    puntero('pointermove', { x: antes.x + 90, y: antes.y + 40 });
    puntero('pointerup', { x: antes.x + 90, y: antes.y + 40 });

    const despues = centroDe(nodos()[0]);
    expect(despues.x).toBeGreaterThan(antes.x + 40);
    expect(despues.y).toBeGreaterThan(antes.y + 15);
  });

  it('la herramienta de conectar une dos nodos', () => {
    anadirPaso();
    anadirPaso();
    expect(conexiones()).toBe(0);

    boton('Conectar dos nodos').click();
    fixture.detectChanges();

    puntero('pointerdown', centroDe(nodos()[0]));
    puntero('pointerdown', centroDe(nodos()[1]));

    expect(conexiones()).toBe(1);
  });

  it('no deja conectar un nodo consigo mismo', () => {
    const nodo = anadirPaso();

    boton('Conectar dos nodos').click();
    fixture.detectChanges();
    puntero('pointerdown', centroDe(nodo));
    puntero('pointerdown', centroDe(nodo));

    expect(conexiones()).toBe(0);
  });

  it('borrar un nodo se lleva sus conexiones', () => {
    anadirPaso();
    anadirPaso();
    boton('Conectar dos nodos').click();
    fixture.detectChanges();
    puntero('pointerdown', centroDe(nodos()[0]));
    puntero('pointerdown', centroDe(nodos()[1]));
    expect(conexiones()).toBe(1);

    // Se vuelve a la herramienta de selección: en modo conectar, pulsar un nodo
    // empieza otra flecha en vez de seleccionarlo.
    boton('Seleccionar y editar').click();
    fixture.detectChanges();
    puntero('pointerdown', centroDe(nodos()[0]));
    boton('Borrar lo seleccionado (Supr)').click();
    fixture.detectChanges();

    expect(nodos().length).toBe(1);
    expect(conexiones()).toBe(0);
  });

  it('el campo de texto renombra lo seleccionado y el nodo crece con él', () => {
    const nodo = anadirPaso();
    const anchoAntes = nodo.getBoundingClientRect().width;

    puntero('pointerdown', centroDe(nodo));
    const campo = raiz.querySelector<HTMLInputElement>('.etiqueta')!;
    campo.value = 'Comprobar el saldo de la cuenta';
    campo.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(raiz.textContent).toContain('Comprobar el saldo');
    expect(nodos()[0].getBoundingClientRect().width).toBeGreaterThan(anchoAntes);
  });

  describe('puntos de enganche', () => {
    const puntos = () => raiz.querySelectorAll('.esq-punto').length;
    const activo = () => raiz.querySelector('.esq-punto.activo');
    const fantasma = () => raiz.querySelector('.esq-fantasma');

    /** Centro en pantalla del punto de enganche de un lado del nodo. */
    function puntoDe(g: SVGGElement, dir: string): { x: number; y: number } {
      const c = centroDe(g);
      const b = g.getBoundingClientRect();
      // Un poco por fuera del borde, que es donde `puntoDe` los coloca.
      const fuera = 12;
      if (dir === 'derecha') return { x: b.right + fuera, y: c.y };
      if (dir === 'izquierda') return { x: b.left - fuera, y: c.y };
      if (dir === 'arriba') return { x: c.x, y: b.top - fuera };
      return { x: c.x, y: b.bottom + fuera };
    }

    it('los cuatro puntos salen al pasar por encima del nodo', () => {
      anadirPaso();
      // Recién añadido queda seleccionado, así que ya los enseña.
      expect(puntos()).toBe(4);

      // Ojo: cada render reemplaza el SVG entero, así que el elemento hay que
      // volver a pedirlo. Guardada, la referencia queda huérfana y su caja mide
      // cero, con lo que el ratón acabaría en el origen y no sobre el nodo.
      const centro = centroDe(nodos()[0]);

      // Pinchar en el vacío quita la selección: sin ratón encima ni nada
      // seleccionado, no hay puntos que estorben. Hay que soltar, porque un
      // pulsar sin soltar deja un barrido en curso y durante el barrido los
      // puntos no salen a propósito.
      puntero('pointerdown', { x: 5, y: 5 });
      puntero('pointerup', { x: 5, y: 5 });
      expect(puntos()).toBe(0);

      puntero('pointermove', centro);
      expect(puntos()).toBe(4, 'vuelven al pasar por encima');
    });

    it('acercarse a un punto lo despierta y enseña el fantasma', () => {
      const nodo = anadirPaso();
      expect(activo()).toBeNull();
      expect(fantasma()).toBeNull();

      puntero('pointermove', puntoDe(nodo, 'derecha'));

      expect(activo()).not.toBeNull('el punto crece y le sale la flecha');
      expect(fantasma()).not.toBeNull('se anuncia lo que va a aparecer');
      // El fantasma trae su flecha y su bloque, no solo uno de los dos.
      expect(fantasma()!.querySelector('.esq-forma')).not.toBeNull();
      expect(fantasma()!.querySelector('.esq-linea')).not.toBeNull();
    });

    it('dentro del nodo no se despierta ningún punto', () => {
      const nodo = anadirPaso();

      puntero('pointermove', centroDe(nodo));

      // Ahí lo que se espera al pulsar es arrastrar, no que brote un vecino.
      expect(activo()).toBeNull();
      expect(fantasma()).toBeNull();
    });

    it('pulsar el punto crea el nodo, ya enlazado y en esa dirección', () => {
      const nodo = anadirPaso();
      const antes = centroDe(nodo);

      const p = puntoDe(nodo, 'derecha');
      puntero('pointermove', p);
      puntero('pointerdown', p);

      expect(nodos().length).toBe(2);
      expect(conexiones()).toBe(1, 'nace enlazado desde el de origen');
      // A la derecha del que lo creó, sin solaparse.
      const nuevo = nodos().find((g) => centroDe(g).x > antes.x + 20);
      expect(nuevo).toBeDefined('el nodo nuevo está a la derecha');
      expect(fantasma()).toBeNull('el fantasma se hizo real');
    });

    /*
     * El caso que pidió el usuario: si donde iba a nacer ya hay algo, se enlaza
     * con ello en vez de duplicarlo. Los nodos se colocan en cascada, así que el
     * segundo cae abajo y a la derecha del primero, dentro del alcance.
     */
    it('si ya hay un nodo en esa dirección, solo lo enlaza', () => {
      anadirPaso();
      const arriba = centroDe(nodos()[0]);
      anadirPaso();

      /* Se separa el segundo hasta dejarlo claramente debajo del primero. Los
         nodos nacen en cascada y se solapan, y con el punto de abajo cayendo
         DENTRO del otro no se despertaría ninguno — que es lo correcto: ahí lo
         que se espera al pulsar es arrastrar. */
      const suelto = centroDe(nodos()[1]);
      /* 100 px de pantalla ≈ 122 unidades del esquema con la escala del
         fixture, que quitando las dos medias alturas deja unas 78 de hueco:
         dentro de ALCANCE_ENLACE (100) y sin llegar a solaparse. */
      const destino = { x: arriba.x, y: arriba.y + 100 };
      puntero('pointerdown', suelto);
      puntero('pointermove', destino);
      puntero('pointerup', destino);
      expect(nodos().length).toBe(2);

      // Primero el ratón sobre el nodo de origen, que es lo que hace salir sus
      // puntos: tras el arrastre el seleccionado es el otro.
      puntero('pointermove', centroDe(nodos()[0]));

      // El fantasma tiene que anunciarlo: cerco al destino y ninguna silueta
      // nueva flotando.
      const p = puntoDe(nodos()[0], 'abajo');
      puntero('pointermove', p);
      expect(raiz.querySelector('.esq-destino')).not.toBeNull('marca cuál va a enlazar');
      expect(raiz.querySelector('.esq-fantasma .esq-forma')).toBeNull('no promete uno nuevo');

      puntero('pointerdown', p);

      expect(nodos().length).toBe(2, 'no se ha creado ninguno');
      expect(conexiones()).toBe(1);
    });

    it('si no hay nada cerca, sí crea el nodo', () => {
      const nodo = anadirPaso();

      // Hacia arriba está despejado: el nodo está en el centro del lienzo.
      const p = puntoDe(nodo, 'arriba');
      puntero('pointermove', p);
      expect(raiz.querySelector('.esq-destino')).toBeNull();
      expect(raiz.querySelector('.esq-fantasma .esq-forma')).not.toBeNull('promete uno nuevo');

      puntero('pointerdown', p);

      expect(nodos().length).toBe(2);
      expect(conexiones()).toBe(1);
    });

    it('el nodo brotado hereda la forma del que lo creó', () => {
      const rombo = anadirForma('Decisión');

      const p = puntoDe(rombo, 'abajo');
      puntero('pointermove', p);
      puntero('pointerdown', p);

      expect(nodos().length).toBe(2);
      // Se comprueba en lo que se guardaría: las siluetas son `path` y sus `d`
      // no coinciden por estar en sitios distintos, así que compararlas no
      // diría nada.
      boton('Guardar').click();
      expect(cerradoCon!.nodos.map((n) => n.forma)).toEqual(['decision', 'decision']);
    });
  });

  describe('selección múltiple', () => {
    const seleccionados = () => raiz.querySelectorAll('.esq-nodo.sel').length;
    const marquesina = () => raiz.querySelector('.esq-marquesina');

    /** Añade dos nodos separados y devuelve sus centros en pantalla. */
    function dosSeparados(): { a: { x: number; y: number }; b: { x: number; y: number } } {
      anadirPaso();
      anadirPaso();
      // Se piden frescos: cada render reemplaza el SVG entero.
      return { a: centroDe(nodos()[0]), b: centroDe(nodos()[1]) };
    }

    it('barrer el lienzo vacío selecciona lo que toca', () => {
      const { a, b } = dosSeparados();
      puntero('pointerdown', { x: 5, y: 5 });
      expect(seleccionados()).toBe(0);

      puntero('pointerdown', { x: 5, y: 5 });
      puntero('pointermove', { x: 400, y: 400 });
      expect(marquesina()).not.toBeNull('se ve el rectángulo mientras se barre');

      const lejos = { x: Math.max(a.x, b.x) + 120, y: Math.max(a.y, b.y) + 120 };
      puntero('pointermove', lejos);
      puntero('pointerup', lejos);

      expect(marquesina()).toBeNull('el rectángulo desaparece al soltar');
      expect(seleccionados()).toBe(2);
    });

    it('con varios elegidos, arrastrar uno los mueve todos', () => {
      const { a, b } = dosSeparados();
      const lejos = { x: Math.max(a.x, b.x) + 120, y: Math.max(a.y, b.y) + 120 };
      puntero('pointerdown', { x: 5, y: 5 });
      puntero('pointermove', lejos);
      puntero('pointerup', lejos);
      expect(seleccionados()).toBe(2);

      // Se arrastra uno de los dos: el otro tiene que acompañarlo.
      puntero('pointerdown', a);
      puntero('pointermove', { x: a.x + 100, y: a.y });
      puntero('pointerup', { x: a.x + 100, y: a.y });

      boton('Guardar').click();
      expect(cerradoCon!.nodos[0].x).toBeGreaterThan(390);
      expect(cerradoCon!.nodos[1].x).toBeGreaterThan(416);
      // Y el mismo desplazamiento para los dos: se movieron juntos, no cada uno.
      const d0 = cerradoCon!.nodos[0].x - 390;
      const d1 = cerradoCon!.nodos[1].x - 416;
      expect(Math.abs(d0 - d1)).toBeLessThan(1);
    });

    it('pulsar un nodo que ya está en la selección no la deshace', () => {
      const { a, b } = dosSeparados();
      const lejos = { x: Math.max(a.x, b.x) + 120, y: Math.max(a.y, b.y) + 120 };
      puntero('pointerdown', { x: 5, y: 5 });
      puntero('pointermove', lejos);
      puntero('pointerup', lejos);

      // Así es como se arrastra un grupo: si el clic la deshiciera, no habría
      // forma de mover más de uno.
      puntero('pointerdown', a);
      expect(seleccionados()).toBe(2);
    });

    it('Ctrl+clic suma y quita de la selección', () => {
      const { a, b } = dosSeparados();
      puntero('pointerdown', a);
      expect(seleccionados()).toBe(1);

      marco().dispatchEvent(
        new PointerEvent('pointerdown', { clientX: b.x, clientY: b.y, ctrlKey: true, bubbles: true, pointerId: 1 }),
      );
      fixture.detectChanges();
      expect(seleccionados()).toBe(2, 'suma el segundo');

      marco().dispatchEvent(
        new PointerEvent('pointerdown', { clientX: b.x, clientY: b.y, ctrlKey: true, bubbles: true, pointerId: 1 }),
      );
      fixture.detectChanges();
      expect(seleccionados()).toBe(1, 'y vuelve a quitarlo');
    });

    it('borrar se lleva todo lo seleccionado de una vez', () => {
      const { a, b } = dosSeparados();
      const lejos = { x: Math.max(a.x, b.x) + 120, y: Math.max(a.y, b.y) + 120 };
      puntero('pointerdown', { x: 5, y: 5 });
      puntero('pointermove', lejos);
      puntero('pointerup', lejos);

      boton('Borrar lo seleccionado (Supr)').click();
      fixture.detectChanges();

      expect(nodos().length).toBe(0);
    });

    it('con varios elegidos el pie dice cuántos y no ofrece renombrar', () => {
      const { a, b } = dosSeparados();
      const lejos = { x: Math.max(a.x, b.x) + 120, y: Math.max(a.y, b.y) + 120 };
      puntero('pointerdown', { x: 5, y: 5 });
      puntero('pointermove', lejos);
      puntero('pointerup', lejos);

      // Con tres seleccionados no hay «el» texto que cambiar.
      expect(raiz.querySelector('.etiqueta')).toBeNull();
      expect(raiz.querySelector('.propiedades .pista')!.textContent).toContain('2 seleccionados');
    });

    it('con varios elegidos no salen los puntos de enganche', () => {
      const { a, b } = dosSeparados();
      const lejos = { x: Math.max(a.x, b.x) + 120, y: Math.max(a.y, b.y) + 120 };
      puntero('pointerdown', { x: 5, y: 5 });
      puntero('pointermove', lejos);
      puntero('pointerup', lejos);

      // Salen al pasar por encima de uno, pero no por estar seleccionados los
      // dos: no habría forma de saber de cuál brotaría el nuevo.
      puntero('pointerleave', { x: 0, y: 0 });
      expect(raiz.querySelectorAll('.esq-punto').length).toBe(0);
    });
  });

  describe('ruta en codos', () => {
    it('la conexión se dibuja como path, no como línea recta', () => {
      anadirPaso();
      anadirPaso();
      boton('Conectar dos nodos').click();
      fixture.detectChanges();
      puntero('pointerdown', centroDe(nodos()[0]));
      puntero('pointerdown', centroDe(nodos()[1]));

      const linea = raiz.querySelector('.esq-conexion .esq-linea')!;
      expect(linea.tagName.toLowerCase()).toBe('path');
      expect(linea.getAttribute('d')).toContain('M');
      // El tirador invisible también, o el ratón acertaría en otro sitio que la
      // línea que se ve.
      expect(raiz.querySelector('.esq-conexion .esq-tirador')!.tagName.toLowerCase()).toBe('path');
    });

    it('los nodos en diagonal doblan en vez de ir en oblicuo', () => {
      anadirPaso();
      const a = centroDe(nodos()[0]);
      anadirPaso();
      // El segundo bien abajo y a la derecha: en diagonal respecto del primero.
      const lejos = { x: a.x + 240, y: a.y + 200 };
      puntero('pointerdown', centroDe(nodos()[1]));
      puntero('pointermove', lejos);
      puntero('pointerup', lejos);

      boton('Conectar dos nodos').click();
      fixture.detectChanges();
      puntero('pointerdown', centroDe(nodos()[0]));
      puntero('pointerdown', centroDe(nodos()[1]));

      // `Q` es el redondeo del codo: si la ruta fuera recta no habría ninguno.
      expect(raiz.querySelector('.esq-conexion .esq-linea')!.getAttribute('d')).toContain('Q');
    });
  });

  describe('menú de la flecha', () => {
    const menu = () => raiz.querySelector<HTMLElement>('.menu-flecha');

    /** Dos nodos unidos, y el punto medio de la flecha en pantalla. */
    function conFlecha(): { x: number; y: number } {
      anadirPaso();
      const a = centroDe(nodos()[0]);
      anadirPaso();
      const b = { x: a.x + 260, y: a.y };
      // Se separa el segundo para que la flecha tenga recorrido donde pinchar.
      puntero('pointerdown', centroDe(nodos()[1]));
      puntero('pointermove', b);
      puntero('pointerup', b);

      boton('Conectar dos nodos').click();
      fixture.detectChanges();
      puntero('pointerdown', centroDe(nodos()[0]));
      puntero('pointerdown', centroDe(nodos()[1]));
      boton('Seleccionar y editar').click();
      fixture.detectChanges();

      const p = centroDe(nodos()[0]);
      const q = centroDe(nodos()[1]);
      return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
    }

    it('no sale hasta que se pulsa una flecha', () => {
      const medio = conFlecha();
      expect(menu()).toBeNull();

      puntero('pointerdown', medio);
      expect(menu()).not.toBeNull();
    });

    it('trae las cuatro familias y las miniaturas pintadas', () => {
      puntero('pointerdown', conFlecha());

      const titulos = [...menu()!.querySelectorAll('h3')].map((h) => h.textContent!.trim());
      expect(titulos).toEqual(['Diagrama de flujo', 'UML', 'BPMN', 'Entidad-relación']);

      // Cada tipo enseña su propia línea; si el catálogo no diera contorno, el
      // botón saldría vacío.
      const lineas = menu()!.querySelectorAll('.mini-flecha .linea');
      expect(lineas.length).toBeGreaterThan(15);
      expect([...lineas].every((l) => (l.getAttribute('d') ?? '').includes('M'))).toBe(true);
    });

    it('elegir un tipo lo aplica a la flecha', () => {
      puntero('pointerdown', conFlecha());

      menu()!.querySelector<HTMLButtonElement>('button[title="Uno a muchos"]')!.click();
      fixture.detectChanges();

      boton('Guardar').click();
      expect(cerradoCon!.conexiones[0].tipo).toBe('erd-1-n');
    });

    it('las patas de gallo llegan al lienzo', () => {
      puntero('pointerdown', conFlecha());
      menu()!.querySelector<HTMLButtonElement>('button[title="Muchos a muchos"]')!.click();
      fixture.detectChanges();

      // Tres trazos por extremo, seis en total, y ninguno relleno.
      const marcas = raiz.querySelectorAll('.esq-conexion .esq-marca');
      expect(marcas.length).toBe(6);
      expect([...marcas].every((m) => m.classList.contains('relleno-ninguno'))).toBe(true);
    });

    it('invertir da la vuelta a la flecha sin cambiarle el tipo', () => {
      puntero('pointerdown', conFlecha());
      menu()!.querySelector<HTMLButtonElement>('button[title="Uno a muchos"]')!.click();
      fixture.detectChanges();

      boton('Guardar');
      const antes = raiz.querySelectorAll('.esq-marca').length;
      menu()!.querySelector<HTMLButtonElement>('.invertir')!.click();
      fixture.detectChanges();

      expect(raiz.querySelectorAll('.esq-marca').length).toBe(antes, 'las mismas marcas');
      boton('Guardar').click();
      expect(cerradoCon!.conexiones[0].tipo).toBe('erd-1-n', 'el tipo no se toca');
      // Los extremos sí se intercambian: es lo que hace que 1:N se lea N:1.
      expect(cerradoCon!.conexiones[0].desde).toBe(cerradoCon!.nodos[1].id);
    });

    it('el menú desaparece al seleccionar otra cosa', () => {
      puntero('pointerdown', conFlecha());
      expect(menu()).not.toBeNull();

      puntero('pointerdown', centroDe(nodos()[0]));
      expect(menu()).toBeNull('con un nodo seleccionado no pinta nada');
    });
  });

  describe('panel de columnas', () => {
    const filas = () => Array.from(raiz.querySelectorAll<HTMLElement>('.panel-columnas .fila'));
    const nombresPintados = () =>
      Array.from(raiz.querySelectorAll('.esq-columna')).map((c) => c.textContent);

    function escribir(campo: HTMLInputElement, valor: string): void {
      campo.value = valor;
      campo.dispatchEvent(new Event('input'));
      fixture.detectChanges();
    }

    function pulsar(fila: HTMLElement, selector: string, i = 0): void {
      fila.querySelectorAll<HTMLButtonElement>(selector)[i].click();
      fixture.detectChanges();
    }

    /* Lo siguiente que se hace tras poner una tabla es escribirle los campos, y
       el botón del pie es fácil de no ver la primera vez. */
    it('se abre solo al insertar una tabla, y no con las demás formas', () => {
      anadirForma('Tabla');
      expect(raiz.querySelector('.panel-columnas')).not.toBeNull();
      expect(filas().length).toBe(1, 'nace con su clave primaria');

      anadirForma('Paso');
      expect(raiz.querySelector('.panel-columnas')).toBeNull();
    });

    it('añade, renombra, tipa y pinta', () => {
      anadirForma('Tabla');
      raiz.querySelector<HTMLButtonElement>('.panel-columnas .anadir')!.click();
      fixture.detectChanges();

      escribir(filas()[1].querySelector<HTMLInputElement>('.nombre')!, 'cliente_id');
      escribir(filas()[1].querySelector<HTMLInputElement>('.tipo')!, 'int');

      expect(nombresPintados()).toEqual(['id', 'cliente_id']);
      expect(Array.from(raiz.querySelectorAll('.esq-tipo')).map((t) => t.textContent)).toEqual([
        'int',
        'int',
      ]);
    });

    it('PK y FK son dos interruptores: una columna puede ser las dos', () => {
      anadirForma('Tabla');
      // La que nace ya es primaria; se le marca además la foránea.
      pulsar(filas()[0], '.marca', 1);

      expect(raiz.querySelectorAll('.esq-llave').length).toBe(1);
      expect(raiz.querySelectorAll('.esq-foranea').length).toBe(1);
      expect(filas()[0].querySelectorAll('.marca')[0].classList).toContain('activa');
      expect(filas()[0].querySelectorAll('.marca')[1].classList).toContain('activa');
    });

    it('reordena y quita', () => {
      const tabla = anadirForma('Tabla');
      const altoConUna = tabla.querySelector('.esq-forma')!.getBoundingClientRect().height;

      raiz.querySelector<HTMLButtonElement>('.panel-columnas .anadir')!.click();
      fixture.detectChanges();
      escribir(filas()[1].querySelector<HTMLInputElement>('.nombre')!, 'total');
      expect(nodos()[0].querySelector('.esq-forma')!.getBoundingClientRect().height)
        .toBeGreaterThan(altoConUna, 'la caja crece con la lista');

      pulsar(filas()[1], '.orden', 0); // subir
      expect(nombresPintados()).toEqual(['total', 'id']);

      pulsar(filas()[0], '.orden', 2); // quitar
      expect(nombresPintados()).toEqual(['id']);
    });

    it('el panel se va al deseleccionar y las columnas se guardan', () => {
      anadirForma('Tabla');
      escribir(raiz.querySelector<HTMLInputElement>('footer .etiqueta')!, 'factura');

      // Clic en el vacío: deja de haber tabla seleccionada.
      const p = { x: 40, y: 40 };
      puntero('pointerdown', p);
      puntero('pointerup', p);
      expect(raiz.querySelector('.panel-columnas')).toBeNull();

      boton('Guardar').click();
      expect(cerradoCon?.nodos[0].texto).toBe('factura');
      expect(cerradoCon?.nodos[0].columnas).toEqual([{ nombre: 'id', tipo: 'int', pk: true }]);
    });
  });

  describe('barra de herramientas', () => {
    it('el panel agrupa las formas por familia y las inserta', () => {
      boton('Formas').click();
      fixture.detectChanges();

      const titulos = [...raiz.querySelectorAll('.panel-formas h3')].map((h) => h.textContent!.trim());
      expect(titulos).toEqual(['Diagrama de flujo', 'UML', 'BPMN', 'Entidad-relación']);

      // Y las miniaturas se dibujan solas desde el catálogo: si una forma no
      // trajera contorno, el botón saldría vacío.
      const minis = raiz.querySelectorAll('.panel-formas .mini path');
      expect(minis.length).toBeGreaterThan(10);
      expect([...minis].every((p) => (p.getAttribute('d') ?? '').length > 10)).toBe(true);
    });

    it('insertar una forma cierra el panel y deja la herramienta en selección', () => {
      anadirForma('Base de datos');

      expect(raiz.querySelector('.panel-formas')).toBeNull();
      expect(nodos().length).toBe(1);
      boton('Guardar').click();
      expect(cerradoCon!.nodos[0].forma).toBe('almacen');
    });

    it('las formas con adornos los dibujan (la tapa del cilindro)', () => {
      anadirForma('Base de datos');

      expect(raiz.querySelector('.esq-nodo .esq-adorno')).not.toBeNull();
    });

    describe('mover el lienzo', () => {
      it('arrastrar desplaza la vista sin tocar el esquema', () => {
        anadirPaso();
        const antes = centroDe(nodos()[0]);

        boton('Mover el lienzo').click();
        fixture.detectChanges();
        puntero('pointerdown', { x: 400, y: 400 });
        puntero('pointermove', { x: 520, y: 400 });
        puntero('pointerup', { x: 520, y: 400 });

        // El nodo se ve más a la derecha…
        expect(centroDe(nodos()[0]).x).toBeGreaterThan(antes.x + 60);
        // …pero sus coordenadas no se han tocado: se movió la ventana, no él.
        boton('Guardar').click();
        expect(cerradoCon!.nodos[0].x).toBe(390);
      });

      it('con la mano no se selecciona ni se mueve nada', () => {
        anadirPaso();
        const centro = centroDe(nodos()[0]);

        boton('Mover el lienzo').click();
        fixture.detectChanges();
        // Elegir la mano suelta la selección, así que el pie enseña la pista.
        expect(raiz.querySelector('.etiqueta')).toBeNull();

        puntero('pointerdown', centro);
        puntero('pointerup', centro);

        expect(raiz.querySelector('.etiqueta')).toBeNull('pulsar un nodo no lo selecciona');
        expect(raiz.querySelectorAll('.esq-punto').length).toBe(0, 'ni salen sus puntos');
      });

      it('volver al centro deshace el desplazamiento', () => {
        anadirPaso();
        const antes = centroDe(nodos()[0]);

        boton('Mover el lienzo').click();
        fixture.detectChanges();
        puntero('pointerdown', { x: 400, y: 400 });
        puntero('pointermove', { x: 300, y: 330 });
        puntero('pointerup', { x: 300, y: 330 });
        expect(centroDe(nodos()[0]).x).toBeLessThan(antes.x - 40);

        boton('Volver al centro').click();
        fixture.detectChanges();
        expect(centroDe(nodos()[0]).x).toBeCloseTo(antes.x, 0);
      });
    });
  });

  it('cancelar no devuelve nada; guardar devuelve el esquema', () => {
    anadirPaso();

    boton('Descartar').click();
    expect(cerradoCon).toBeNull();

    boton('Guardar').click();
    expect(cerradoCon?.nodos.length).toBe(1);
  });
});
