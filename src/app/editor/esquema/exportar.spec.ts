import { Esquema } from './modelo';
import { exportarEsquema, svgDeEsquema } from './exportar';

const CON_TABLA: Esquema = {
  nodos: [
    {
      id: 't',
      x: 160,
      y: 120,
      ancho: 180,
      alto: 96,
      texto: 'factura',
      forma: 'erd-tabla',
      columnas: [
        { nombre: 'id', tipo: 'int', pk: true },
        { nombre: 'cliente_id', tipo: 'int', fk: true },
      ],
    },
    { id: 'p', x: 420, y: 120, ancho: 100, alto: 44, texto: 'Cobrar', forma: 'proceso' },
  ],
  conexiones: [{ id: 'c', desde: 't', hasta: 'p', texto: 'paga', tipo: 'uno-a-muchos' }],
};

/** Luminancia aproximada de un `rgb(...)`, para saber si un color es claro. */
function claridad(color: string): number {
  const [r, g, b] = (color.match(/[\d.]+/g) ?? ['0', '0', '0']).map(Number);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

describe('exportar un esquema', () => {
  describe('SVG', () => {
    let svg: string;

    beforeAll(async () => {
      svg = await svgDeEsquema(CON_TABLA);
    });

    /* El SVG de la app no lleva ni un color: todo va por `currentColor` y por
       tokens que resuelve `styles.scss`, que es lo que hace que cambie de tema
       sin repintarse. Fuera de la app no hay quien resuelva eso, así que si algo
       de esto sobrevive, el fichero se abre sin color en cualquier otro programa. */
    it('no se lleva fuera ni un color sin resolver', () => {
      expect(svg).not.toContain('currentColor');
      expect(svg).not.toContain('var(--');
      expect(svg).not.toContain('color-mix');
      expect(svg).not.toContain('light-dark');
    });

    /*
     * El fallo que puso la cabecera de las tablas en negro.
     *
     * La banda del título sale de un `color-mix`, y su valor CALCULADO se
     * serializa como `color(srgb 0.1 0.1 0.12 / 0.09)`. Es CSS válido —el test
     * de arriba lo daba por bueno porque ya no queda ningún `color-mix` en el
     * texto— pero muchos visores no saben leerlo, y en SVG un `fill` que no se
     * parsea **no se ignora: cae al valor inicial, que es negro opaco**. La
     * cabecera salía negra con el nombre encima en un gris azulado, ilegible.
     *
     * Se comprueba TODO color del fichero y no solo el de la banda: cualquier
     * `oklch` o `lab` que entre mañana por el CSS caería en lo mismo, y es
     * mejor que salte aquí que en el fichero de alguien.
     */
    it('todos los colores salen en sintaxis que entiende cualquier visor', () => {
      const sinFuentes = svg.replace(/<style>[\s\S]*?<\/style>/g, '');
      const colores = [...sinFuentes.matchAll(/(?:fill|stroke)\s*[:=]\s*"?([^;"'>]+)/g)].map(
        (m) => m[1].trim(),
      );

      expect(colores.length).toBeGreaterThan(5, 'sin colores que mirar, el test no vale');
      for (const c of colores) {
        expect(c).toMatch(/^(#[0-9a-f]{3,8}|rgb\(|none$)/i, `color que un visor puede no entender: ${c}`);
      }
    });

    /* El alfa va en `fill-opacity` y no dentro de un `rgba()`: aquel es SVG 1.1
       pelado, y este necesita que el visor traiga soporte de color de CSS. */
    it('la banda del título conserva su transparencia, fuera del color', () => {
      const banda = svg.match(/class="esq-banda"[^>]*style="([^"]*)"/)?.[1] ?? '';

      expect(banda).toMatch(/fill:rgb\(/);
      const alfa = parseFloat(banda.match(/fill-opacity:([\d.]+)/)?.[1] ?? '1');
      expect(alfa).toBeGreaterThan(0, 'sin alfa la banda taparía el nombre');
      expect(alfa).toBeLessThan(0.5, 'es un tinte, no una franja opaca');
    });

    it('el aspecto viaja en línea, no en clases', () => {
      // La silueta con relleno y borde de verdad, no heredados de una hoja que
      // no va a existir.
      expect(svg).toMatch(/class="esq-forma"[^>]*style="[^"]*fill:rgb/);
      expect(svg).toMatch(/class="esq-forma"[^>]*style="[^"]*stroke:rgb/);
    });

    /* El rombo de clave foránea es hueco y la llave de primaria es maciza: esa es
       toda la diferencia entre los dos. Un `fill: none` que no se copiara los
       volvería iguales. */
    it('el rombo de clave foránea sigue hueco', () => {
      const rombo = svg.match(/class="esq-foranea"[^>]*style="([^"]*)"/)?.[1] ?? '';
      expect(rombo).toContain('fill:none');
      expect(rombo).toMatch(/stroke:rgb/);

      const llave = svg.match(/class="esq-llave"[^>]*style="([^"]*)"/)?.[1] ?? '';
      expect(llave).toMatch(/fill:rgb/);
    });

    it('lleva la fuente incrustada, y solo los pesos que usa', () => {
      const caras = svg.match(/@font-face/g) ?? [];
      expect(caras.length).toBeGreaterThan(0, 'sin fuente el texto se sale de las cajas');
      expect(svg).toContain('data:font/woff2;base64,');
      // 400 (columnas y tipos), 500 (nombres de nodo) y 700 (la clave primaria).
      // Ni rastro del 300, que en un esquema no lo usa nadie.
      expect(svg).not.toContain('font-weight:300;');
    });

    it('lleva fondo propio y no sale transparente', () => {
      expect(svg).toMatch(/<rect[^>]*fill="rgb/);
    });

    /* Los tiradores son los trazos gordos e invisibles que hay bajo cada flecha
       para poder acertarle con el ratón. En un fichero solo son peso. */
    it('deja fuera los tiradores del ratón', () => {
      expect(svg).not.toContain('esq-tirador');
    });

    it('se puede volver a leer como XML', () => {
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
      expect(doc.querySelector('parsererror')).toBeNull();
      expect(doc.documentElement.tagName).toBe('svg');
      expect(doc.documentElement.getAttribute('width')).toBeTruthy();
    });
  });

  /* Quien exporta lo hace para meter el diagrama en otro sitio, y ese otro sitio
     casi siempre tiene el papel blanco. Un esquema en oscuro pegado ahí queda
     ilegible, así que la exportación no sigue al tema de la app. */
  it('sale en claro aunque la app esté en oscuro', async () => {
    const raiz = document.documentElement;
    const antes = raiz.getAttribute('data-tema');
    raiz.setAttribute('data-tema', 'oscuro');

    try {
      const svg = await svgDeEsquema(CON_TABLA);
      const fondo = svg.match(/<rect[^>]*fill="([^"]*)"/)?.[1] ?? '';
      expect(claridad(fondo)).toBeGreaterThan(0.6, `el fondo salió oscuro: ${fondo}`);

      const texto = svg.match(/class="esq-texto"[^>]*>\s*<text[^>]*style="([^"]*)"/)?.[1] ?? svg;
      const tinta = texto.match(/fill:(rgb[^;"]*)/)?.[1] ?? '';
      expect(claridad(tinta)).toBeLessThan(0.4, `la tinta salió clara: ${tinta}`);
    } finally {
      if (antes === null) raiz.removeAttribute('data-tema');
      else raiz.setAttribute('data-tema', antes);
    }
  });

  describe('PNG', () => {
    it('sale un PNG con dibujo dentro, no un lienzo en blanco', async () => {
      const blob = await exportarEsquema(CON_TABLA, 'png');
      expect(blob.type).toBe('image/png');

      const img = new Image();
      img.src = URL.createObjectURL(blob);
      await img.decode();
      // Un SVG sin medidas explícitas se rasteriza a 0×0 en WebKit; con ellas,
      // la imagen tiene el tamaño del dibujo por la escala.
      expect(img.naturalWidth).toBeGreaterThan(100);

      const lienzo = document.createElement('canvas');
      lienzo.width = img.naturalWidth;
      lienzo.height = img.naturalHeight;
      lienzo.getContext('2d')!.drawImage(img, 0, 0);
      const px = lienzo.getContext('2d')!.getImageData(0, 0, lienzo.width, lienzo.height).data;

      const distintos = new Set<string>();
      for (let i = 0; i < px.length; i += 4) distintos.add(`${px[i]},${px[i + 1]},${px[i + 2]}`);
      expect(distintos.size).toBeGreaterThan(2, 'el PNG salió liso: no se pintó nada');

      URL.revokeObjectURL(img.src);
    });
  });

  it('un esquema vacío no revienta la exportación', async () => {
    const svg = await svgDeEsquema({ nodos: [], conexiones: [] });
    expect(svg).toContain('<svg');
  });
});
