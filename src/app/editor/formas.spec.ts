import {
  ENCAJE_ID,
  Encaje,
  aplicarEncaje,
  caja,
  cajaFondo,
  componer,
  crearForma,
  crearTexto,
  dibujar,
  encajeDeGiro,
  esMinima,
  Forma,
  formaEn,
  grosorPara,
  invertir,
  rehacerTexto,
  mover,
  puntosCabeza,
  recorteValido,
  tamTextoPara,
  tocaTrazo,
  transformar,
} from './formas';

/** Atajo para crear formas en los tests. */
function forma(tipo: Forma['tipo'], x1: number, y1: number, x2: number, y2: number): Forma {
  return crearForma(tipo, { x: x1, y: y1 }, { x: x2, y: y2 }, '#ff3b30', 4);
}

/** Canvas de 100×100 con la forma ya pintada, para mirarle los píxeles. */
function pintar(f: Forma): CanvasRenderingContext2D {
  const canvas = document.createElement('canvas');
  canvas.width = 100;
  canvas.height = 100;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('sin canvas 2d');
  dibujar(ctx, f);
  return ctx;
}

/** Componentes RGBA del píxel. */
function pixel(ctx: CanvasRenderingContext2D, x: number, y: number): number[] {
  return Array.from(ctx.getImageData(x, y, 1, 1).data);
}

