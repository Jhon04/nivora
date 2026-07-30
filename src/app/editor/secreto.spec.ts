import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';

import { AlmacenSecreto, Secreto } from './secreto';
import { EVENTO_SECRETO_ABIERTO, EVENTO_SECRETO_ABRIR } from './slash-command';

const CIFRADO = 'v1.loQueSeaEnBase64';

/** Monta un editor con un único bloque secreto y devuelve su NodeView. */
function montar(almacen: AlmacenSecreto): { editor: Editor; bloque: HTMLElement } {
  const host = document.createElement('div');
  document.body.appendChild(host);

  const editor = new Editor({
    element: host,
    extensions: [StarterKit, Secreto],
    content: {
      type: 'doc',
      content: [{ type: 'secreto', attrs: { etiqueta: 'BD de producción', datos: CIFRADO } }],
    },
  });
  (editor.storage as unknown as Record<string, AlmacenSecreto>)['secreto'] = almacen;

  const bloque = host.querySelector<HTMLElement>('.bloque-secreto');
  if (!bloque) throw new Error('el bloque secreto no se pintó');
  return { editor, bloque };
}

const campo = (b: HTMLElement) => b.querySelector<HTMLElement>('.secreto-campo')!;
const valor = (b: HTMLElement) => b.querySelector('.secreto-valor')?.textContent;
const nota = (b: HTMLElement) => b.querySelector('.secreto-nota')?.textContent?.trim();
const pulsar = (b: HTMLElement, titulo: string) =>
  b.querySelector<HTMLButtonElement>(`button[title="${titulo}"]`)?.click();

