import { escalon, TAMANO_BASE, TAMANO_MAXIMO, TAMANO_MINIMO, TAMANOS, UNIDAD } from './tamano-texto';

describe('tamano-texto · escalon', () => {
  it('sube y baja por la escala del desplegable', () => {
    // Los botones - y + no suman de uno en uno: van por los mismos tamaños que
    // ofrece la lista, así que los dos controles hablan de lo mismo.
    expect(escalon(12, 1)).toBe(14);
    expect(escalon(14, -1)).toBe(12);
    expect(escalon(24, 1)).toBe(30);
  });

  it('se queda quieto en los extremos', () => {
    expect(escalon(TAMANO_MINIMO, -1)).toBe(TAMANO_MINIMO);
    expect(escalon(TAMANO_MAXIMO, 1)).toBe(TAMANO_MAXIMO);
  });

  it('un tamaño de fuera de la escala cae en el escalón contiguo', () => {
    /* Puede llegar pegado desde otra aplicación. Sin esto se quedaría atascado:
       ningún botón sabría a qué escalón llevarlo. */
    expect(escalon(13, 1)).toBe(14);
    expect(escalon(13, -1)).toBe(12);
    expect(escalon(100, -1)).toBe(TAMANO_MAXIMO);
    expect(escalon(2, 1)).toBe(TAMANO_MINIMO);
  });

  it('la escala está ordenada', () => {
    // `escalon` busca el primero mayor (o el último menor): con la lista
    // desordenada devolvería cualquier cosa.
    const ordenada = [...TAMANOS].sort((a, b) => a - b);
    expect([...TAMANOS]).toEqual(ordenada);
  });

  /**
   * La unidad es lo que hace que el «12» de aquí se lea como el «12» de Google
   * Docs. En píxeles ese mismo 12 sale diminuto, que fue justo lo que pasó al
   * implementarlo la primera vez.
   */
  it('mide en puntos, como los procesadores de texto', () => {
    expect(UNIDAD).toBe('pt');

    // 1pt = 1/72", 1px = 1/96" → el tamaño de base son los 16 px de siempre.
    const enPx = (TAMANO_BASE * 96) / 72;
    expect(enPx).toBe(16);
  });
});
