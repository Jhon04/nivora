import { TABLA } from './catalogo';
import {
  ALCANCE_ENLACE,
  Esquema,
  SEPARACION_PUNTO,
  anclaje,
  borrarNodo,
  borrarVarios,
  brotar,
  cajaEntre,
  cambiarTipoConexion,
  Columna,
  conectar,
  conexionEn,
  crearNodo,
  dentro,
  editarColumnas,
  engancheEn,
  envolvente,
  invertirConexion,
  huecoLlaves,
  moverColumna,
  moverNodo,
  moverNodos,
  nodoFantasma,
  nodosEnCaja,
  normalizar,
  medioDeRuta,
  rutaEntre,
  rutas,
  puntoDe,
  rehacerNodo,
  tamanoPara,
  textoDe,
  vecinoEn,
} from './modelo';

/** Nodo de medidas redondas: 100 × 40 centrado en el origen. */
function nodo(forma: 'proceso' | 'decision' | 'terminal' = 'proceso') {
  return { id: 'n1', x: 0, y: 0, ancho: 100, alto: 40, texto: 'X', forma };
}

const cerca = (a: number, b: number, tol = 0.05) => Math.abs(a - b) <= tol;

describe('modelo del esquema', () => {
  describe('anclaje', () => {
    it('apoya la flecha en el borde del rectángulo', () => {
      const n = nodo();

      const derecha = anclaje(n, { x: 1000, y: 0 });
      expect(cerca(derecha.x, 50)).toBe(true, `x fue ${derecha.x}`);
      expect(cerca(derecha.y, 0)).toBe(true);

      const abajo = anclaje(n, { x: 0, y: 1000 });
      expect(cerca(abajo.y, 20)).toBe(true, `y fue ${abajo.y}`);
    });

    /*
     * La diagonal es lo que separa de verdad a las tres formas: por los lados y
     * por arriba todas se anclan casi igual, y es en la esquina donde el rombo
     * mete la flecha hacia dentro. Si esto falla, las flechas de un diagrama de
     * decisión salen despegadas del nodo.
     */
    it('el rombo ancla más adentro que el rectángulo en la diagonal', () => {
      const enRect = anclaje(nodo('proceso'), { x: 1000, y: 1000 });
      const enRombo = anclaje(nodo('decision'), { x: 1000, y: 1000 });

      // Rectángulo: sale por el lado de abajo (y = 20), luego x = 20.
      expect(cerca(enRect.x, 20)).toBe(true, `x fue ${enRect.x}`);
      // Rombo: x/50 + y/20 = 1 con x = y → 1/(1/50 + 1/20) = 14,29.
      expect(cerca(enRombo.x, 14.29)).toBe(true, `x fue ${enRombo.x}`);
    });

    it('el punto que devuelve está justo en el borde, para las tres formas', () => {
      for (const forma of ['proceso', 'decision', 'terminal'] as const) {
        const n = nodo(forma);
        const p = anclaje(n, { x: 300, y: 120 });
        const hacia = { x: 300 - n.x, y: 120 - n.y };
        const largo = Math.hypot(hacia.x, hacia.y);
        const paso = { x: (hacia.x / largo) * 0.5, y: (hacia.y / largo) * 0.5 };

        expect(dentro(n, { x: p.x - paso.x, y: p.y - paso.y })).toBe(true, `${forma}: medio px adentro`);
        expect(dentro(n, { x: p.x + paso.x, y: p.y + paso.y })).toBe(false, `${forma}: medio px afuera`);
      }
    });

    it('no se va a infinito cuando el destino cae dentro del propio nodo', () => {
      const p = anclaje(nodo(), { x: 3, y: 2 });

      expect(Number.isFinite(p.x)).toBe(true);
      expect(cerca(Math.hypot(p.x, p.y), Math.hypot(50, 40 / 3), 40)).toBe(true, 'sigue en el borde');
    });
  });

  describe('formas', () => {
    it('la esquina del rombo queda fuera y su centro dentro', () => {
      const n = nodo('decision');

      expect(dentro(n, { x: 0, y: 0 })).toBe(true);
      // La esquina de la caja: dentro del rectángulo, fuera del rombo.
      expect(dentro(n, { x: 49, y: 19 })).toBe(false);
    });

    it('la pastilla del terminal redondea los extremos', () => {
      const n = nodo('terminal');

      expect(dentro(n, { x: 0, y: 19 })).toBe(true, 'el centro llega hasta arriba');
      // Esquina superior derecha: dentro del rectángulo, fuera del semicírculo.
      expect(dentro(n, { x: 49, y: 19 })).toBe(false);
    });

    it('el rombo necesita más sitio que el rectángulo para el mismo texto', () => {
      const proceso = tamanoPara('Comprobar el saldo', 'proceso');
      const decision = tamanoPara('Comprobar el saldo', 'decision');

      // No es margen de sobra: el texto solo cabe en un rombo del doble.
      expect(decision.ancho).toBeGreaterThan(proceso.ancho);
      expect(decision.alto).toBeGreaterThan(proceso.alto);
    });
  });

  /* La tabla es la única forma cuyo contenido no cabe en `texto`: lleva una
     lista de columnas, y de esa lista salen su alto, su ancho y el margen de las
     llaves. Todo lo que se mide aquí lo vuelve a usar `dibujo.ts` para pintar,
     así que si estas cuentas se van, el texto se sale de la caja. */
  describe('tabla', () => {
    const cols = (...c: Columna[]) => c;

    it('crece una fila por columna', () => {
      const una = tamanoPara('factura', 'erd-tabla', cols({ nombre: 'id' }));
      const tres = tamanoPara(
        'factura',
        'erd-tabla',
        cols({ nombre: 'id' }, { nombre: 'total' }, { nombre: 'fecha' }),
      );

      // Exactamente dos filas más de alto, no «un poco más»: las filas de dos
      // tablas puestas al lado tienen que quedar a la misma altura.
      expect(tres.alto - una.alto).toBe(40);
    });

    it('sin columnas conserva el alto de una fila', () => {
      const vacia = tamanoPara('factura', 'erd-tabla', []);
      const una = tamanoPara('factura', 'erd-tabla', cols({ nombre: 'id' }));

      // Si se encogiera hasta la cabecera, borrar la última columna dejaría algo
      // que ya no parece una tabla.
      expect(vacia.alto).toBe(una.alto);
    });

    it('se ensancha con el nombre de columna más largo y con su tipo', () => {
      const corta = tamanoPara('t', 'erd-tabla', cols({ nombre: 'id' }));
      const larga = tamanoPara('t', 'erd-tabla', cols({ nombre: 'identificador_del_cliente' }));
      const conTipo = tamanoPara(
        't',
        'erd-tabla',
        cols({ nombre: 'identificador_del_cliente', tipo: 'varchar(120)' }),
      );

      expect(larga.ancho).toBeGreaterThan(corta.ancho);
      expect(conTipo.ancho).toBeGreaterThan(larga.ancho);
    });

    it('el margen de las llaves se cuenta por tabla, no por fila', () => {
      const sinClaves = cols({ nombre: 'a' }, { nombre: 'b' });
      const soloPk = cols({ nombre: 'a', pk: true }, { nombre: 'b' });
      const ambas = cols({ nombre: 'a', pk: true }, { nombre: 'b', fk: true });
      const juntas = cols({ nombre: 'a', pk: true, fk: true });

      expect(huecoLlaves(sinClaves)).toBe(0, 'sin claves no se gasta el hueco, ni el respiro');
      expect(huecoLlaves(soloPk)).toBeGreaterThan(0);
      // Una casilla más, no el doble: el respiro se paga una sola vez.
      expect(huecoLlaves(ambas) - huecoLlaves(soloPk)).toBe(TABLA.casilla);
      // Una columna que es las dos cosas necesita las dos casillas ella sola.
      expect(huecoLlaves(juntas)).toBe(huecoLlaves(ambas));
    });

    it('nace con una clave primaria puesta', () => {
      const n = crearNodo('factura', 'erd-tabla', { x: 0, y: 0 });

      expect(n.columnas?.length).toBe(1);
      expect(n.columnas?.[0].pk).toBe(true);
    });

    it('las demás formas no cargan con una lista de columnas', () => {
      expect(crearNodo('Paso', 'proceso', { x: 0, y: 0 }).columnas).toBeUndefined();
    });

    /* No hay deshacer en este diálogo, y en el pie las cinco formas de
       entidad-relación están una al lado de otra: un clic de más no puede
       llevarse por delante doce columnas escritas a mano. */
    it('cambiar de forma no se lleva las columnas por delante', () => {
      const tabla = crearNodo('factura', 'erd-tabla', { x: 0, y: 0 });
      const conCampos = rehacerNodo(tabla, {
        columnas: [{ nombre: 'id', pk: true }, { nombre: 'total', tipo: 'decimal' }],
      });

      const entidad = rehacerNodo(conCampos, { forma: 'erd-entidad' });
      expect(entidad.columnas?.length).toBe(2, 'se guardan aunque no se pinten');

      const vuelta = rehacerNodo(entidad, { forma: 'erd-tabla' });
      expect(vuelta.columnas?.length).toBe(2);
      expect(vuelta.alto).toBe(conCampos.alto, 'y la caja vuelve a su sitio');
    });

    it('editarColumnas recalcula la caja', () => {
      const tabla = crearNodo('factura', 'erd-tabla', { x: 0, y: 0 });
      const e: Esquema = { nodos: [tabla], conexiones: [] };

      const con = editarColumnas(e, tabla.id, (c) => [...c, { nombre: 'total' }]);

      expect(con.nodos[0].columnas?.length).toBe(2);
      expect(con.nodos[0].alto).toBeGreaterThan(tabla.alto);
      // El original no se toca: el esquema es inmutable y de ahí sale la
      // memoización de las rutas.
      expect(tabla.columnas?.length).toBe(1);
    });

    it('moverColumna intercambia y aguanta los extremos', () => {
      const lista = cols({ nombre: 'a' }, { nombre: 'b' }, { nombre: 'c' });

      expect(moverColumna(lista, 1, -1).map((c) => c.nombre)).toEqual(['b', 'a', 'c']);
      expect(moverColumna(lista, 1, 1).map((c) => c.nombre)).toEqual(['a', 'c', 'b']);
      expect(moverColumna(lista, 0, -1).map((c) => c.nombre)).toEqual(['a', 'b', 'c']);
      expect(moverColumna(lista, 2, 1).map((c) => c.nombre)).toEqual(['a', 'b', 'c']);
      expect(moverColumna(lista, 9, 1).map((c) => c.nombre)).toEqual(['a', 'b', 'c']);
    });

    it('el que brota de una tabla es otra tabla, no una copia', () => {
      const origen = rehacerNodo(crearNodo('factura', 'erd-tabla', { x: 0, y: 0 }), {
        columnas: [{ nombre: 'id', pk: true }, { nombre: 'total' }, { nombre: 'fecha' }],
      });

      const brote = nodoFantasma(origen, 'derecha', 'tabla');

      expect(brote.forma).toBe('erd-tabla');
      expect(brote.columnas?.length).toBe(1, 'con su clave primaria y nada más');
      expect(brote.columnas?.[0].pk).toBe(true);
    });

    describe('normalizar', () => {
      const leer = (columnas: unknown) =>
        normalizar({
          nodos: [{ id: 'a', x: 0, y: 0, texto: 't', forma: 'erd-tabla', columnas }],
          conexiones: [],
        }).nodos[0];

      it('lee las columnas y sus banderas', () => {
        const n = leer([{ nombre: 'cliente_id', tipo: 'int', pk: true, fk: true }]);

        expect(n.columnas).toEqual([{ nombre: 'cliente_id', tipo: 'int', pk: true, fk: true }]);
      });

      it('tira las filas sin nada y las banderas que no son `true`', () => {
        const n = leer([{}, null, 7, { nombre: 'total', pk: 'sí', fk: 1 }]);

        expect(n.columnas).toEqual([{ nombre: 'total' }]);
      });

      it('una lista que no es lista no deja un `columnas` a medias', () => {
        for (const basura of [undefined, null, 'id, total', 42]) {
          expect(leer(basura).columnas).toBeUndefined(`con ${JSON.stringify(basura)}`);
        }
      });

      /* La caja de una tabla sale entera de sus columnas. Si se respetara el
         tamaño guardado, una nota escrita con una versión que tuviera otro alto
         de fila aparecería con las filas desbordando el rectángulo. */
      it('vuelve a medir la tabla aunque el fichero traiga otro tamaño', () => {
        const n = normalizar({
          nodos: [
            {
              id: 'a', x: 0, y: 0, ancho: 20, alto: 20,
              texto: 'factura', forma: 'erd-tabla',
              columnas: [{ nombre: 'id' }, { nombre: 'total' }],
            },
          ],
          conexiones: [],
        }).nodos[0];

        expect(n.alto).toBe(tamanoPara('factura', 'erd-tabla', n.columnas).alto);
        expect(n.alto).toBeGreaterThan(20);
      });

      it('a las demás formas les respeta el tamaño guardado', () => {
        const n = normalizar({
          nodos: [{ id: 'a', x: 0, y: 0, ancho: 20, alto: 20, texto: 'X', forma: 'proceso' }],
          conexiones: [],
        }).nodos[0];

        expect(n.ancho).toBe(20);
      });
    });
  });

  describe('conectar', () => {
    const dos = (): Esquema => ({
      nodos: [
        { ...nodo(), id: 'a' },
        { ...nodo(), id: 'b', x: 200 },
      ],
      conexiones: [],
    });

    it('une dos nodos', () => {
      expect(conectar(dos(), 'a', 'b').conexiones.length).toBe(1);
    });

    it('no conecta un nodo consigo mismo ni repite una conexión', () => {
      expect(conectar(dos(), 'a', 'a').conexiones.length).toBe(0);

      const una = conectar(dos(), 'a', 'b');
      // Repetirla dibujaría dos flechas exactamente encima la una de la otra.
      expect(conectar(una, 'a', 'b').conexiones.length).toBe(1);
    });

    /*
     * Pasa de verdad: se borra el nodo de origen con una flecha a medias y el
     * clic siguiente llega aquí con un id ya difunto. Sin esta guarda quedaría
     * guardada en la nota una conexión que no se dibuja nunca.
     */
    it('no conecta con un nodo que ya no existe', () => {
      expect(conectar(dos(), 'a', 'fantasma').conexiones.length).toBe(0);
      expect(conectar(dos(), 'fantasma', 'b').conexiones.length).toBe(0);
    });
  });

  /*
   * Una conexión huérfana no se dibuja nunca (`extremos` la descarta), así que
   * sobreviviría invisible en el fichero de la nota y volvería a aparecer si
   * alguien reutilizara el id.
   */
  it('borrar un nodo se lleva sus conexiones', () => {
    const e = conectar(
      {
        nodos: [
          { ...nodo(), id: 'a' },
          { ...nodo(), id: 'b', x: 200 },
        ],
        conexiones: [],
      },
      'a',
      'b',
    );

    const sinA = borrarNodo(e, 'a');
    expect(sinA.nodos.length).toBe(1);
    expect(sinA.conexiones.length).toBe(0);
  });

  it('mover un nodo no toca a los demás', () => {
    const e: Esquema = {
      nodos: [
        { ...nodo(), id: 'a' },
        { ...nodo(), id: 'b', x: 200 },
      ],
      conexiones: [],
    };

    const movido = moverNodo(e, 'a', 10, -5);
    expect(movido.nodos[0]).toEqual(jasmine.objectContaining({ x: 10, y: -5 }));
    expect(movido.nodos[1].x).toBe(200);
  });

  it('la envolvente cubre todos los nodos con su margen', () => {
    const e: Esquema = { nodos: [{ ...nodo(), id: 'a' }], conexiones: [] };

    const c = envolvente(e, 10);
    expect(c.x).toBe(-60);
    expect(c.w).toBe(120);
  });

  it('el texto para buscar recoge nodos y etiquetas de las flechas', () => {
    const e: Esquema = {
      nodos: [crearNodo('Pasarela de pago', 'proceso', { x: 0, y: 0 })],
      conexiones: [{ id: 'c1', desde: 'x', hasta: 'y', texto: 'si falla', tipo: 'flecha' }],
    };

    const t = textoDe(e);
    expect(t).toContain('Pasarela de pago');
    expect(t).toContain('si falla');
  });

  describe('ruta en codos', () => {
    /** Todos los tramos tienen que ir en horizontal o en vertical. */
    function enAngulosRectos(pts: { x: number; y: number }[]): boolean {
      for (let i = 1; i < pts.length; i++) {
        const dx = Math.abs(pts[i].x - pts[i - 1].x);
        const dy = Math.abs(pts[i].y - pts[i - 1].y);
        if (dx > 0.5 && dy > 0.5) return false;
      }
      return true;
    }

    const nodoEn = (id: string, x: number, y: number) => ({ ...nodo(), id, x, y });

    it('todos los tramos van en ángulo recto', () => {
      // Cuatro posiciones relativas, incluida la diagonal, que es la que antes
      // salía como una línea inclinada.
      for (const [x, y] of [[400, 0], [0, 400], [400, 300], [-350, -250]]) {
        const ruta = rutaEntre(nodoEn('a', 0, 0), nodoEn('b', x, y));
        expect(enAngulosRectos(ruta)).toBe(true, `con destino ${x},${y}: ${JSON.stringify(ruta)}`);
        expect(ruta.length).toBeGreaterThanOrEqual(2);
      }
    });

    it('sale por el lado que mira al otro nodo', () => {
      const derecha = rutaEntre(nodoEn('a', 0, 0), nodoEn('b', 400, 0));
      // El nodo mide 100 de ancho: sale por su cara derecha, en x = 50.
      expect(cerca(derecha[0].x, 50)).toBe(true, `salió por x=${derecha[0].x}`);

      const abajo = rutaEntre(nodoEn('a', 0, 0), nodoEn('b', 0, 400));
      // Y aquí por la de abajo, en y = 20.
      expect(cerca(abajo[0].y, 20)).toBe(true, `salió por y=${abajo[0].y}`);
    });

    /*
     * Si dos nodos están alineados no hay nada que doblar. Sin simplificar, los
     * vértices sobrarían igual y el redondeo de esquinas le pondría curvas a una
     * recta.
     */
    it('dos nodos enfrentados dan una recta, sin codos de adorno', () => {
      const ruta = rutaEntre(nodoEn('a', 0, 0), nodoEn('b', 400, 0));
      expect(ruta.length).toBe(2);
    });

    it('el punto medio se mide sobre el recorrido, no en línea recta', () => {
      // Una L de 100 en horizontal y 100 en vertical: la mitad cae justo en el codo.
      const medio = medioDeRuta([
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
      ]);
      expect(cerca(medio.x, 100)).toBe(true, `x=${medio.x}`);
      expect(cerca(medio.y, 0)).toBe(true, `y=${medio.y}`);
    });

    describe('reparto de ranuras', () => {
      /** Un nodo con tres vecinos, todos al mismo lado. */
      const abanico = (): Esquema => {
        let e: Esquema = {
          nodos: [
            nodoEn('centro', 0, 0),
            nodoEn('x', 400, -200),
            nodoEn('y', 400, 0),
            nodoEn('z', 400, 200),
          ],
          conexiones: [],
        };
        for (const id of ['x', 'y', 'z']) e = conectar(e, 'centro', id);
        return e;
      };

      it('las flechas de un mismo lado salen por puntos distintos', () => {
        const e = abanico();
        const mapa = rutas(e);
        const salidas = e.conexiones.map((c) => mapa.get(c.id)![0].y);

        // Si no se repartieran, las tres saldrían del mismo punto y se
        // solaparían nada más nacer.
        expect(new Set(salidas.map((v) => v.toFixed(1))).size).toBe(3, `salidas ${salidas}`);
      });

      /*
       * Que sean distintas no basta: separadas por un pelo se ven como una sola
       * línea gruesa. Pasó de verdad — `puntoDeLado` apuntaba a una anchura
       * entera en vez de a media, y el rayo de `anclaje` llegaba al borde con la
       * mitad del desvío.
       */
      it('el reparto ocupa una parte apreciable del lado', () => {
        const mapa = rutas(abanico());
        const ys = [...mapa.values()].map((r) => r[0].y);
        const ancho = Math.max(...ys) - Math.min(...ys);

        // Al menos un tercio del alto del nodo (que mide 40). Con el reparto a
        // la mitad salían 8 y se veían como una sola línea gruesa.
        expect(ancho).toBeGreaterThan(40 / 3, `solo abarcaron ${ancho.toFixed(1)}`);
      });

      /*
       * Ordenadas por dónde queda el otro extremo: la que va al vecino de arriba
       * sale por arriba. Al revés se cruzarían entre ellas al salir.
       */
      it('se ordenan para no cruzarse entre ellas', () => {
        const e = abanico();
        const mapa = rutas(e);
        const porDestino = new Map(
          e.conexiones.map((c) => [c.hasta, mapa.get(c.id)![0].y]),
        );

        expect(porDestino.get('x')!).toBeLessThan(porDestino.get('y')!);
        expect(porDestino.get('y')!).toBeLessThan(porDestino.get('z')!);
      });

      it('una sola flecha sale por el centro del lado', () => {
        const e = conectar(
          { nodos: [nodoEn('a', 0, 0), nodoEn('b', 400, 0)], conexiones: [] },
          'a',
          'b',
        );
        expect(cerca(rutas(e).get(e.conexiones[0].id)![0].y, 0)).toBe(true);
      });

      it('una conexión sin uno de sus nodos no genera ruta', () => {
        const e: Esquema = {
          nodos: [nodoEn('a', 0, 0)],
          conexiones: [{ id: 'c1', desde: 'a', hasta: 'fantasma', texto: '', tipo: 'flecha' }],
        };
        expect(rutas(e).size).toBe(0);
      });
    });

    describe('esquivar nodos', () => {
      /** ¿Se mete algún tramo dentro de la caja del nodo? */
      function atraviesa(pts: { x: number; y: number }[], n: ReturnType<typeof nodo>): boolean {
        const x1 = n.x - n.ancho / 2;
        const x2 = n.x + n.ancho / 2;
        const y1 = n.y - n.alto / 2;
        const y2 = n.y + n.alto / 2;
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1];
          const b = pts[i];
          if (
            Math.min(a.x, b.x) < x2 &&
            Math.max(a.x, b.x) > x1 &&
            Math.min(a.y, b.y) < y2 &&
            Math.max(a.y, b.y) > y1
          ) {
            return true;
          }
        }
        return false;
      }

      /** Uno a la izquierda, otro a la derecha, y un tercero justo en medio. */
      const conEstorbo = () => ({
        a: nodoEn('a', 0, 0),
        b: nodoEn('b', 500, 0),
        medio: nodoEn('medio', 250, 0),
      });

      it('la ruta rodea el nodo que hay en medio', () => {
        const { a, b, medio } = conEstorbo();

        const sinEsquiva = rutaEntre(a, b);
        const conEsquiva = rutaEntre(a, b, [a, b, medio]);

        // Sin obstáculos declarados va recta y lo atraviesa; ese es el fallo que
        // se está arreglando.
        expect(atraviesa(sinEsquiva, medio)).toBe(true, 'la recta sí lo cruza');
        expect(atraviesa(conEsquiva, medio)).toBe(false, `lo cruzó: ${JSON.stringify(conEsquiva)}`);
      });

      it('lo que rodea sigue siendo todo ángulos rectos', () => {
        const { a, b, medio } = conEstorbo();
        expect(enAngulosRectos(rutaEntre(a, b, [a, b, medio]))).toBe(true);
      });

      it('sigue empezando y acabando en los enganches de siempre', () => {
        const { a, b, medio } = conEstorbo();
        const ruta = rutaEntre(a, b, [a, b, medio]);

        // Sale por la cara derecha de «a» y entra por la izquierda de «b».
        expect(cerca(ruta[0].x, 50)).toBe(true, `empezó en x=${ruta[0].x}`);
        expect(cerca(ruta[ruta.length - 1].x, 450)).toBe(true);
      });

      /*
       * Lo caro es el Dijkstra, y no puede pagarse en cada repintado cuando no
       * hace falta: sin nada en medio la ruta tiene que salir idéntica a la
       * simple, que es la señal de que ni se ha intentado esquivar.
       */
      it('sin nada en medio no cambia la ruta simple', () => {
        const a = nodoEn('a', 0, 0);
        const b = nodoEn('b', 500, 0);
        const lejos = nodoEn('lejos', 250, 600);

        expect(rutaEntre(a, b, [a, b, lejos])).toEqual(rutaEntre(a, b));
      });

      it('los dos nodos que une nunca se consideran estorbo', () => {
        const a = nodoEn('a', 0, 0);
        const b = nodoEn('b', 400, 0);
        // Si contaran como obstáculos, la ruta no podría ni salir ni llegar.
        expect(rutaEntre(a, b, [a, b]).length).toBeGreaterThanOrEqual(2);
      });

      it('no doblega el número de codos más de lo necesario', () => {
        const { a, b, medio } = conEstorbo();
        const ruta = rutaEntre(a, b, [a, b, medio]);

        // Rodear una caja por arriba o por abajo son cuatro codos como mucho;
        // más que eso es una escalera, y significa que el castigo por giro no
        // está haciendo su trabajo.
        expect(ruta.length).toBeLessThanOrEqual(6, `salieron ${ruta.length} puntos`);
      });

      it('un nodo encerrado no rompe: se queda con la ruta simple', () => {
        const a = nodoEn('a', 0, 0);
        const b = nodoEn('b', 300, 0);
        // Una muralla de cajas solapadas alrededor del destino.
        const muro = [];
        for (let i = -2; i <= 2; i++) {
          muro.push(nodoEn(`m${i}`, 300 + i * 60, -80), nodoEn(`n${i}`, 300 + i * 60, 80));
        }
        muro.push(nodoEn('mi', 180, 0), nodoEn('md', 420, 0));

        const ruta = rutaEntre(a, b, [a, b, ...muro]);
        expect(ruta.length).toBeGreaterThanOrEqual(2);
        expect(enAngulosRectos(ruta)).toBe(true);
      });

      it('las rutas del esquema completo también esquivan', () => {
        const { a, b, medio } = conEstorbo();
        const e = conectar({ nodos: [a, b, medio], conexiones: [] }, 'a', 'b');

        const ruta = rutas(e).get(e.conexiones[0].id)!;
        expect(atraviesa(ruta, medio)).toBe(false, `lo cruzó: ${JSON.stringify(ruta)}`);
      });
    });

    it('se acierta con el ratón en un codo, fuera de la recta entre centros', () => {
      const e = conectar(
        { nodos: [nodoEn('a', 0, 0), nodoEn('b', 300, 260)], conexiones: [] },
        'a',
        'b',
      );
      const ruta = rutas(e).get(e.conexiones[0].id)!;
      // Un punto del tramo del medio, que con codos queda lejos de la diagonal.
      const tramo = ruta[Math.floor(ruta.length / 2)];

      expect(conexionEn(e, tramo, 8)).toBeDefined();
    });
  });

  describe('tipo de conexión', () => {
    const unida = (): Esquema =>
      conectar(
        {
          nodos: [
            { ...nodo(), id: 'a' },
            { ...nodo(), id: 'b', x: 300 },
          ],
          conexiones: [],
        },
        'a',
        'b',
      );

    it('nace con la flecha simple', () => {
      expect(unida().conexiones[0].tipo).toBe('flecha');
    });

    it('cambiar el tipo solo toca a esa conexión', () => {
      const e = cambiarTipoConexion(unida(), unida().conexiones[0].id, 'erd-1-n');
      // El id se regenera en cada `unida()`, así que se busca por posición.
      const cambiada = cambiarTipoConexion(unida(), 'no-existe', 'erd-1-n');
      expect(cambiada.conexiones[0].tipo).toBe('flecha', 'un id que no está no cambia nada');
      expect(e.conexiones.length).toBe(1);
    });

    /*
     * Basta con intercambiar los extremos: las marcas van pegadas a `desde` y
     * `hasta`, así que un «uno a muchos» pasa a leerse «muchos a uno» sin tocar
     * el tipo.
     */
    it('invertir intercambia los extremos y deja el tipo en paz', () => {
      const e = unida();
      const id = e.conexiones[0].id;
      const conTipo = cambiarTipoConexion(e, id, 'erd-1-n');

      const vuelta = invertirConexion(conTipo, id);

      expect(vuelta.conexiones[0].desde).toBe('b');
      expect(vuelta.conexiones[0].hasta).toBe('a');
      expect(vuelta.conexiones[0].tipo).toBe('erd-1-n');
    });

    it('invertir dos veces deja la conexión como estaba', () => {
      const e = unida();
      const id = e.conexiones[0].id;

      const ida = invertirConexion(e, id);
      const vuelta = invertirConexion(ida, id);

      expect(vuelta.conexiones[0]).toEqual(e.conexiones[0]);
    });

    describe('normalizar', () => {
      const conTipo = (tipo: unknown) =>
        normalizar({
          nodos: [
            { id: 'a', x: 0, y: 0, texto: 'A' },
            { id: 'b', x: 300, y: 0, texto: 'B' },
          ],
          conexiones: [{ id: 'c1', desde: 'a', hasta: 'b', texto: '', tipo }],
        }).conexiones[0].tipo;

      it('respeta un tipo del catálogo', () => {
        expect(conTipo('uml-herencia')).toBe('uml-herencia');
      });

      /*
       * Las notas de antes de que esto existiera no traen `tipo`, y las de una
       * versión más nueva pueden traer uno que aquí no existe. En los dos casos
       * es mejor perder el adorno que perder la conexión.
       */
      it('lo que no reconoce cae a la flecha simple', () => {
        expect(conTipo(undefined)).toBe('flecha');
        expect(conTipo('de-otra-version')).toBe('flecha');
        expect(conTipo(42)).toBe('flecha');
      });
    });
  });

  describe('selección múltiple', () => {
    const tres = (): Esquema => ({
      nodos: [
        { ...nodo(), id: 'a', x: 0, y: 0 },
        { ...nodo(), id: 'b', x: 300, y: 0 },
        { ...nodo(), id: 'c', x: 0, y: 300 },
      ],
      conexiones: [],
    });

    it('mueve a la vez solo los nodos elegidos', () => {
      const m = moverNodos(tres(), new Set(['a', 'c']), 10, 5);

      expect(m.nodos.map((n) => n.x)).toEqual([10, 300, 10]);
      expect(m.nodos.map((n) => n.y)).toEqual([5, 0, 305]);
    });

    /*
     * Rodear por completo obligaría a barrer siempre desde fuera del grupo, y
     * con un nodo grande cerca del borde es un gesto incómodo.
     */
    it('el barrido coge los nodos que toca, no solo los que rodea', () => {
      // La caja pilla el borde derecho de «a» (que va de -50 a 50) sin llegar a
      // rodearlo, y no llega a «b» ni a «c».
      const tocados = nodosEnCaja(tres(), { x: 40, y: -10, w: 60, h: 20 });

      expect(tocados.map((n) => n.id)).toEqual(['a']);
    });

    it('el barrido devuelve varios cuando abarca a varios', () => {
      const todos = nodosEnCaja(tres(), { x: -400, y: -400, w: 900, h: 900 });
      expect(todos.length).toBe(3);
    });

    it('borrar varios se lleva nodos, conexiones y las que quedan huérfanas', () => {
      let e = conectar(tres(), 'a', 'b');
      e = conectar(e, 'b', 'c');
      const idAB = e.conexiones[0].id;

      // Se borran el nodo «b» y, aparte, la conexión a→b por su id.
      const r = borrarVarios(e, new Set(['b', idAB]));

      expect(r.nodos.map((n) => n.id)).toEqual(['a', 'c']);
      // b→c se va sola: perdió un extremo.
      expect(r.conexiones.length).toBe(0);
    });

    it('la caja entre dos puntos sale igual en cualquier orden', () => {
      const a = { x: 10, y: 90 };
      const b = { x: 70, y: 20 };

      expect(cajaEntre(a, b)).toEqual({ x: 10, y: 20, w: 60, h: 70 });
      expect(cajaEntre(b, a)).toEqual(cajaEntre(a, b));
    });
  });

  describe('puntos de enganche', () => {
    it('los cuatro puntos salen por fuera del borde, en su lado', () => {
      const n = nodo();

      const der = puntoDe(n, 'derecha');
      expect(cerca(der.x, 50 + SEPARACION_PUNTO)).toBe(true, `x fue ${der.x}`);
      expect(cerca(der.y, 0)).toBe(true);

      const arr = puntoDe(n, 'arriba');
      expect(cerca(arr.y, -(20 + SEPARACION_PUNTO))).toBe(true, `y fue ${arr.y}`);
      expect(dentro(n, arr)).toBe(false, 'el punto va fuera del nodo');
    });

    /*
     * En un rombo el lado está mucho más adentro que la esquina de su caja. Si
     * el punto se calculara con la mitad del ancho quedaría flotando en el aire,
     * despegado de la silueta.
     */
    it('en el rombo se apoyan en la silueta, no en la caja', () => {
      const rombo = puntoDe(nodo('decision'), 'derecha');
      const rect = puntoDe(nodo('proceso'), 'derecha');

      // Por el lado derecho el vértice del rombo llega igual de lejos que el
      // lado del rectángulo: los dos puntos coinciden.
      expect(cerca(rombo.x, rect.x)).toBe(true, `${rombo.x} vs ${rect.x}`);
      // Pero por arriba el rombo es un vértice, no un lado plano.
      expect(cerca(puntoDe(nodo('decision'), 'arriba').y, -(20 + SEPARACION_PUNTO))).toBe(true);
    });

    it('el enganche solo despierta si el ratón está a tiro', () => {
      const e: Esquema = { nodos: [{ ...nodo(), id: 'a' }], conexiones: [] };
      const p = puntoDe(e.nodos[0], 'derecha');

      expect(engancheEn(e, ['a'], p, 20)).toEqual({ nodo: 'a', dir: 'derecha' });
      expect(engancheEn(e, ['a'], { x: p.x + 60, y: p.y }, 20)).toBeUndefined();
      // Y no mira nodos que no se le pasan.
      expect(engancheEn(e, [], p, 20)).toBeUndefined();
    });

    it('el fantasma no se solapa con el nodo del que sale', () => {
      const origen = nodo();
      const f = nodoFantasma(origen, 'derecha', 'Paso');

      const bordeOrigen = origen.x + origen.ancho / 2;
      const bordeFantasma = f.x - f.ancho / 2;
      expect(bordeFantasma).toBeGreaterThan(bordeOrigen, 'queda hueco entre los dos');
      expect(f.forma).toBe(origen.forma, 'hereda la forma');
    });

    it('brotar añade el nodo y lo deja enlazado desde el origen', () => {
      const e: Esquema = { nodos: [{ ...nodo(), id: 'a' }], conexiones: [] };

      const r = brotar(e, 'a', 'abajo', 'Paso');
      expect(r).toBeDefined();
      expect(r!.esquema.nodos.length).toBe(2);
      expect(r!.esquema.conexiones.length).toBe(1);
      expect(r!.esquema.conexiones[0].desde).toBe('a');
      expect(r!.esquema.conexiones[0].hasta).toBe(r!.nuevo.id);
      // Hacia abajo: en pantalla la `y` crece hacia abajo.
      expect(r!.nuevo.y).toBeGreaterThan(0);
    });

    it('lo que promete el fantasma es lo que se crea', () => {
      const e: Esquema = { nodos: [{ ...nodo(), id: 'a' }], conexiones: [] };
      const prometido = nodoFantasma(e.nodos[0], 'derecha', 'Paso');

      const real = brotar(e, 'a', 'derecha', 'Paso')!.nuevo;

      // Mismo sitio y mismo tamaño; solo cambia el id, que el fantasma no tiene.
      expect({ ...real, id: '' }).toEqual(prometido);
    });

    it('brotar de un nodo que no existe no hace nada', () => {
      expect(brotar({ nodos: [], conexiones: [] }, 'fantasma', 'arriba', 'x')).toBeUndefined();
    });
  });

  describe('enlazar con uno que ya está', () => {
    /** Dos nodos de 100 de ancho, con `hueco` entre sus caras. */
    const par = (hueco: number, desvioY = 0): Esquema => ({
      nodos: [
        { ...nodo(), id: 'a', x: 0, y: 0 },
        { ...nodo(), id: 'b', x: 100 + hueco, y: desvioY },
      ],
      conexiones: [],
    });

    it('encuentra al vecino que está a tiro', () => {
      expect(vecinoEn(par(60), 'a', 'derecha')?.id).toBe('b');
    });

    /*
     * El límite se mide de CARA A CARA, que es lo que se ve como separación —
     * de centro a centro dependería además del ancho de los nodos.
     */
    it('deja de verlo justo pasado el alcance', () => {
      expect(vecinoEn(par(ALCANCE_ENLACE - 1), 'a', 'derecha')?.id).toBe('b');
      expect(vecinoEn(par(ALCANCE_ENLACE + 1), 'a', 'derecha')).toBeUndefined();
    });

    it('solo mira en la dirección del punto', () => {
      const e = par(60);
      expect(vecinoEn(e, 'a', 'derecha')?.id).toBe('b');
      // Está a la derecha, así que por arriba, abajo o la izquierda no hay nadie.
      expect(vecinoEn(e, 'a', 'izquierda')).toBeUndefined();
      expect(vecinoEn(e, 'a', 'arriba')).toBeUndefined();
      // Y desde «b», «a» sí está a su izquierda.
      expect(vecinoEn(e, 'b', 'izquierda')?.id).toBe('a');
    });

    it('tiene que estar enfrente, no de refilón', () => {
      // Los nodos miden 40 de alto: con 25 de desvío aún se cruzan.
      expect(vecinoEn(par(60, 25), 'a', 'derecha')?.id).toBe('b');
      // Desplazado 200 ya no está «en esa dirección».
      expect(vecinoEn(par(60, 200), 'a', 'derecha')).toBeUndefined();
    });

    it('elige el más cercano cuando hay varios a tiro', () => {
      // Los tres miden 100 de ancho, así que los huecos son 40 y 90: los dos
      // dentro del alcance, para que la prueba sea de cuál gana y no de cuál
      // llega.
      const e: Esquema = {
        nodos: [
          { ...nodo(), id: 'a', x: 0 },
          { ...nodo(), id: 'otro', x: 190 },
          { ...nodo(), id: 'cerca', x: 140 },
        ],
        conexiones: [],
      };

      expect(vecinoEn(e, 'a', 'derecha')?.id).toBe('cerca');
    });

    /*
     * Si no se descartara, `conectar` rechazaría el duplicado y el clic se
     * quedaría sin hacer nada, que es lo peor que puede pasarle a un botón.
     */
    it('ignora al que ya está enlazado desde el origen', () => {
      const e = conectar(par(60), 'a', 'b');

      expect(vecinoEn(e, 'a', 'derecha')).toBeUndefined();
      // Pero al revés no: a→b y b→a son dos flechas distintas.
      expect(vecinoEn(e, 'b', 'izquierda')?.id).toBe('a');
    });

    it('brotar cerca solo traza la flecha; lejos crea el nodo', () => {
      const cerca = brotar(par(60), 'a', 'derecha', 'Paso')!;
      expect(cerca.creado).toBe(false);
      expect(cerca.esquema.nodos.length).toBe(2, 'no nace ninguno');
      expect(cerca.esquema.conexiones.length).toBe(1);
      expect(cerca.nuevo.id).toBe('b', 'el destino es el que ya estaba');

      const lejos = brotar(par(ALCANCE_ENLACE + 50), 'a', 'derecha', 'Paso')!;
      expect(lejos.creado).toBe(true);
      expect(lejos.esquema.nodos.length).toBe(3);
      expect(lejos.esquema.conexiones.length).toBe(1);
    });
  });

  /*
   * El contenido de una nota puede venir de otro equipo con otra versión, de un
   * merge de git resuelto a mano o de alguien que abrió el JSON con un editor.
   * Nada de eso puede tumbar el editor.
   */
  describe('normalizar', () => {
    it('aguanta lo que le echen', () => {
      expect(normalizar(null)).toEqual({ nodos: [], conexiones: [] });
      expect(normalizar('vaya')).toEqual({ nodos: [], conexiones: [] });
      expect(normalizar({ nodos: 'no es una lista' })).toEqual({ nodos: [], conexiones: [] });
    });

    it('descarta nodos sin id y repone las coordenadas rotas', () => {
      const e = normalizar({
        nodos: [
          { texto: 'sin id' },
          { id: 'a', x: null, y: 'ocho', texto: 'Hola', forma: 'inventada' },
        ],
        conexiones: [],
      });

      expect(e.nodos.length).toBe(1);
      expect(e.nodos[0]).toEqual(jasmine.objectContaining({ id: 'a', x: 0, y: 0, forma: 'proceso' }));
    });

    it('tira las conexiones que apuntan a un nodo que ya no existe', () => {
      const e = normalizar({
        nodos: [{ id: 'a', x: 0, y: 0, texto: 'A' }],
        conexiones: [
          { id: 'c1', desde: 'a', hasta: 'fantasma', texto: '' },
          { id: 'c2', desde: 'a', hasta: 'a', texto: '' },
        ],
      });

      expect(e.conexiones.map((c) => c.id)).toEqual(['c2']);
    });
  });
});