describe('bloque secreto', () => {
  let editor: Editor | undefined;

  afterEach(() => {
    editor?.destroy();
    editor = undefined;
    document.querySelectorAll('.ProseMirror').forEach((e) => e.parentElement?.remove());
  });

  it('los estilos le llegan de verdad', () => {
    const m = montar({ descifrar: () => Promise.resolve('x') });
    editor = m.editor;

    /*
     * El NodeView crea su DOM con `document.createElement`, así que sus
     * elementos NO llevan el atributo `[_ngcontent-…]` que Angular sella en cada
     * selector de un estilo de componente. Mientras estas reglas vivieron en
     * `editor/editor.scss` no alcanzaban a nada y el bloque se veía como texto
     * pelado con tres botones. Tienen que estar en `src/styles.scss`.
     */
    const css = getComputedStyle(campo(m.bloque));
    expect(css.borderTopStyle).toBe('solid', 'el recuadro');
    expect(css.borderRadius).not.toBe('0px');
    // Borde parejo por los cuatro lados.
    expect([css.borderTopWidth, css.borderRightWidth, css.borderBottomWidth, css.borderLeftWidth])
      .toEqual(['1px', '1px', '1px', '1px']);

    // El rótulo va montado sobre el borde y necesita fondo propio para taparlo:
    // sin él, la línea le cruzaría el texto por la mitad.
    const rotulo = getComputedStyle(m.bloque.querySelector('.secreto-etiqueta')!);
    expect(rotulo.position).toBe('absolute');
    expect(rotulo.fontSize).toBe('13px');
    expect(rotulo.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
  });

  it('nace tapado y sin delatar la longitud del valor', () => {
    const m = montar({ descifrar: () => Promise.resolve('correo-caballo-grapa-larguísimo') });
    editor = m.editor;

    expect(m.bloque.dataset['estado']).toBe('oculto');
    // La máscara es fija: contar puntos no puede decir cuánto mide la clave.
    expect(valor(m.bloque)).toBe('••••••••••');
    expect(m.bloque.querySelector('.secreto-etiqueta')?.textContent).toBe('BD de producción');
  });

  it('revela el valor y lo vuelve a tapar al pulsar otra vez', async () => {
    const m = montar({ descifrar: () => Promise.resolve('hunter2-de-verdad') });
    editor = m.editor;

    pulsar(m.bloque, 'Mostrar');
    await Promise.resolve();
    await Promise.resolve();

    expect(m.bloque.dataset['estado']).toBe('visible');
    expect(valor(m.bloque)).toBe('hunter2-de-verdad');
    // La barra de cuenta atrás solo existe mientras se ve.
    expect(m.bloque.querySelector('.secreto-barra')).not.toBeNull();

    pulsar(m.bloque, 'Ocultar');
    expect(m.bloque.dataset['estado']).toBe('oculto');
    expect(valor(m.bloque)).toBe('••••••••••');
    expect(m.bloque.querySelector('.secreto-barra')).toBeNull();
  });

  it('con la clave cerrada ofrece desbloquear en vez de un error', async () => {
    const m = montar({
      descifrar: () => Promise.reject(new Error('los secretos están bloqueados')),
      desbloqueado: () => false,
    });
    editor = m.editor;

    pulsar(m.bloque, 'Mostrar');
    await Promise.resolve();
    await Promise.resolve();

    expect(m.bloque.dataset['estado']).toBe('bloqueado');
    expect(m.bloque.querySelector('.secreto-abrir')).not.toBeNull();
    expect(valor(m.bloque)).toBe('••••••••••', 'no se destapa nada al fallar');
  });

  it('el botón de desbloquear pide ayuda al componente', () => {
    const m = montar({
      descifrar: () => Promise.reject(new Error('cerrado')),
      desbloqueado: () => false,
    });
    editor = m.editor;

    let pedido = 0;
    m.editor.view.dom.addEventListener(EVENTO_SECRETO_ABRIR, () => pedido++);
    m.bloque.querySelector<HTMLButtonElement>('.secreto-abrir')?.click();

    expect(pedido).toBe(1);
  });

  it('vuelve solo a su sitio cuando la bóveda se desbloquea', async () => {
    const m = montar({
      descifrar: () => Promise.reject(new Error('cerrado')),
      desbloqueado: () => false,
    });
    editor = m.editor;

    pulsar(m.bloque, 'Mostrar');
    await Promise.resolve();
    await Promise.resolve();
    expect(m.bloque.dataset['estado']).toBe('bloqueado');

    // Lo que emite `editor.ts` tras abrir el candado: ningún bloque debe
    // quedarse diciendo «Bloqueado» hasta que lo toquen.
    m.editor.view.dom.dispatchEvent(new CustomEvent(EVENTO_SECRETO_ABIERTO, { bubbles: true }));

    expect(m.bloque.dataset['estado']).toBe('oculto');
  });

  it('un fallo que no es el candado se cuenta tal cual', async () => {
    const m = montar({
      descifrar: () => Promise.reject(new Error('ya no tienes acceso al repositorio')),
      desbloqueado: () => true,
    });
    editor = m.editor;

    pulsar(m.bloque, 'Mostrar');
    await Promise.resolve();
    await Promise.resolve();

    expect(m.bloque.dataset['estado']).toBe('error');
    expect(nota(m.bloque)).toBe('ya no tienes acceso al repositorio');
    expect(m.bloque.querySelector('.secreto-abrir')).not.toBeNull();
  });

  it('copiar no enseña el valor', async () => {
    let copiado = '';
    spyOn(navigator.clipboard, 'writeText').and.callFake((t: string) => {
      copiado = t;
      return Promise.resolve();
    });
    const m = montar({ descifrar: () => Promise.resolve('secreto-que-no-se-ve') });
    editor = m.editor;

    pulsar(m.bloque, 'Copiar');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(copiado).toBe('secreto-que-no-se-ve');
    expect(valor(m.bloque)).toBe('••••••••••');
    expect(m.bloque.dataset['estado']).toBe('oculto');
  });

  it('el valor en claro nunca entra en el documento', async () => {
    const m = montar({ descifrar: () => Promise.resolve('jdbc://usuario:clave@host') });
    editor = m.editor;

    pulsar(m.bloque, 'Mostrar');
    await Promise.resolve();
    await Promise.resolve();
    expect(valor(m.bloque)).toBe('jdbc://usuario:clave@host');

    // Esto es lo que el autoguardado escribiría en disco y en un commit.
    expect(JSON.stringify(m.editor.getJSON())).not.toContain('jdbc://');
  });
});
