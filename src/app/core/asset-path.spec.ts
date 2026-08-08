import { PREFIJO_ICONO, setBaseAssets, srcIcono } from './asset-path';

/** Lo que le llega a Tauri para convertir en URL del webview. */
let pedido: string | null;

describe('srcIcono (icono de nota: emoji o imagen)', () => {
  beforeEach(() => {
    setBaseAssets('/datos/Workspace/assets');
    /* `convertFileSrc` vive en el runtime de Tauri, que fuera de la app no
       existe. Se simula para poder ver con qué ruta se le llama, que es
       justo lo que interesa comprobar aquí. */
    pedido = null;
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {
      convertFileSrc: (ruta: string) => {
        pedido = ruta;
        return `asset://localhost/${encodeURIComponent(ruta)}`;
      },
    };
  });

  afterEach(() => {
    setBaseAssets('');
    delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
  });

  it('un emoji no es una imagen', () => {
    // Es lo que decide entre pintar un <img> y pintar texto.
    expect(srcIcono('🚀')).toBeNull();
    expect(srcIcono('📄')).toBeNull();
  });

  it('sin icono, tampoco', () => {
    expect(srcIcono(null)).toBeNull();
    expect(srcIcono(undefined)).toBeNull();
    expect(srcIcono('')).toBeNull();
  });

  it('con el prefijo, resuelve contra la carpeta de assets de la bóveda', () => {
    const src = srcIcono(`${PREFIJO_ICONO}a1b2c3.png`);

    expect(src).toBeTruthy();
    /* El documento guarda solo el nombre relativo; la carpeta se pone al
       mostrar. Eso es lo que hace el workspace portable entre equipos, y lo que
       obliga a que el icono se resuelva contra la bóveda ACTIVA (cada una tiene
       su propio assets/). */
    expect(pedido).toBe('/datos/Workspace/assets/a1b2c3.png');
  });

  it('un texto que empieza por el prefijo pero sin nombre no rompe', () => {
    expect(srcIcono(PREFIJO_ICONO)).toBe('');
  });

  it('el prefijo no colisiona con ningún emoji', () => {
    // La marca es ASCII y los emojis no lo son: por eso un solo campo `icono`
    // puede transportar las dos cosas sin ambigüedad ni columna nueva.
    expect(PREFIJO_ICONO).toMatch(/^[a-z:]+$/);
  });
});