describe('formas', () => {
  it('normaliza la caja aunque se arrastre hacia arriba y a la izquierda', () => {
    // Gesto de (90,80) a (10,20): la caja resultante no puede tener lados negativos.
    expect(caja(forma('rect', 90, 80, 10, 20))).toEqual({ x: 10, y: 20, w: 80, h: 60 });
  });

  it('mueve los dos extremos a la vez', () => {
    const f = mover(forma('flecha', 10, 10, 30, 40), 5, -3);
    expect([f.x1, f.y1, f.x2, f.y2]).toEqual([15, 7, 35, 37]);
  });

  it('descarta el gesto que se queda en un clic', () => {
    expect(esMinima(forma('rect', 50, 50, 52, 51))).toBeTrue();
    expect(esMinima(forma('rect', 50, 50, 90, 90))).toBeFalse();
    // A una línea le basta con ser larga; no necesita las dos dimensiones.
    expect(esMinima(forma('linea', 10, 50, 60, 50))).toBeFalse();
  });

  it('el interior de una forma NO la agarra: queda libre para dibujar dentro', () => {
    const f = forma('rect', 10, 10, 90, 90);
    expect(tocaTrazo(f, { x: 10, y: 50 }, 4)).toBeTrue(); // sobre el borde
    expect(tocaTrazo(f, { x: 50, y: 50 }, 4)).toBeFalse(); // en el hueco
  });

  it('agarra el contorno del círculo, no su centro', () => {
    const f = forma('circulo', 0, 0, 100, 100); // radio 50 centrado en (50,50)
    expect(tocaTrazo(f, { x: 50, y: 1 }, 4)).toBeTrue();
    expect(tocaTrazo(f, { x: 50, y: 50 }, 4)).toBeFalse();
    // La zona sensible sigue al óvalo, no a su caja: la esquina queda fuera.
    expect(tocaTrazo(f, { x: 5, y: 5 }, 4)).toBeFalse();
  });

  it('agarra la línea solo dentro de su tramo', () => {
    const f = forma('linea', 20, 20, 80, 20);
    expect(tocaTrazo(f, { x: 50, y: 22 }, 4)).toBeTrue();
    expect(tocaTrazo(f, { x: 95, y: 20 }, 4)).toBeFalse(); // más allá del final
  });

  it('elige la forma de encima cuando dos se solapan', () => {
    const abajo = forma('linea', 0, 50, 100, 50);
    const arriba = forma('linea', 0, 50, 100, 50);
    expect(formaEn([abajo, arriba], { x: 50, y: 50 }, 4)).toBe(1);
    expect(formaEn([abajo, arriba], { x: 50, y: 90 }, 4)).toBe(-1);
  });

  it('pone la punta de la flecha en el extremo final', () => {
    const [a, punta, b] = puntosCabeza(forma('flecha', 0, 50, 100, 50));
    expect([punta.x, punta.y]).toEqual([100, 50]);
    // Los barbos quedan por detrás de la punta y a un lado y otro del trazo.
    expect(a.x).toBeLessThan(punta.x);
    expect(b.x).toBeLessThan(punta.x);
    expect(Math.sign(a.y - 50)).toBe(-Math.sign(b.y - 50));
  });

  it('escala el grosor con el lado corto de la imagen', () => {
    expect(grosorPara(1920, 1080)).toBe(6);
    expect(grosorPara(120, 90)).toBe(2); // nunca por debajo del mínimo
  });

  // Lo que pidió el usuario: formas de solo borde, sin fondo.
  it('dibuja el rectángulo hueco: el centro queda transparente', () => {
    const ctx = pintar(forma('rect', 10, 10, 90, 90));
    expect(pixel(ctx, 50, 50)[3]).toBe(0); // alfa 0 = no se pintó nada
    expect(pixel(ctx, 10, 50)).toEqual([255, 59, 48, 255]); // el trazo, opaco
  });

  it('dibuja el círculo hueco: el centro queda transparente', () => {
    const ctx = pintar(forma('circulo', 5, 5, 95, 95));
    expect(pixel(ctx, 50, 50)[3]).toBe(0);
    expect(pixel(ctx, 50, 5)[3]).toBeGreaterThan(0);
  });

  describe('texto', () => {
    it('se crea ya medido y anclado por la esquina superior izquierda', () => {
      const c = caja(crearTexto({ x: 10, y: 20 }, 'Hola', 24, '#ff3b30'));
      expect(c.x).toBe(10);
      expect(c.y).toBe(20);
      expect(c.w).toBeGreaterThan(20); // cuatro letras de 24px dan de sí
      expect(c.h).toBeGreaterThan(20); // ascenso + descenso de la fuente
    });

    it('sí se agarra por dentro, al contrario que las formas huecas', () => {
      const f = crearTexto({ x: 0, y: 0 }, 'Hola', 24, '#ffffff');
      const c = caja(f);
      expect(tocaTrazo(f, { x: c.w / 2, y: c.h / 2 }, 2)).toBeTrue();
      expect(tocaTrazo(f, { x: c.w + 60, y: c.h / 2 }, 2)).toBeFalse();
    });

    it('descarta un texto en blanco', () => {
      expect(esMinima(crearTexto({ x: 0, y: 0 }, '   ', 20, '#ffffff'))).toBeTrue();
      expect(esMinima(crearTexto({ x: 0, y: 0 }, 'ok', 20, '#ffffff'))).toBeFalse();
    });

    it('la pastilla envuelve al texto con algo de aire', () => {
      const f = crearTexto({ x: 30, y: 30 }, 'Hola', 24, '#ff3b30', true);
      const c = caja(f);
      const p = cajaFondo(f);
      expect(p.x).toBeLessThan(c.x);
      expect(p.w).toBeGreaterThan(c.w);
      expect(p.h).toBeGreaterThan(c.h);
    });

    it('cambiar el cuerpo de letra no mueve el texto de sitio', () => {
      const f = crearTexto({ x: 40, y: 40 }, 'Hola', 20, '#ffffff');
      const antes = caja(f);
      const grande = caja(rehacerTexto(f, { tam: 40 }));
      expect(grande.w).toBeGreaterThan(antes.w);
      // Crece hacia los dos lados: el centro se queda donde estaba.
      expect(grande.x + grande.w / 2).toBeCloseTo(antes.x + antes.w / 2, 6);
      expect(grande.y + grande.h / 2).toBeCloseTo(antes.y + antes.h / 2, 6);
    });

    // Lo que pidió el usuario: el texto sin fondo va limpio, sin contorno.
    it('sin pastilla no lleva ningún borde alrededor', () => {
      const ctx = pintar(crearTexto({ x: 4, y: 4 }, 'Hi', 40, '#ffffff'));
      const datos = ctx.getImageData(0, 0, 100, 100).data;
      let oscuros = 0;
      for (let i = 0; i < datos.length; i += 4) {
        // Píxel pintado pero oscuro = contorno; con letra blanca no debe haberlo.
        if (datos[i + 3] > 40 && datos[i] < 120) oscuros++;
      }
      expect(oscuros).toBe(0);
    });

    /* La pastilla es blanca SIEMPRE y la letra conserva el color elegido: la
       paleta es la del texto, y que pintara también el fondo despistaba. */
    it('con pastilla, el fondo va blanco y la letra mantiene su color', () => {
      const ctx = pintar(crearTexto({ x: 12, y: 12 }, 'Hi', 40, '#ff3b30', true));
      const datos = ctx.getImageData(0, 0, 100, 100).data;
      let rojos = 0;
      let blancos = 0;
      for (let i = 0; i < datos.length; i += 4) {
        if (datos[i + 3] < 200) continue;
        if (datos[i] > 200 && datos[i + 1] < 110 && datos[i + 2] < 100) rojos++;
        if (datos[i] > 240 && datos[i + 1] > 240 && datos[i + 2] > 240) blancos++;
      }
      expect(rojos).toBeGreaterThan(0); // la letra
      expect(blancos).toBeGreaterThan(rojos); // la pastilla, que ocupa más
    });

    it('escala el cuerpo de letra con el lado corto de la imagen', () => {
      expect(tamTextoPara(1920, 1080)).toBe(60);
      expect(tamTextoPara(160, 100)).toBe(12); // nunca por debajo del mínimo
    });

    it('pinta el texto con su color', () => {
      const ctx = pintar(crearTexto({ x: 4, y: 4 }, 'Hi', 40, '#ff3b30'));
      const datos = ctx.getImageData(0, 0, 100, 100).data;
      let rojos = 0;
      for (let i = 0; i < datos.length; i += 4) {
        if (datos[i] > 200 && datos[i + 1] < 110 && datos[i + 2] < 100 && datos[i + 3] > 200) {
          rojos++;
        }
      }
      expect(rojos).toBeGreaterThan(0);
    });
  });

  describe('encaje (recortes y giros de 90°)', () => {
    /** Encadena un giro sobre un encaje ya existente. */
    function girando(e: Encaje, sentido: 1 | -1, ancho: number, alto: number): Encaje {
      const g = encajeDeGiro(sentido, ancho, alto);
      return componer(e, g.k, { x: g.tx, y: g.ty });
    }

    it('a la derecha, la esquina de arriba a la izquierda va a la de arriba a la derecha', () => {
      // Imagen de 200×100: al girarla queda de 100×200.
      const e = encajeDeGiro(1, 200, 100);
      expect(aplicarEncaje(e, { x: 0, y: 0 })).toEqual({ x: 100, y: 0 });
      // Y la de arriba a la derecha baja a la de abajo a la derecha.
      expect(aplicarEncaje(e, { x: 200, y: 0 })).toEqual({ x: 100, y: 200 });
    });

    it('a la izquierda gira al revés', () => {
      const e = encajeDeGiro(-1, 200, 100);
      expect(aplicarEncaje(e, { x: 0, y: 0 })).toEqual({ x: 0, y: 200 });
    });

    it('girar a un lado y al otro deja las cosas como estaban', () => {
      let e = girando(ENCAJE_ID, 1, 200, 100); // 200×100 → 100×200
      e = girando(e, -1, 100, 200); // y de vuelta
      expect(e).toEqual(ENCAJE_ID);
    });

    it('deshace un recorte seguido de un giro', () => {
      // Recorte que quita 20 por la izquierda y 10 por arriba, y luego giro.
      let e = componer(ENCAJE_ID, 0, { x: -20, y: -10 });
      e = girando(e, 1, 180, 90);
      const p = { x: 35, y: 22 };
      const vuelta = aplicarEncaje(invertir(e), aplicarEncaje(e, p));
      expect(vuelta.x).toBeCloseTo(p.x, 6);
      expect(vuelta.y).toBeCloseTo(p.y, 6);
    });

    it('la flecha conserva la punta en su extremo al girar', () => {
      const e = encajeDeGiro(1, 300, 200);
      const f = forma('flecha', 10, 20, 90, 60);
      const girada = transformar(f, e);
      const punta = aplicarEncaje(e, { x: 90, y: 60 });
      expect(puntosCabeza(girada)[1]).toEqual(punta);
    });

    it('el texto se queda derecho al girar y conserva su tamaño', () => {
      const t = crearTexto({ x: 10, y: 20 }, 'Hola', 24, '#ffffff');
      const antes = caja(t);
      const despues = caja(transformar(t, encajeDeGiro(1, 300, 200)));
      // Si se hubiera girado con la imagen, ancho y alto habrían cambiado de sitio.
      expect(despues.w).toBeCloseTo(antes.w, 6);
      expect(despues.h).toBeCloseTo(antes.h, 6);
      // Y su centro sí acompaña al giro.
      const centro = aplicarEncaje(encajeDeGiro(1, 300, 200), {
        x: antes.x + antes.w / 2,
        y: antes.y + antes.h / 2,
      });
      expect(despues.x + despues.w / 2).toBeCloseTo(centro.x, 6);
      expect(despues.y + despues.h / 2).toBeCloseTo(centro.y, 6);
    });
  });

  it('no recorta con un clic suelto ni con una franja de un pelo', () => {
    expect(recorteValido({ x: 0, y: 0, w: 0, h: 0 })).toBeFalse();
    expect(recorteValido({ x: 0, y: 0, w: 5, h: 200 })).toBeFalse();
    expect(recorteValido({ x: 0, y: 0, w: 120, h: 80 })).toBeTrue();
  });
});
