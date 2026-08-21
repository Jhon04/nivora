import {
  CONEXIONES,
  CONEXION_POR_DEFECTO,
  conexionDe,
  conexionesDe,
  marcaDe,
  previsualizar,
} from './catalogo-conexiones';
import { FAMILIAS } from './catalogo';

/** Marca puesta en (100, 0) con la línea llegando desde la izquierda. */
const enPunta = (tipo: Parameters<typeof marcaDe>[0]) =>
  marcaDe(tipo, { x: 100, y: 0 }, { x: 1, y: 0 });

describe('catálogo de conexiones', () => {
  it('todos los tipos tienen id único y familia conocida', () => {
    const ids = CONEXIONES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length, 'hay ids repetidos');

    const familias = new Set(FAMILIAS.map((f) => f.id));
    for (const c of CONEXIONES) {
      expect(familias.has(c.familia)).toBe(true, `${c.id} tiene familia ${c.familia}`);
    }
  });

  it('las cuatro familias traen tipos', () => {
    for (const f of FAMILIAS) {
      expect(conexionesDe(f.id).length).toBeGreaterThan(0, `${f.id} está vacía`);
    }
  });

  /*
   * Un tipo desconocido llega desde notas de antes de que esto existiera (sin
   * `tipo`) y desde versiones más nuevas. Perder el adorno es aceptable; que
   * la conexión no se dibuje, no.
   */
  it('un tipo desconocido cae a la flecha simple', () => {
    expect(conexionDe(undefined).id).toBe(CONEXION_POR_DEFECTO);
    expect(conexionDe('inventado').id).toBe(CONEXION_POR_DEFECTO);
    expect(conexionDe('erd-1-n').id).toBe('erd-1-n');
  });

  describe('marcas', () => {
    it('«nada» no dibuja nada', () => {
      expect(enPunta('nada')).toEqual([]);
    });

    it('la flecha es un triángulo relleno y el de herencia va hueco', () => {
      const flecha = enPunta('flecha');
      expect(flecha.length).toBe(1);
      expect(flecha[0].relleno).toBe('tinta');

      // Relleno del color del fondo: es lo que lo hace hueco y de paso le tapa
      // la línea por debajo.
      expect(enPunta('triangulo')[0].relleno).toBe('fondo');
    });

    it('el rombo de composición se rellena y el de agregación no', () => {
      expect(enPunta('rombo')[0].relleno).toBe('fondo');
      expect(enPunta('rombo-relleno')[0].relleno).toBe('tinta');
    });

    it('la pata de gallo son tres trazos que se abren hacia el nodo', () => {
      const muchos = enPunta('muchos');
      expect(muchos.length).toBe(3);
      expect(muchos.every((m) => m.relleno === 'ninguno')).toBe(true);
    });

    it('«cero o muchos» añade el círculo a la pata de gallo', () => {
      expect(enPunta('cero-muchos').length).toBe(enPunta('muchos').length + 1);
    });

    /*
     * Todo se dibuja hacia dentro desde la punta: si algo se saliera, las marcas
     * asomarían por encima del nodo en vez de apoyarse en su borde.
     */
    it('ninguna marca se sale por delante de la punta', () => {
      for (const tipo of ['flecha', 'triangulo', 'rombo', 'muchos', 'cero-uno'] as const) {
        for (const t of enPunta(tipo)) {
          const xs = [...t.d.matchAll(/-?\d+(\.\d+)?\s/g)].map((m) => parseFloat(m[0]));
          expect(Math.max(...xs)).toBeLessThanOrEqual(100.01, `${tipo} se sale`);
        }
      }
    });

    it('la marca gira con la línea', () => {
      const derecha = marcaDe('flecha', { x: 0, y: 0 }, { x: 1, y: 0 });
      const abajo = marcaDe('flecha', { x: 0, y: 0 }, { x: 0, y: 1 });

      expect(derecha[0].d).not.toBe(abajo[0].d);
    });
  });

  it('la miniatura trae línea y las marcas de los dos extremos', () => {
    const previa = previsualizar(conexionDe('erd-n-n'));

    expect(previa.linea.length).toBeGreaterThan(5);
    // Pata de gallo a cada lado: tres trazos por extremo.
    expect(previa.marcas.length).toBe(6);
  });

  it('todos los tipos generan una miniatura pintable', () => {
    for (const c of CONEXIONES) {
      const previa = previsualizar(c);
      expect(previa.linea).toContain('M');
      for (const m of previa.marcas) {
        expect(m.d.length).toBeGreaterThan(4, `${c.id} tiene una marca vacía`);
      }
    }
  });
});
